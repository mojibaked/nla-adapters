# Drop `-p` Full-Parity Plan

## Goal

Make the Claude adapter match the Python SDK's persistent streaming model closely
enough to support:

- one long-lived Claude subprocess per adapter session
- multiple sequential user turns on the same subprocess
- control requests that can arrive between turns
- background/async tool events that continue after a `result`
- host-visible adapter-initiated turns when Claude emits new events while idle

## Non-Goal

This plan does **not** aim to force the current `@nla/sdk-core` request/response
adapter runtime to model unsolicited background session events. For full parity,
the Claude adapter will likely need to speak NLA JSONL directly instead of going
through `defineAdapter()` / `runAdapterStdio()`.

## Current Mismatch

- `claude-cli` still runs Claude with `-p`, which is print-and-exit mode.
  Source: `packages/claude-cli/src/runtime.ts`
- The adapter treats `result` as turn-terminal and clears `turnState`.
  Source: `packages/claude-cli/src/notifications.ts`, `packages/claude-cli/src/runtime.ts`
- Permission and question requests are rejected if they arrive without an active
  `turnState`.
  Source: `packages/claude-cli/src/runtime.ts`
- Host-core previously only routed turn traffic when it was attached to a
  request `correlationId`.
  Source: `nla/packages/host-core/src/session-client.ts`
- The current NLA adapter stdio runtime is request-scoped and does not provide a
  clean path for unsolicited session messages from background adapter state.
  Source: `nla/packages/sdk-core/src/index.ts`,
  `nla/packages/transport-stdio-jsonl/src/index.ts`

## Probable NLA Protocol Gap

This looks like a **session-turn semantics gap** in NLA, not a complete
wire-format failure.

Original gap:

- NLA already has session-level messages for `session.message`,
  `session.activity`, `session.interaction.requested`, `session.execution`, and
  `session.status`.
- The payloads that carry the actual turn content did **not** previously
  include `turnId`:
  - `NlaSessionMessageData`
  - `NlaSessionMessageDeltaData`
  - `NlaActivityData`
  - `NlaArtifactData`
  - `NlaSessionInteractionRequestedData`
  - `NlaSessionInteractionResolvedData`
- `session.execution` had an optional `turnId`, but the subsequent
  message/activity/interaction payloads do not, so the protocol does not
  clearly define how unsolicited provider-emitted events should be attached to a
  new turn while the session is otherwise idle.
- The current host-core implementation works by inferring turn ownership from
  request `correlationId`, which is fine for host-initiated request/response
  turns but does not cover provider-initiated turns.

Possible protocol-level fixes:

- Add optional `turnId` to all session-emitted content/event payloads.
- Define a formal provider-initiated turn rule, for example:
  - adapter emits `session.execution { state: "running", turnId }` while idle
  - adapter follows with turn-bound session messages carrying the same `turnId`
- If that still feels too implicit, add explicit adapter-bound turn lifecycle
  messages at the protocol level.

Working assumption for this plan:

- We patch NLA first, then adapt host-runtime and `claude-cli` against the new
  semantics.
- Before we call the system "full parity", we still need `claude-cli` to stop
  relying on the request-scoped `defineAdapter()` / `runAdapterStdio()` path for
  unsolicited post-`result` session traffic.

Patch status on 2026-04-18:

- [x] `@nla/protocol` now accepts optional `turnId` on:
      - `session.message`
      - `session.message.delta`
      - `session.activity`
      - `session.artifact`
      - `session.interaction.requested`
      - `session.interaction.resolved`
      - `session.status`
- [x] `@nla/host-core` now routes turn-bound session events by `turnId` when
      `correlationId` is absent.
- [x] `@nla/host-core` now exposes an `onUnsolicitedMessage` hook for session
      traffic that does not match an active turn.
- [x] NLA root tests cover both behaviors.
- [x] `host-runtime` now opens provider-initiated turns from unsolicited
      process-driver adapter events.
- [x] `claude-cli` now runs Claude without `-p`, keeps one child alive across
      sequential turns, sends SDK-shaped user frames, and treats clean child
      exit during an active turn as failure instead of success.

Current remaining gap:

- `claude-cli` still runs inside `defineAdapter()` / `runAdapterStdio()`, so it
  cannot emit new unsolicited NLA session events after a host turn has returned
  to idle. That is the remaining blocker for true Claude-originated
  post-`result` turns.

## Plan

### Phase 0: Protocol Spike

- [x] Verify the installed Claude CLI build works in persistent `stream-json`
      mode **without** `-p`.
- [x] Determine whether the SDK-style initialize handshake is required and
      document the exact request/response frames.
- [x] Confirm the exact user message envelope needed in persistent mode,
      including `session_id` and `parent_tool_use_id`.
- [x] Capture one real transcript showing:
      - startup
      - initialize
      - first user turn
      - `result`
      - second user turn
      - control request timing

Phase 0 notes:

- See `docs/non-print-protocol-spike.md`.
- On Claude Code `2.1.114`, persistent non-`-p` `stream-json` works.
- `initialize` is accepted and useful, but not strictly required for the
  simplest user-message flow.
