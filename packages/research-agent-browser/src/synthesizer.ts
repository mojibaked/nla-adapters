import type { LlmClient, PageFinding } from "./types.js";

export interface SynthesizeInput {
  readonly query: string;
  readonly findings: ReadonlyArray<PageFinding>;
}

export interface SynthesizeResult {
  readonly answer: string;
  readonly citedUrls: ReadonlyArray<string>;
}

const SYNTHESIS_SYSTEM_PROMPT = `You are a research synthesizer. You are given a user query and structured findings extracted from several pages.

Write a concise answer (4-10 sentences) that directly addresses the query.
- Ground every factual claim in at least one finding. Do not add information not present in the findings.
- Reference sources inline using [n], where n is the 1-based index shown next to each finding.
- If findings conflict, note the disagreement rather than picking one silently.
- If no findings address the query, say so plainly.`;

export const synthesizeFindings = async (
  llm: LlmClient,
  input: SynthesizeInput
): Promise<SynthesizeResult> => {
  const relevant = input.findings.filter(
    (finding) => !finding.error && finding.claims.length > 0
  );

  if (relevant.length === 0) {
    return {
      answer: "No research findings addressed this query.",
      citedUrls: []
    };
  }

  const findingsBlock = relevant
    .map((finding, index) => renderFinding(finding, index + 1))
    .join("\n\n");

  const response = await llm.complete({
    messages: [
      { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Query: ${input.query}\n\nFindings:\n${findingsBlock}`
      }
    ],
    temperature: 0.2
  });

  return {
    answer: response.text.trim(),
    citedUrls: relevant.map((finding) => finding.url)
  };
};

const renderFinding = (finding: PageFinding, index: number): string => {
  const header = `[${index}] ${finding.title ?? finding.url}\n  URL: ${finding.url}`;
  const claimLines = finding.claims
    .map((claim) => `  - ${claim.text}${claim.quote ? ` (quote: "${claim.quote}")` : ""}`)
    .join("\n");
  return `${header}\n${claimLines}`;
};
