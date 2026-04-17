import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  NlaMessageRole,
  NlaThreadScope,
  NlaThreadSummaryData,
  NlaThreadsHistoryItemData
} from "@nla/protocol";
import { recordValue, stringValue } from "./shared.js";

const DefaultLimit = 50;
const MaxLimit = 200;

interface CodexTranscript {
  readonly filePath: string;
  readonly fileNameRef: string;
  readonly threadRef: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly source?: string;
  readonly cliVersion?: string;
  readonly firstPrompt?: string;
  readonly summary?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly messageCount: number;
  readonly items: ReadonlyArray<NlaThreadsHistoryItemData>;
}

export const listCodexThreads = async (input: {
  readonly configDir: string;
  readonly scope?: NlaThreadScope;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<{
  readonly threads: ReadonlyArray<NlaThreadSummaryData>;
  readonly nextCursor?: string;
}> => {
  const transcripts = (await scanCodexTranscripts(input.configDir))
    .filter((transcript) => matchesScope(transcript, input.scope))
    .sort(compareTranscripts);
  const page = paginate(transcripts, input.cursor, input.limit);

  return {
    threads: page.items.map((transcript) => ({
      threadRef: transcript.threadRef,
      title: titleForTranscript(transcript),
      summary: transcript.summary,
      firstPrompt: transcript.firstPrompt,
      createdAt: transcript.createdAt,
      updatedAt: transcript.updatedAt,
      messageCount: transcript.messageCount,
      metadata: compactRecord({
        provider: "codex.cli",
        cwd: transcript.cwd,
        source: transcript.source,
        cliVersion: transcript.cliVersion,
        transcriptPath: transcript.filePath
      })
    })),
    nextCursor: page.nextCursor
  };
};

export const getCodexThreadHistory = async (input: {
  readonly configDir: string;
  readonly threadRef: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<{
  readonly items: ReadonlyArray<NlaThreadsHistoryItemData>;
  readonly nextCursor?: string;
}> => {
  const transcript = (await scanCodexTranscripts(input.configDir))
    .filter((candidate) => transcriptMatches(candidate, input.threadRef))
    .sort(compareTranscripts)[0];

  if (!transcript) {
    return {
      items: []
    };
  }

  const page = paginate(transcript.items, input.cursor, input.limit);
  return {
    items: page.items,
    nextCursor: page.nextCursor
  };
};

const scanCodexTranscripts = async (
  configDir: string
): Promise<ReadonlyArray<CodexTranscript>> => {
  const files = await collectJsonlFiles(path.join(configDir, "sessions"));
  const transcripts = await Promise.all(files.map(readCodexTranscript));
  return transcripts.flatMap((transcript) => transcript ? [transcript] : []);
};

const collectJsonlFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  let entries;
  try {
    entries = await readdir(directory, {
      withFileTypes: true
    });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonlFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }

  return files;
};

const readCodexTranscript = async (
  filePath: string
): Promise<CodexTranscript | undefined> => {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }

  const records = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = recordValue(JSON.parse(line));
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });

  const fileNameRef = path.basename(filePath, ".jsonl");
  let sessionId = sessionIdFromFileName(fileNameRef);
  let cwd: string | undefined;
  let source: string | undefined;
  let cliVersion: string | undefined;
  let firstPrompt: string | undefined;
  let lastAssistant: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  const items: NlaThreadsHistoryItemData[] = [];

  for (const [recordIndex, record] of records.entries()) {
    const timestamp = normalizeTimestamp(record.timestamp);
    createdAt = earliestTimestamp(createdAt, timestamp);
    updatedAt = latestTimestamp(updatedAt, timestamp);

    if (record.type === "session_meta") {
      const payload = recordValue(record.payload);
      sessionId = stringValue(payload?.id) ?? sessionId;
      cwd = cwd ?? stringValue(payload?.cwd);
      source = source ?? sourceText(payload?.source);
      cliVersion = cliVersion ?? stringValue(payload?.cli_version) ?? stringValue(payload?.cliVersion);
      createdAt = earliestTimestamp(createdAt, normalizeTimestamp(payload?.timestamp));
      updatedAt = latestTimestamp(updatedAt, normalizeTimestamp(payload?.timestamp));
      continue;
    }

    if (record.type === "turn_context") {
      cwd = cwd ?? stringValue(record.cwd);
      continue;
    }

    const payload = recordValue(record.payload);
    if (record.type !== "response_item" || !payload) {
      continue;
    }

    const item = historyItemFromResponseItem(payload, timestamp, recordIndex);
    if (!item) {
      continue;
    }

    items.push(item);
    if (!firstPrompt && item.role === "user" && item.text) {
      firstPrompt = item.text;
    }
    if (item.role === "assistant" && item.text) {
      lastAssistant = item.text;
    }
  }

  const fileInfo = await stat(filePath).catch(() => undefined);
  updatedAt = latestTimestamp(updatedAt, fileInfo?.mtime.toISOString());
  createdAt = createdAt ?? fileInfo?.birthtime.toISOString();

  const threadRef = sessionId || fileNameRef;
  if (!threadRef) {
    return undefined;
  }

  return {
    filePath,
    fileNameRef,
    threadRef,
    sessionId,
    cwd,
    source,
    cliVersion,
    firstPrompt,
    summary: lastAssistant ? truncate(firstLine(lastAssistant) ?? lastAssistant, 200) : undefined,
    createdAt,
    updatedAt,
    messageCount: items.length,
    items
  };
};

