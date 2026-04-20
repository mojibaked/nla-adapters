import type { NlaSessionMessagePart } from "@nla/protocol";
import { recordValue, stringValue } from "./shared.js";

export const codexMessagePartsFromValue = (
  value: unknown
): NlaSessionMessagePart[] | undefined => {
  const records = codexContentRecords(value);
  if (records.length === 0) {
    return undefined;
  }

  const parts = records.flatMap((record) => {
    const part = codexMessagePartFromRecord(record);
    return part ? [part] : [];
  });

  return parts.length > 0
    ? parts
    : undefined;
};

export const codexTextFromParts = (
  parts: ReadonlyArray<NlaSessionMessagePart> | undefined
): string | undefined => {
  if (!parts || parts.length === 0) {
    return undefined;
  }

  const text = parts.flatMap((part) => {
    const value = part.type === "text"
      ? stringValue(part.text)
      : undefined;
    return value ? [value] : [];
  }).join("\n\n");

  return text || undefined;
};

export const codexHasNonTextParts = (
  parts: ReadonlyArray<NlaSessionMessagePart> | undefined
): boolean =>
  parts?.some((part) => part.type !== "text") === true;

export const codexTextParts = (
  text: string | undefined
): NlaSessionMessagePart[] | undefined => {
  const value = stringValue(text);
  return value
    ? [{
        type: "text",
        text: value
      }]
    : undefined;
};

const codexContentRecords = (
  value: unknown
): ReadonlyArray<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = recordValue(entry);
      return record ? [record] : [];
    });
  }

  const record = recordValue(value);
  if (!record) {
    return [];
  }

  const nested = codexContentRecords(record.parts ?? record.content);
  return nested.length > 0 ? nested : [record];
};

const codexMessagePartFromRecord = (
  record: Record<string, unknown>
): NlaSessionMessagePart | undefined => {
  const type = stringValue(record.type);
  switch (type) {
    case "input_text":
    case "output_text":
    case "text": {
      const text = stringValue(record.text);
      return text
        ? {
            type: "text",
            text
          }
        : undefined;
    }
    case "input_image":
    case "output_image":
    case "image": {
      const url = stringValue(record.image_url) ?? stringValue(record.imageUrl) ?? stringValue(record.url);
      const mediaType = mediaTypeFromImageValue(url) ?? stringValue(record.media_type) ?? stringValue(record.mediaType);
      const alt = stringValue(record.alt) ?? stringValue(record.label);

      return compactPart({
        type: "image",
        url,
        mediaType,
        alt,
        providerType: type
      });
    }
    default:
      return undefined;
  }
};

const mediaTypeFromImageValue = (value: string | undefined): string | undefined => {
  if (!value?.startsWith("data:")) {
    return undefined;
  }

  const match = value.match(/^data:([^;,]+)[;,]/i);
  return match?.[1];
};

const compactPart = (
  value: NlaSessionMessagePart
): NlaSessionMessagePart =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as NlaSessionMessagePart;
