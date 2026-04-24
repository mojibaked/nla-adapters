import { runAdapterStdio } from "@nla/transport-stdio-jsonl";
import {
  createResearchAgent,
  type ResearchAgentDependencies
} from "@nla-adapters/research-agent";
import { createBrowserResearchClient, type BrowserResearchClientDependencies } from "./client.js";

export interface BrowserResearchAgentStdioDependencies
  extends BrowserResearchClientDependencies {
  readonly now?: ResearchAgentDependencies["now"];
}

export const runBrowserResearchAgentStdio = (
  dependencies: BrowserResearchAgentStdioDependencies
): Promise<void> => {
  const research = createBrowserResearchClient(dependencies);
  return runAdapterStdio(
    createResearchAgent({
      research,
      ...(dependencies.now ? { now: dependencies.now } : {})
    })
  );
};