const historyItemFromResponseItem = (
  item: Record<string, unknown>,
  timestamp: string | undefined,
  index: number
): NlaThreadsHistoryItemData | undefined => {
  if (item.type !== "message") {
    return undefined;
  }

  const role = messageRole(item.role);
  if (!role) {
    return undefined;
  }

  const text = textFromContent(item.content);
  if (!text || (role === "user" && isInternalUserMessage(text))) {
    return undefined;
  }

  return {
    itemId: stringValue(item.id) ?? `codex-history-${index}`,
    kind: "message",
    role,
    text,
    createdAt: timestamp,
    metadata: compactRecord({
      codexType: item.type,
      phase: stringValue(item.phase)
    })
  };
};

const messageRole = (value: unknown): NlaMessageRole | undefined => {
  switch (stringValue(value)) {
    case "user":
    case "assistant":
    case "system":
      return stringValue(value) as NlaMessageRole;
    default:
      return undefined;
  }
};

const textFromContent = (content: unknown): string | undefined => {
  if (!Array.isArray(content)) {
    return stringValue(content);
  }

  const parts = content.flatMap((entry) => {
    const item = recordValue(entry);
    if (!item) {
      return [];
    }

    switch (item.type) {
      case "input_text":
      case "output_text":
      case "text": {
        const text = stringValue(item.text);
        return text ? [text] : [];
      }
      default:
        return [];
    }
  });

  return parts.length > 0 ? parts.join("\n\n") : undefined;
};

const isInternalUserMessage = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<apps_instructions>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<plugins_instructions>") ||
    trimmed.startsWith("<collaboration_mode>");
};

const sessionIdFromFileName = (fileNameRef: string): string | undefined => {
  const match = fileNameRef.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1];
};

const titleForTranscript = (transcript: CodexTranscript): string | undefined => {
  const text = firstLine(transcript.firstPrompt) ?? firstLine(transcript.summary);
  return text ? truncate(text, 80) : undefined;
};

const firstLine = (value: string | undefined): string | undefined =>
  value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);

const matchesScope = (
  transcript: CodexTranscript,
  scope: NlaThreadScope | undefined
): boolean => {
  if (!scope?.cwd || scope.includeAllDirectories) {
    return true;
  }

  if (!transcript.cwd) {
    return true;
  }

  return normalizePath(transcript.cwd) === normalizePath(scope.cwd);
};

const transcriptMatches = (
  transcript: CodexTranscript,
  threadRef: string
): boolean =>
  transcript.threadRef === threadRef ||
  transcript.sessionId === threadRef ||
  transcript.fileNameRef === threadRef ||
  path.resolve(transcript.filePath) === path.resolve(threadRef);

const compareTranscripts = (
  left: CodexTranscript,
  right: CodexTranscript
): number =>
  Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "");

const paginate = <T>(
  items: ReadonlyArray<T>,
  cursor: string | undefined,
  requestedLimit: number | undefined
): {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor?: string;
} => {
  const offset = readCursor(cursor);
  const limit = readLimit(requestedLimit);
  const nextOffset = offset + limit;
  return {
    items: items.slice(offset, nextOffset),
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined
  };
};

const readLimit = (value: number | undefined): number =>
  Math.min(
    MaxLimit,
    Math.max(1, Math.floor(value ?? DefaultLimit))
  );

const readCursor = (value: string | undefined): number => {
  if (!value) {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeTimestamp = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  const text = stringValue(value);
  if (!text) {
    return undefined;
  }

  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : text;
};

const earliestTimestamp = (
  left: string | undefined,
  right: string | undefined
): string | undefined => {
  if (!left) return right;
  if (!right) return left;
  return compareTimestamps(left, right) <= 0 ? left : right;
};

const latestTimestamp = (
  left: string | undefined,
  right: string | undefined
): string | undefined => {
  if (!left) return right;
  if (!right) return left;
  return compareTimestamps(left, right) >= 0 ? left : right;
};

const compareTimestamps = (left: string, right: string): number =>
  Date.parse(left) - Date.parse(right);

const sourceText = (value: unknown): string | undefined => {
  const direct = stringValue(value);
  if (direct) {
    return direct;
  }

  const record = recordValue(value);
  return record ? JSON.stringify(record) : undefined;
};

const normalizePath = (value: string): string =>
  path.resolve(value);

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}...` : value;

const compactRecord = (
  value: Record<string, unknown>
): Record<string, unknown> | undefined => {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const isMissingPathError = (error: unknown): boolean =>
  recordValue(error)?.code === "ENOENT";
