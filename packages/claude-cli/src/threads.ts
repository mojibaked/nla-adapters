import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  NlaMessageRole,
  NlaThreadScope,
  NlaThreadSummaryData,
  NlaThreadsHistoryItemData
} from "@nla/protocol";
import {
  claudeContentBlocksFrom,
  claudeHasNonTextParts,
  claudeMessagePartsFromContent,
  claudeTextFromParts
} from "./content.js";
import {
  booleanValue,
  previewJson,
  recordValue,
  stringValue,
  truncate,
  type UnknownRecord
} from "./shared.js";

const DefaultLimit = 50;
const MaxLimit = 200;
const SubagentsDirectoryName = "subagents";

interface ClaudeTranscript {
  readonly filePath: string;
  readonly fileNameRef: string;
  readonly threadRef: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly summary?: string;
  readonly firstPrompt?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly messageCount: number;
  readonly items: ReadonlyArray<NlaThreadsHistoryItemData>;
}

export const listClaudeThreads = async (input: {
  readonly configDir: string;
  readonly scope?: NlaThreadScope;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<{
  readonly threads: ReadonlyArray<NlaThreadSummaryData>;
  readonly nextCursor?: string;
}> => {
  const transcripts = uniqueTranscriptsByThreadRef(
    (await scanClaudeTranscripts(input.configDir))
      .filter((transcript) => matchesScope(transcript, input.scope))
      .sort(compareTranscripts)
  );
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
        provider: "claude.cli",
        cwd: transcript.cwd,
        transcriptPath: transcript.filePath
      })
    })),
    nextCursor: page.nextCursor
  };
};

