export { createBrowserResearchClient } from "./client.js";
export type { BrowserResearchClientDependencies } from "./client.js";

export { researchPage } from "./researcher.js";
export type {
  ResearchPageDependencies,
  ResearchPageInput
} from "./researcher.js";

export { synthesizeFindings } from "./synthesizer.js";
export type {
  SynthesizeInput,
  SynthesizeResult
} from "./synthesizer.js";

export { pruneCandidates } from "./prune.js";
export type { PruneInput } from "./prune.js";

export { mapWithConcurrency } from "./pool.js";

export type {
  BrowserClient,
  BrowserTab,
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  PageClaim,
  PageFinding,
  SearchCandidate,
  SearchClient,
  SearchInput
} from "./types.js";
