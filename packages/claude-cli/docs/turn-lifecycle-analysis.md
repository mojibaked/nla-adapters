# Turn lifecycle analysis — why async tools break

## Symptoms

- **Monitor events don't reach the model.** The model calls `Monitor`, the adapter
  processes the response, and the turn ends. Subsequent stdout lines emitted by
  the `Monitor` watcher never influence the model — they are read but dropped.
- **"Claude requested approval without an active turn"** errors appear when the
  CLI issues a permission request in the window between turns.

Both symptoms are the same defect: the adapter models a turn as a bounded
request/response with `result` as terminator. The native CLI (and the Python
SDK) models a turn as one pause inside a long-lived agentic loop.

## How the adapter invokes Claude today

`packages/claude-cli/src/runtime.ts:598-633` builds and spawns:

```
claude
  -p
  --input-format  stream-json
  --output-format stream-json
  --verbose
  --include-partial-messages
  --mcp-config            <bridge>
  --settings              <bridge>
  --allowedTools          <permTool>
  --permission-prompt-tool <permTool>
  [--resume <sessionRef>]
```

The `-p` (`--print`) flag puts the CLI in **one-shot mode**: run the query,
print the result, exit. In this mode `result` is literally the last thing the
CLI emits before the process exits, so the adapter's "treat `result` as
terminator" behavior is internally consistent with the invocation — but it
makes background tools structurally impossible.

## How the Python SDK invokes Claude

`~/source/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py:203-378`
builds:

```
claude
  --output-format stream-json
  --verbose
  [...options...]
  --input-format stream-json
```

Key differences:

1. **No `-p`.** The CLI runs in persistent streaming mode. It reads JSON
   messages from stdin, emits JSON messages on stdout, and stays alive across
   many turns. `result` means "this turn has paused; the agent loop is waiting
   for the next input," not "process is about to exit."
2. **One subprocess per session, not per query.** `subprocess_cli.py:448-456`
   calls `anyio.open_process(...)` once. Subsequent user messages go through
   the same process via `transport.write(...)` (`client.py:220-248`).
3. **Stdout is never torn down on `result`.** The read loop
   (`query.py:205-270`) iterates indefinitely and only exits on `_closed`,
   transport EOF, or exception. Messages flow into an
   `anyio.create_memory_object_stream(max_buffer_size=100)` at
   `query.py:114-117` — a persistent buffer that survives any per-query
   boundary.
4. **Control requests are decoupled from turn state.** Permission prompts,
   MCP round-trips, etc. are routed as `control_request` / `control_response`
   pairs keyed by `request_id` (`query.py:194-203, 229-234, 389-434`).
   Nothing gates them on "is there an active turn." They fly independently.
5. **Stdin stays open across turns.** New user messages can be streamed in
   whenever (`query.py:717-729`).

## Where the mismatch manifests in this repo

### End-of-turn handling

`packages/claude-cli/src/notifications.ts:112-123` emits `turn.completed` the
moment the CLI writes a `result` line. `packages/claude-cli/src/runtime.ts:462-470`
handles that event by clearing `session.turnState = undefined` and calling
`ctx.complete()`.

From that moment on:

- The stdout reader is still installed on the child process, but every line
  hits `runtime.ts:806-807` (`if (!turnState) return;`) and gets dropped.
- Any `result`-time in-flight async tool (e.g. `Monitor`) has no channel to
  deliver its next event through.

### Permission gating

`packages/claude-cli/src/runtime.ts:696-714` requires
`session.turnState` to exist in order to service a permission request. If the
CLI's bridge sends a `requestPermission` during a window where `turnState` is
undefined — e.g. when the previous turn just released and the adapter has not
yet acquired a new one — the request is rejected with
`claude_missing_turn_state` / "Claude requested approval without an active
turn."

In the Python SDK, the equivalent request would fire through the
`control_request` channel against the live subprocess, keyed by `request_id`,
with no "is a turn active" check anywhere.

## Suggested realignment

Ordered least-invasive to most-invasive.

### 1. Decouple permission handling from `turnState`

Route `requestPermission` / `requestQuestion` through a `requestId`-keyed map
at the session level instead of gating on `turnState`. The CLI and bridge can
keep communicating even between turns, matching Python SDK
`query.py:389-434`. Fixes the "no active turn" approval error immediately.

### 2. Keep stdin open; stop re-spawning per turn

`runtime.ts:598-633` currently relies on `ensureClient`, which happens to
preserve the child between turns when it hasn't exited — but the `-p` flag
causes the CLI to exit after the first `result`, defeating that reuse. Drop
`-p`. With the CLI in streaming mode, a single subprocess can carry the whole
session.

### 3. Stop nuking `turnState` on `result`

Either:

- Treat `result` as a *pause*: keep `turnState` alive, but signal "turn paused,
  awaiting next input" so the host can release its outer turn lock. New input
  (user messages or pseudo-user messages from async tools) clears the pause
  and resumes.
- Or: move the stdout queue from `turnState.queue` to a session-level queue
  that outlives any turn. This is closer to the Python SDK's memory stream
  model — messages accumulate even if nothing is currently consuming them.

### 4. Treat async tool events as first-class triggers

When a background tool event arrives for a session that has no active turn,
the adapter should be able to start a new turn by writing the event as a
user-shaped message to the still-open stdin. The host must gain a notion of
"adapter-initiated turn" for this to surface cleanly in UI.

## One-line summary

`-p` at `runtime.ts:608` is the single flag whose presence makes the adapter's
whole turn model incompatible with Claude Code's async-tool contract. Removing
it is the starting point; the downstream adapter logic in `runtime.ts` and
`notifications.ts` then needs to stop assuming `result` is a process-terminal
event.
