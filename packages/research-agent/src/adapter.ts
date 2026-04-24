import type {
  NlaSessionMessage,
  NlaSessionMessagePart
} from "@nla/protocol";
import { defineAdapter, type NlaAdapterDefinition } from "@nla/sdk-core";

export interface ResearchSource {
  readonly title?: string;
  readonly url?: string;
  readonly snippet?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ResearchResult {
  readonly answer: string;
  readonly sources: ReadonlyArray<ResearchSource>;
  readonly checkedAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ResearchQueryInput {
  readonly query: string;
  readonly text?: string;
  readonly parts?: ReadonlyArray<NlaSessionMessagePart>;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ResearchQueryResult {
  readonly answer: string;
  readonly sources?: ReadonlyArray<ResearchSource>;
  readonly checkedAt?: string | Date;
  readonly metadata?: Record<string, unknown>;
}

export interface ResearchQueryClient {
  query(input: ResearchQueryInput): Promise<ResearchQueryResult>;
}

export interface ResearchAgentDependencies {
  readonly research: ResearchQueryClient;
  readonly now?: () => Date | string;
}

export const createResearchAgent = (
  dependencies: ResearchAgentDependencies
): NlaAdapterDefinition =>
  defineAdapter({
    id: "research.agent",
    name: "Research Agent",
    description: "Portable one-shot research adapter backed by an injected research client.",
    capabilities: {
      sessions: true,
      streaming: false
    },
    sessionStart: (ctx) => {
      ctx.started();
      ctx.status("idle", "ready");
    },
    sessionMessage: async (ctx, message) => {
      const input = researchInputFromMessage(message);

      ctx.status("working", "researching", {
        query: input.query
      });
      ctx.execution({
        state: "running",
        turnId: input.turnId,
        interruptible: false
      });

      const result = await runResearchQuery(dependencies, input);

      ctx.reply({
        text: formatResearchAssistantText(result),
        metadata: {
          kind: "research.result",
          checkedAt: result.checkedAt,
          sources: result.sources,
          result
        }
      });
      ctx.execution({
        state: "completed",
        turnId: input.turnId,
        interruptible: false
      });
      ctx.status("completed", "research complete", {
        checkedAt: result.checkedAt,
        sourceCount: result.sources.length
      });
      ctx.complete();
    },
    sessionStop: (ctx) => {
      ctx.stopped();
    }
  });

export const runResearchQuery = async (
  dependencies: ResearchAgentDependencies,
  input: ResearchQueryInput
): Promise<ResearchResult> => {
  const normalizedInput = normalizeResearchQueryInput(input);
  const result = await dependencies.research.query(normalizedInput);

  return normalizeResearchResult(dependencies, result);
};

const normalizeResearchQueryInput = (
  input: ResearchQueryInput
): ResearchQueryInput => {
  const query = input.query.trim();

  if (!query) {
    throw new Error("research.agent requires a non-empty research query");
  }

  return {
    ...input,
    query,
    text: input.text?.trim() || query,
    parts: input.parts ? [...input.parts] : []
  };
};

const normalizeResearchResult = (
  dependencies: ResearchAgentDependencies,
  result: ResearchQueryResult
): ResearchResult => {
  const answer = result.answer.trim();

  if (!answer) {
    throw new Error("research.agent dependency returned an empty answer");
  }

  const metadata = isRecord(result.metadata) ? { ...result.metadata } : undefined;

  return {
    answer,
    sources: normalizeSources(result.sources),
    checkedAt: normalizeCheckedAt(result.checkedAt, dependencies),
    ...(metadata ? { metadata } : {})
  };
};

const normalizeSources = (
  sources: ReadonlyArray<ResearchSource> | undefined
): ReadonlyArray<ResearchSource> => {
  if (!Array.isArray(sources)) {
    return [];
  }

  return sources.flatMap((source) => {
    if (!isRecord(source)) {
      return [];
    }

    const title = trimmedString(source.title);
    const url = trimmedString(source.url);
    const snippet = trimmedString(source.snippet);
    const metadata = isRecord(source.metadata)
      ? { ...source.metadata }
      : undefined;

    if (!title && !url && !snippet && !metadata) {
      return [];
    }

    return [{
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      ...(snippet ? { snippet } : {}),
      ...(metadata ? { metadata } : {})
    }];
  });
};

const normalizeCheckedAt = (
  checkedAt: string | Date | undefined,
  dependencies: Pick<ResearchAgentDependencies, "now">
): string => {
  if (checkedAt instanceof Date && !Number.isNaN(checkedAt.getTime())) {
    return checkedAt.toISOString();
  }

  if (typeof checkedAt === "string" && checkedAt.trim()) {
    return checkedAt.trim();
  }

  const now = dependencies.now?.() ?? new Date();
  if (now instanceof Date) {
    return now.toISOString();
  }

  return now.trim() || new Date().toISOString();
};

const researchInputFromMessage = (
  message: NlaSessionMessage
): ResearchQueryInput => {
  if (message.data.role !== "user") {
    throw new Error(`research.agent only accepts user messages, received ${message.data.role}`);
  }

  const parts = Array.isArray(message.data.parts)
    ? [...message.data.parts]
    : [];
  const text = messageText(message.data.text, parts);

  if (!text) {
    throw new Error("research.agent requires non-empty user text or text parts");
  }

  return {
    query: text,
    text,
    parts,
    sessionId: message.data.sessionId,
    turnId: resolveTurnId(message),
    metadata: message.data.metadata
  };
};

const messageText = (
  text: string | undefined,
  parts: ReadonlyArray<NlaSessionMessagePart>
): string => {
  const explicitText = text?.trim();
  if (explicitText) {
    return explicitText;
  }

  return parts
    .flatMap((part) => {
      const partText = trimmedString(part.text);
      return partText ? [partText] : [];
    })
    .join("\n")
    .trim();
};

const resolveTurnId = (
  message: NlaSessionMessage
): string | undefined => {
  const turnId = message.data.turnId?.trim();
  if (turnId) {
    return turnId;
  }

  const metadataTurnId = message.data.metadata?.turnId;
  return typeof metadataTurnId === "string" && metadataTurnId.trim()
    ? metadataTurnId.trim()
    : undefined;
};

const formatResearchAssistantText = (
  result: ResearchResult
): string => {
  const lines = [result.answer];

  if (result.sources.length > 0) {
    lines.push("", "Sources:");
    for (const source of result.sources) {
      lines.push(formatSourceLine(source));
      if (source.snippet) {
        lines.push(`  ${source.snippet}`);
      }
    }
  }

  return lines.join("\n");
};

const formatSourceLine = (
  source: ResearchSource
): string => {
  const label = source.title ?? source.url ?? "Source";
  return source.url && source.url !== label
    ? `- ${label} - ${source.url}`
    : `- ${label}`;
};

const trimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
