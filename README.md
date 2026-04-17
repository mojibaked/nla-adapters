# nla-adapters

Portable adapter packages for NLA.

The split in this repo is:

- `@nla/sdk-core`
  generic NLA adapter/runtime mechanics
- `@nla-adapters/contracts`
  neutral capability contracts
- `@nla-adapters/todo-agent`
  portable todo adapter logic that depends only on NLA plus contracts

`host-runtime` should not be the portable surface. It should be one capability
implementation behind thin wrappers.

## Current Packages

```text
packages/
  contracts/   neutral capability contracts
  todo-agent/  portable todo adapter
  wallet-agent/ portable wallet adapter
```

## Todo Agent Shape

The todo adapter is created by dependency injection:

```ts
import { createTodoAgent } from "@nla-adapters/todo-agent";

const adapter = createTodoAgent({
  createModel: () => myToolLoopModel(),
  storage: {
    getJson: async (request) => { ... },
    putJson: async (request) => { ... }
  }
});
```

For stdio processes:

```ts
import { runTodoAgentStdio } from "@nla-adapters/todo-agent/stdio";

await runTodoAgentStdio({
  createModel: () => myToolLoopModel(),
  storage: {
    getJson: async (request) => { ... },
    putJson: async (request) => { ... }
  }
});
```

## Host Runtime Wrapper Example

This is the intended wrapper style inside `host-runtime`:

```ts
import * as Effect from "effect/Effect";
import { runTodoAgentStdio } from "@nla-adapters/todo-agent/stdio";
import { toolLoopModel } from "@host-runtime/sdk/llm";
import { getJson, putJson } from "@host-runtime/sdk/storage";

await runTodoAgentStdio({
  createModel: () =>
    toolLoopModel({
      provider: "openrouter",
      metadata: {
        agent_id: "todo.agent"
      }
    }),
  storage: {
    getJson: (request) => Effect.runPromise(getJson(request)),
    putJson: (request) => Effect.runPromise(putJson(request))
  }
});
```

That keeps the portable adapter free of `@host-runtime/sdk/*` while still
letting `host-runtime` provide storage and model brokering.