export const getClaudeThreadHistory = async (input: {
  readonly configDir: string;
  readonly threadRef: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<{
  readonly items: ReadonlyArray<NlaThreadsHistoryItemData>;
  readonly nextCursor?: string;
}> => {
  const transcripts = await scanClaudeTranscripts(input.configDir);
  const transcript = transcripts
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

const scanClaudeTranscripts = async (
  configDir: string
): Promise<ReadonlyArray<ClaudeTranscript>> => {
  const files = await collectJsonlFiles(path.join(configDir, "projects"));
  const transcripts = await Promise.all(files.map(readClaudeTranscript));
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
      if (entry.name === SubagentsDirectoryName) {
        continue;
      }
      files.push(...await collectJsonlFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }

  return files;
};

const readClaudeTranscript = async (
  filePath: string
): Promise<ClaudeTranscript | undefined> => {
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
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let summary: string | undefined;
  let firstPrompt: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  const items: NlaThreadsHistoryItemData[] = [];

  for (const record of records) {
    sessionId =
      sessionId ||
      stringValue(record.sessionId) ||
      stringValue(record.session_id) ||
      stringValue(record.sessionID);
    cwd = cwd || stringValue(record.cwd);

    const timestamp = normalizeTimestamp(record.timestamp);
    createdAt = earliestTimestamp(createdAt, timestamp);
    updatedAt = latestTimestamp(updatedAt, timestamp);

    if (stringValue(record.summary)) {
      summary = stringValue(record.summary);
    }

    for (const item of historyItemsFromRecord(record)) {
      items.push(item);
      createdAt = earliestTimestamp(createdAt, item.createdAt);
      updatedAt = latestTimestamp(updatedAt, item.createdAt);
      if (!firstPrompt && item.kind === "message" && item.role === "user" && item.text) {
        firstPrompt = item.text;
      }
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
    summary,
    firstPrompt,
    createdAt,
    updatedAt,
    messageCount: items.filter((item) => item.kind === "message").length,
    items
  };
};

const historyItemsFromRecord = (
  record: UnknownRecord
): ReadonlyArray<NlaThreadsHistoryItemData> => {
  if (isInternalTaskNotificationRecord(record)) {
    return [];
  }

  const type = stringValue(record.type);
  const message = recordValue(record.message);
  const timestamp = normalizeTimestamp(record.timestamp);
  const itemId =
    stringValue(record.uuid) ||
    stringValue(record.id) ||
    stringValue(message?.id);

  if (type === "summary") {
    const summary = stringValue(record.summary);
    return summary
      ? [{
          itemId,
          kind: "summary",
          summary,
          createdAt: timestamp,
          metadata: compactRecord({
            claudeType: type
          })
        }]
      : [];
  }

  const role = messageRole(message, type);
  if (!role) {
    return [];
  }

  const content = message?.content ?? record.content;
  const items: NlaThreadsHistoryItemData[] = [];
  const parts = claudeMessagePartsFromContent(content);
  const text = claudeTextFromParts(parts) ?? textFromContent(content);
  if (text || parts?.length) {
    items.push({
      itemId,
      kind: "message",
      role,
      ...(text ? { text } : {}),
      ...(parts ? { parts } : {}),
      createdAt: timestamp,
      metadata: compactRecord({
        claudeType: type,
        claudeMessageId: stringValue(message?.id)
      })
    });
  }

  for (const block of claudeContentBlocksFrom(content)) {
    switch (stringValue(block.type)) {
      case "tool_use": {
        items.push({
          itemId: stringValue(block.id) ?? itemId,
          kind: "tool_call",
          role: "assistant",
          callId: stringValue(block.id),
          toolName: stringValue(block.name),
          text: previewJson(block.input),
          createdAt: timestamp,
          metadata: compactRecord({
            claudeType: type
          })
        });
        break;
      }
      case "tool_result": {
        const toolResultText = textFromToolResult(block.content);
        items.push({
          itemId: stringValue(block.id) ?? itemId,
          kind: "tool_result",
          role: "tool",
          callId:
            stringValue(block.tool_use_id) ||
            stringValue(block.toolUseId) ||
            stringValue(block.id),
          text: toolResultText,
          createdAt: timestamp,
          metadata: compactRecord({
            claudeType: type,
            isError: booleanValue(block.is_error) ?? booleanValue(block.isError)
          })
        });
        break;
      }
      default:
        break;
    }
  }

  return items;
};

const messageRole = (
  message: UnknownRecord | undefined,
  type: string | undefined
): NlaMessageRole | undefined => {
  const role = stringValue(message?.role);
  if (role) {
    return role;
  }

  return type === "user" || type === "assistant" || type === "system"
    ? type
    : undefined;
};

const textFromContent = (content: unknown): string | undefined => {
  const direct = stringValue(content);
  return direct ?? claudeTextFromParts(claudeMessagePartsFromContent(content));
};

const textFromToolResult = (content: unknown): string | undefined =>
  textFromContent(content) ?? stringValue(content);

const isInternalTaskNotificationRecord = (record: UnknownRecord): boolean => {
  const origin = recordValue(record.origin);
  if (stringValue(origin?.kind) === "task-notification") {
    return true;
  }

  const attachment = recordValue(record.attachment);
  if (stringValue(attachment?.commandMode) === "task-notification") {
    return true;
  }

  const message = recordValue(record.message);
  return isTaskNotificationContent(message?.content ?? record.content);
};

const isTaskNotificationContent = (content: unknown): boolean => {
  const parts = claudeMessagePartsFromContent(content);
  const text = textFromContent(content) ?? stringValue(content);
  return !claudeHasNonTextParts(parts) && text?.trim().startsWith("<task-notification") === true;
};

const titleForTranscript = (transcript: ClaudeTranscript): string | undefined => {
  const text = firstLine(transcript.firstPrompt) ?? firstLine(transcript.summary);
  return text ? truncate(text, 80) : undefined;
};

const firstLine = (value: string | undefined): string | undefined =>
  value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);

const matchesScope = (
  transcript: ClaudeTranscript,
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
  transcript: ClaudeTranscript,
  threadRef: string
): boolean =>
  transcript.threadRef === threadRef ||
  transcript.sessionId === threadRef ||
  transcript.fileNameRef === threadRef;

const compareTranscripts = (
  left: ClaudeTranscript,
  right: ClaudeTranscript
): number =>
  Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "");

const uniqueTranscriptsByThreadRef = (
  transcripts: ReadonlyArray<ClaudeTranscript>
): ReadonlyArray<ClaudeTranscript> => {
  const seen = new Set<string>();
  return transcripts.filter((transcript) => {
    if (seen.has(transcript.threadRef)) {
      return false;
    }
    seen.add(transcript.threadRef);
    return true;
  });
};

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

const normalizePath = (value: string): string =>
  path.resolve(value);

const compactRecord = (
  value: Record<string, unknown>
): Record<string, unknown> | undefined => {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const isMissingPathError = (error: unknown): boolean =>
  recordValue(error)?.code === "ENOENT";