- `set_permission_mode` works between turns on the same subprocess.

Acceptance criteria:

- [x] We have a reproducible transcript proving persistent mode works on the
      local Claude CLI version we actually ship against.

### Phase 1: Persistent Claude Session Transport

- [x] Remove `-p` from the Claude subprocess launch path.
- [x] Keep exactly one Claude child process per adapter session.
- [x] Add the SDK-style initialize handshake on child startup.
- [x] Send SDK-shaped user frames over stdin for every user turn.
- [x] Stop relying on child exit as the normal success path for a turn.

Scope:

- `packages/claude-cli/src/runtime.ts`
- possibly new helper files for low-level stream/control handling

Acceptance criteria:

- [x] A single Claude subprocess survives across at least two host user turns.
- [x] The adapter can send a second user turn without respawning Claude.

### Phase 2: Session-Scoped Control and Event Buffers

- [ ] Move permission requests off `turnState` and make them session-scoped.
- [ ] Move question requests off `turnState` and make them session-scoped.
- [ ] Replace the current turn-local event queue with a session-level queue or
      equivalent buffering model that survives `result`.
- [ ] Treat `result` as "current host turn completed" instead of "Claude stream
      is done".
- [ ] Keep consuming stdout and control traffic after `result`.

Scope:

- `packages/claude-cli/src/runtime.ts`
- `packages/claude-cli/src/notifications.ts`
- `packages/claude-cli/src/types.ts`
- `packages/claude-cli/src/permissionBridge.ts`

Acceptance criteria:

- Permission or question requests arriving after a prior `result` do not fail
  with `claude_missing_turn_state`.
- Claude stdout lines arriving after a prior `result` are buffered instead of
  dropped.

### Phase 3: Host-Core Support for Unsolicited Session Events

- [x] Extend host-core session transport handling so adapters can emit session
      traffic that is not tied to a currently open request correlation.
- [x] Define how unsolicited session messages are surfaced from the process
      driver into the provider driver layer.
- [x] Preserve existing correlated turn behavior for normal request/response
      turns.

Scope:

- `nla/packages/host-core/src/session-client.ts`
- `host-runtime/packages/provider-host/src/NlaJsonlProcessDriver.ts`
- maybe protocol/runtime glue in `nla/packages/sdk-core`

Acceptance criteria:

- [x] The host can receive adapter session events while no request stream is
      currently active.

### Phase 4: HostRuntime Provider-Initiated Turns

- [x] Add a host-runtime path that starts a new turn when provider events arrive
      on an idle adapter session.
- [x] Mint a new host `turnId` for that provider-initiated turn.
- [x] Emit the normal event lifecycle:
      - `conversation.turn.started`
      - message/activity/interaction events
      - terminal execution event
      - `conversation.turn.completed` or `conversation.turn.failed`
- [x] Keep interrupt behavior coherent for provider-initiated turns.

Scope:

- `host-runtime/packages/application/src/HostRuntime.ts`
- possibly event log and control-gateway follow-on adjustments

Acceptance criteria:

- [x] If Claude emits new activity after a prior `result`, the host opens a new turn
  and the UI can render it.

### Phase 5: Claude Adapter Runtime Shape Decision

- [ ] Decide whether to:
      - keep using `defineAdapter()` / `runAdapterStdio()` and extend NLA core,
        or
      - bypass the generic adapter runtime for `claude-cli` and implement a
        direct NLA JSONL loop for this adapter
- [ ] Choose the lower-risk path for unsolicited background session events.

Recommendation:

- Prefer a direct NLA JSONL loop for `claude-cli` if Phase 3 shows the generic
  request-scoped runtime is fighting the design. Full parity is easier if the
  adapter owns its own long-lived session event pump.

Acceptance criteria:

- The architecture decision is explicit before broad refactoring begins.

### Phase 6: End-to-End Coverage

- [ ] Add a test proving one Claude child is reused across multiple user turns.
- [ ] Add a test proving `result` completes the current turn without ending the
      Claude session.
- [ ] Add a test proving permission requests can arrive after a prior `result`.
- [ ] Add a test proving question requests can arrive after a prior `result`.
- [ ] Add a test proving background provider events can start a new host turn.
- [ ] Add a test covering child exit while idle vs child exit during active work.
- [ ] Add a test covering interrupt behavior with a persistent Claude subprocess.

Acceptance criteria:

- The main parity behaviors are covered by deterministic tests, not just manual
  verification.

## Suggested Execution Order

1. Phase 0
2. Phase 5 architecture decision
3. Phase 1
4. Phase 2
5. Phase 3
6. Phase 4
7. Phase 6

## Risks

- The installed Claude CLI may differ from the SDK assumptions around
  non-`-p` `stream-json` support.
- Extending `@nla/sdk-core` to support unsolicited session events may create
  broad ripple effects across other adapters.
- Provider-initiated turns will touch host-runtime assumptions that currently
  model turns as user-input-driven.

## First Concrete Task

- Run the Phase 0 protocol spike and check in either:
  - a short transcript doc, or
  - a fixture script plus captured output

Do not remove `-p` before that validation exists.
