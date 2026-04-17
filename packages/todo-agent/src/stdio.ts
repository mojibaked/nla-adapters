import { runAdapterStdio } from "@nla/transport-stdio-jsonl";
import { createTodoAgent, type TodoAgentDependencies } from "./adapter.js";

export const runTodoAgentStdio = (
  dependencies: TodoAgentDependencies
): Promise<void> =>
  runAdapterStdio(createTodoAgent(dependencies));
