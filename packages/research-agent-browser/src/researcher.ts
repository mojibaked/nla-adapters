import type {
  BrowserClient,
  LlmClient,
  PageClaim,
  PageFinding,
  SearchCandidate
} from "./types.js";

export interface ResearchPageInput {
  readonly query: string;
  readonly candidate: SearchCandidate;
  readonly maxPageChars?: number;
}

export interface ResearchPageDependencies {
  readonly browser: BrowserClient;
  readonly llm: LlmClient;
}

const DEFAULT_MAX_PAGE_CHARS = 20_000;

const EXTRACTION_SYSTEM_PROMPT = `You extract information from a single web page that is relevant to a specific research query.

Respond with a JSON object: { "claims": [ { "text": "...", "quote": "..." } ] }
- Each claim must be directly relevant to the query.
- "text" is a one-sentence paraphrase of the claim.
- "quote" is a verbatim span from the page that supports it (<= 200 chars). Omit if no clean quote exists.
- If the page has nothing relevant, respond with { "claims": [] }.
- Do not invent information. Only include claims supported by the page.
Respond with JSON only — no prose, no code fences.`;

export const researchPage = async (
  deps: ResearchPageDependencies,
  input: ResearchPageInput
): Promise<PageFinding> => {
  const { candidate, query } = input;
  const maxChars = input.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS;

  let pageText = candidate.content;
  let title = candidate.title;
  let openedTabId: number | undefined;

  try {
    if (pageText === undefined) {
      const tab = await deps.browser.openTab(candidate.url);
      openedTabId = tab.tabId;
      if (title === undefined && tab.title) title = tab.title;
      pageText = await deps.browser.getText(tab.tabId);
    }

    const trimmed = pageText.trim();
    if (!trimmed) {
      return finding(candidate.url, title, [], "page returned no text");
    }

    const capped = trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;

    const response = await deps.llm.complete({
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Query: ${query}\n\nPage URL: ${candidate.url}\n\nPage text (may be truncated):\n${capped}`
        }
      ],
      temperature: 0
    });

    return finding(candidate.url, title, parseClaims(response.text));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finding(candidate.url, title, [], message);
  } finally {
    if (openedTabId !== undefined) {
      try {
        await deps.browser.closeTab(openedTabId);
      } catch {
        // Best-effort cleanup — don't mask the real error.
      }
    }
  }
};

const finding = (
  url: string,
  title: string | undefined,
  claims: ReadonlyArray<PageClaim>,
  error?: string
): PageFinding => ({
  url,
  ...(title ? { title } : {}),
  claims,
  ...(error ? { error } : {})
});

const parseClaims = (raw: string): ReadonlyArray<PageClaim> => {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];
  const list = parsed["claims"];
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const claimText = trimmedString(entry["text"]);
    if (!claimText) return [];
    const quote = trimmedString(entry["quote"]);
    return [quote ? { text: claimText, quote } : { text: claimText }];
  });
};

const trimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
