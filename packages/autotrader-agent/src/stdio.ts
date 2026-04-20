import { runAdapterStdio } from "@nla/transport-stdio-jsonl";
import { createAutotraderAgent, type AutotraderAgentDependencies } from "./adapter.js";

export const runAutotraderAgentStdio = (
  dependencies: AutotraderAgentDependencies
): Promise<void> =>
  runAdapterStdio(createAutotraderAgent(dependencies));
