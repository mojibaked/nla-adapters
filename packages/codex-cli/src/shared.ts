import { CodexAdapterError } from "./types.js";

export const metadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
};

export const toError = (error: unknown): CodexAdapterError =>
  error instanceof CodexAdapterError
    ? error
    : new CodexAdapterError(error instanceof Error ? error.message : String(error));

export const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;

export const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value
    : undefined;

export const readThreadId = (value: unknown): string | undefined => {
  const record = recordValue(value);
  const thread = recordValue(record?.thread);
  return stringValue(thread?.id) ?? stringValue(record?.id);
};

export const readTurnId = (value: unknown): string | undefined => {
  const record = recordValue(value);
  const turn = recordValue(record?.turn);
  return stringValue(turn?.id) ?? stringValue(record?.turnId);
};

export const mainActivityId = (sessionId: string): string => `codex:${sessionId}`;
