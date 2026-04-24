import { runAdapterStdio } from "@nla/transport-stdio-jsonl";
import { createResearchAgent, type ResearchAgentDependencies } from "./adapter.js";

export const runResearchAgentStdio = (
  dependencies: ResearchAgentDependencies
): Promise<void> =>
  runAdapterStdio(createResearchAgent(dependencies));
