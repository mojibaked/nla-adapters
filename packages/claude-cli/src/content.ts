import type { NlaSessionMessagePart } from "@nla/protocol";
import {
  recordValue,
  stringValue,
  type UnknownRecord
} from "./shared.js";

export const claudeContentBlocksFrom = (
  value: unknown
): ReadonlyArray<UnknownRecord> => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const block = recordValue(item);
      return block ? [block] : [];
    });
  }

  const block = recordValue(value);
  return block ? [block] : [];
};

export const claudeMessagePartsFromContent = (
  content: unknown
): NlaSessionMessagePart[] | undefined => {
  const parts = claudeContentBlocksFrom(content).flatMap((block) => {
    const part = claudeMessagePartFromBlock(block);
    return part ? [part] : [];
  });

  return parts.length > 0
    ? parts
    : undefined;
};

export const claudeTextFromParts = (
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

export const claudeHasNonTextParts = (
  parts: ReadonlyArray<NlaSessionMessagePart> | undefined
): boolean =>
  parts?.some((part) => part.type !== "text") === true;

export const claudeTextParts = (
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

const claudeMessagePartFromBlock = (
  block: UnknownRecord
): NlaSessionMessagePart | undefined => {
  switch (stringValue(block.type)) {
    case "text": {
      const text = stringValue(block.text);
      return text
        ? {
            type: "text",
            text
          }
        : undefined;
    }
    case "image": {
      const source = recordValue(block.source);
      const url = stringValue(block.url) ?? stringValue(source?.url);
      const data = stringValue(block.data) ?? stringValue(source?.data);
      const mediaType =
        stringValue(block.media_type)
        ?? stringValue(block.mediaType)
        ?? stringValue(source?.media_type)
        ?? stringValue(source?.mediaType);
      const sourceType = stringValue(source?.type);

      return compactPart({
        type: "image",
        url,
        data,
        mediaType,
        sourceType
      });
    }
    default:
      return undefined;
  }
};

const compactPart = (
  value: NlaSessionMessagePart
): NlaSessionMessagePart =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as NlaSessionMessagePart;
