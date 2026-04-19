# Non-`-p` Protocol Spike

Date: 2026-04-18

Local CLI tested:

- `Claude Code 2.1.114`

## Goal

Validate whether the installed Claude CLI supports the persistent `stream-json`
protocol shape used by the Python SDK, without `-p`.

## High-Level Result

The local Claude CLI **does** support persistent non-`-p` `stream-json` mode.

Confirmed behaviors:

- A single Claude subprocess can handle multiple sequential user turns when
  stdin remains open.
- SDK-style `control_request` messages are accepted.
- SDK-style user messages are accepted.
- Control requests such as `set_permission_mode` work cleanly between turns.

Important nuance:

- `initialize` is **accepted and useful**, but it is **not required** for a
  simple user turn. A plain user message succeeds without it.
- A simple shell pipeline is **not** a valid persistence test because Claude
  exits cleanly when stdin closes after the pipeline drains.

## Probes Run

### 1. Raw initialize + one user turn

Input shape:

```json
{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}
{"type":"user","message":{"role":"user","content":"Reply with OK only."},"session_id":"default","parent_tool_use_id":null}
```

Observed:

- `control_response` with `subtype: "success"`
- `system` with `subtype: "init"`
- `assistant`
- `result`

This works without `-p`.

## 2. Two sequential user turns on one subprocess

Method:

- Spawn `claude --output-format stream-json --verbose --input-format stream-json --tools ""`
- Keep stdin open in a small harness
- Send first user turn
- Wait for first `result`
- Send second user turn on the same process

Observed:

- Same Claude PID handled both turns
- Same emitted `session_id` persisted across both turns
- Both turns completed successfully

Representative output sequence:

```json
{"type":"system","subtype":"init","session_id":"cf739915-96a6-4eea-b18c-de179180c57c", ...}
{"type":"assistant","message":{"content":[{"type":"text","text":"FIRST"}]}, ...}
{"type":"result","result":"FIRST","session_id":"cf739915-96a6-4eea-b18c-de179180c57c", ...}
{"type":"system","subtype":"init","session_id":"cf739915-96a6-4eea-b18c-de179180c57c", ...}
{"type":"assistant","message":{"content":[{"type":"text","text":"SECOND"}]}, ...}
{"type":"result","result":"SECOND","session_id":"cf739915-96a6-4eea-b18c-de179180c57c", ...}
```

Notes:

- The client sent `session_id: "default"` on each user message.
- Claude emitted a real UUID `session_id` in responses.
- The second turn succeeded without respawning the process.
- Claude emitted another `system:init` before the second assistant reply.

## 3. User turn without initialize

Input shape:

```json
{"type":"user","message":{"role":"user","content":"Reply with NOINIT only."},"session_id":"default","parent_tool_use_id":null}
```

Observed:

- `system:init`
- `assistant`
- `result`

Conclusion:

- `initialize` is not required for the simplest prompt/response flow.
- We should still use it when matching the SDK transport, especially for
  command discovery and control-plane consistency.

## 4. Between-turn control request

After the first `result`, send:

```json
{"type":"control_request","request_id":"req_set_mode","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
```

Observed:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"req_set_mode","response":{"mode":"acceptEdits"}}}
{"type":"system","subtype":"status","permissionMode":"acceptEdits", ...}
{"type":"system","subtype":"init","permissionMode":"acceptEdits", ...}
```

A subsequent user turn on the same subprocess also succeeded.

Conclusion:

- Control requests can be processed cleanly between turns.
- The adapter's current `turnState`-gated permission/question handling does not
  match real CLI behavior.

## Wire-Level Findings

### Accepted user frame

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "..."
  },
  "session_id": "default",
  "parent_tool_use_id": null
}
```

### Accepted initialize frame

```json
{
  "type": "control_request",
  "request_id": "req_1",
  "request": {
    "subtype": "initialize"
  }
}
```

### Accepted control update frame

```json
{
  "type": "control_request",
  "request_id": "req_set_mode",
  "request": {
    "subtype": "set_permission_mode",
    "mode": "acceptEdits"
  }
}
```

## Implications for the Adapter

1. Removing `-p` is viable on the tested local CLI build.
2. The Claude subprocess should be session-scoped, not turn-scoped.
3. `result` should no longer imply process exit or stdout teardown.
4. Permission/question handling must move off `turnState`.
5. Full parity still requires host/runtime support for unsolicited provider
   events after a turn has completed.

## Scope Completed

This spike completed the validation needed before removing `-p`.
