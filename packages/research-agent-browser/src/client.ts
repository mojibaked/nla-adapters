import type {
  ResearchQueryClient,
  ResearchQueryInput,
  ResearchSource
} from "@nla-adapters/research-agent";

import { mapWithConcurrency } from "./pool.js";
import { pruneCandidates } from "./prune.js";
import { researchPage } from "./researcher.js";
import { synthesizeFindings } from "./synthesizer.js";
import type {
  BrowserClient,
  LlmClient,
  PageFinding,
  SearchClient
} from "./types.js";

export interface BrowserResearchClientDependencies {
  readonly search: SearchClient;
  readonly browser: BrowserClient;
  readonly llm: LlmClient;
  /** Max concurrent browser tabs during phase 2. Default 4. */
  readonly concurrency?: number;
  /** Max candidate URLs to actually open after search. Default 8. */
  readonly maxCandidates?: number;
  /** Pull this many results from search, then LLM-prune down to maxCandidates before fan-out. */
  readonly searchOverfetch?: number;
  /** Char cap on per-page text sent to the LLM. Default 20000. */
  readonly maxPageChars?: number;
}

export const createBrowserResearchClient = (
  deps: BrowserResearchClientDependencies
): ResearchQueryClient => ({
  async query(input: ResearchQueryInput) {
    const concurrency = deps.concurrency ?? 4;
    const maxCandidates = deps.maxCandidates ?? 8;
    const maxPageChars = deps.maxPageChars ?? 20_000;
    const overfetch = deps.searchOverfetch && deps.searchOverfetch > maxCandidates
      ? deps.searchOverfetch
      : undefined;

    const rawCandidates = await deps.search.search({
      query: input.query,
      maxResults: overfetch ?? maxCandidates
    });

    const candidates = overfetch
      ? await pruneCandidates(deps.llm, {
          query: input.query,
          candidates: rawCandidates,
          keep: maxCandidates
        })
      : rawCandidates.slice(0, maxCandidates);

    const findings = await mapWithConcurrency(
      candidates,
      concurrency,
      (candidate) =>
        researchPage(
          { browser: deps.browser, llm: deps.llm },
          { query: input.query, candidate, maxPageChars }
        )
    );

    const synthesis = await synthesizeFindings(deps.llm, {
      query: input.query,
      findings
    });

    return {
      answer: synthesis.answer,
      sources: findingsToSources(findings)
    };
  }
});

const findingsToSources = (
  findings: ReadonlyArray<PageFinding>
): ReadonlyArray<ResearchSource> =>
  findings
    .filter((finding) => !finding.error && finding.claims.length > 0)
    .map((finding): ResearchSource => {
      const primary = finding.claims[0];
      const snippet = primary?.quote ?? primary?.text;
      return {
        ...(finding.title ? { title: finding.title } : {}),
        url: finding.url,
        ...(snippet ? { snippet } : {})
      };
    });
