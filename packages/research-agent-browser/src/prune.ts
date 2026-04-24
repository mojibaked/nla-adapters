import type { LlmClient, SearchCandidate } from "./types.js";

export interface PruneInput {
  readonly query: string;
  readonly candidates: ReadonlyArray<SearchCandidate>;
  readonly keep: number;
}

const PRUNE_SYSTEM_PROMPT = `You rank candidate URLs by how useful each is for answering a research query.

Given a query and a numbered list of candidates (url, title, snippet), pick the indices of the most useful ones.
- Prefer diverse, reputable sources over near-duplicates.
- Skip obvious low-signal results (link farms, SEO spam, irrelevant pages).
- If fewer than the requested number of candidates are genuinely useful, return fewer.
- Respond with JSON only: { "keep": [1, 3, 4, ...] } — no prose, no code fences.`;

export const pruneCandidates = async (
  llm: LlmClient,
  input: PruneInput
): Promise<ReadonlyArray<SearchCandidate>> => {
  const { query, candidates, keep } = input;
  if (candidates.length <= keep) return candidates;

  const listBlock = candidates
    .map((candidate, index) => renderCandidate(candidate, index + 1))
    .join("\n");

  const response = await llm.complete({
    messages: [
      { role: "system", content: PRUNE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Query: ${query}\n\nKeep up to ${keep} candidates.\n\nCandidates:\n${listBlock}`
      }
    ],
    temperature: 0
  });

  const indices = parseKeepIndices(response.text, candidates.length);
  if (indices.length === 0) return candidates.slice(0, keep);
  return indices
    .slice(0, keep)
    .map((i) => candidates[i - 1])
    .filter((candidate): candidate is SearchCandidate => candidate !== undefined);
};

const renderCandidate = (candidate: SearchCandidate, index: number): string => {
  const title = candidate.title ?? "(no title)";
  const snippet = candidate.snippet ? ` — ${candidate.snippet}` : "";
  return `[${index}] ${title}${snippet}\n    ${candidate.url}`;
};

const parseKeepIndices = (raw: string, total: number): ReadonlyArray<number> => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const keep = (parsed as Record<string, unknown>)["keep"];
    if (!Array.isArray(keep)) return [];
    const seen = new Set<number>();
    return keep.flatMap((value) => {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(n) || n < 1 || n > total || seen.has(n)) return [];
      seen.add(n);
      return [n];
    });
  } catch {
    return [];
  }
};
