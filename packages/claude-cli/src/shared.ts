export type UnknownRecord = Record<string, unknown>;

export const recordValue = (value: unknown): UnknownRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;

export const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value
    : undefined;

export const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean"
    ? value
    : undefined;

export const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;

export const compactObject = <T extends UnknownRecord>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;

export const truncate = (value: unknown, maxLength = 120): string | undefined => {
  const text = stringValue(value);
  if (!text) return undefined;
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
};

export const parseJsonObject = (value: string): UnknownRecord | undefined => {
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return undefined;
  }
};

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

export const previewJson = (value: unknown, maxLength = 600): string | undefined => {
  try {
    const text = JSON.stringify(value, null, 2);
    if (!text || text === "{}") {
      return undefined;
    }
    return text.length <= maxLength
      ? text
      : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
  } catch {
    return undefined;
  }
};
