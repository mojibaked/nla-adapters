import { runAdapterStdio } from "@nla/transport-stdio-jsonl";
import { createWalletAgent, type WalletAgentDependencies } from "./adapter.js";

export const runWalletAgentStdio = (
  dependencies: WalletAgentDependencies
): Promise<void> =>
  runAdapterStdio(createWalletAgent(dependencies));
