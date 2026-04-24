import type { SearchCandidate, SearchClient, SearchInput } from "./types.js";

export interface ExaSearchClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly defaultNumResults?: number;
  /** Char cap on the content field Exa returns per result. Default 20000. */
  readonly maxCharactersPerResult?: number;
  /** Injectable fetch for testing. */
  readonly fetch?: typeof fetch;
}

interface ExaSearchResult {
  readonly url?: unknown;
  readonly title?: unknown;
  readonly text?: unknown;
  readonly snippet?: unknown;
  readonly summary?: unknown;
  readonly highlights?: unknown;
}

interface ExaSearchResponse {
  readonly results?: ReadonlyArray<ExaSearchResult>;
}

const DEFAULT_BASE_URL = "https://api.exa.ai";
const DEFAULT_NUM_RESULTS = 8;
const DEFAULT_MAX_CHARS = 20_000;

export const createExaSearchClient = (options: ExaSearchClientOptions): SearchClient => {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("ExaSearchClient requires an apiKey");
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const defaultNumResults = options.defaultNumResults ?? DEFAULT_NUM_RESULTS;
  const maxCharacters = options.maxCharactersPerResult ?? DEFAULT_MAX_CHARS;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async search(input: SearchInput) {
      const numResults = input.maxResults ?? defaultNumResults;

      const response = await fetchImpl(`${baseUrl}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify({
          query: input.query,
          numResults,
          type: "auto",
          contents: {
            text: { maxCharacters, includeHtmlTags: false }
          }
        })
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Exa search failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`
        );
      }

      const payload = (await response.json()) as ExaSearchResponse;
      const results = Array.isArray(payload.results) ? payload.results : [];
      return results.flatMap(toCandidate);
    }
  };
};

const toCandidate = (result: ExaSearchResult): ReadonlyArray<SearchCandidate> => {
  const url = trimmedString(result.url);
  if (!url) return [];
  const title = trimmedString(result.title);
  const snippet = trimmedString(result.snippet) ?? trimmedString(result.summary);
  const content = trimmedString(result.text);
  const candidate: SearchCandidate = {
    url,
    ...(title ? { title } : {}),
    ...(snippet ? { snippet } : {}),
    ...(content ? { content } : {})
  };
  return [candidate];
};

const trimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
