import { booleanValue, recordValue, stringValue, type UnknownRecord } from "./shared.js";
import type { ClaudeTurnEvent } from "./types.js";

export interface ParsedClaudeOutput {
  readonly claudeSessionRef?: string;
  readonly providerMessageId?: string;
  readonly events: ReadonlyArray<ClaudeTurnEvent>;
}

export const parseClaudeOutputLine = (line: string): ParsedClaudeOutput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Failed to parse Claude JSONL output: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const event = recordValue(parsed);
  if (!event) {
    throw new Error("Claude JSONL output must be a JSON object.");
  }

  return parseClaudeOutput(event);
};

const parseClaudeOutput = (event: UnknownRecord): ParsedClaudeOutput => {
  const events: ClaudeTurnEvent[] = [];
  const message = recordValue(event.message);
  const eventType = stringValue(event.type);
  const isAssistantOutput =
    eventType === "assistant" || stringValue(message?.role) === "assistant";
  const providerMessageId =
    stringValue(event.message_id) ||
    stringValue(event.messageId) ||
    stringValue(message?.id);
  const claudeSessionRef = stringValue(event.session_id) || stringValue(event.sessionId);
  const streamEvent = recordValue(event.event);
  const delta = recordValue(streamEvent?.delta);

  if (delta?.type === "text_delta") {
    const text = stringValue(delta.text);
    if (text) {
      events.push({
        type: "assistant.delta",
        delta: text,
        providerMessageId
      });
    }
  }

  const streamContentBlocks = contentBlocksFrom(streamEvent?.content_block);
  const contentBlocks = streamEvent
    ? streamContentBlocks
    : contentBlocksFrom(message?.content);
  const textChunks: string[] = [];
  const flushText = (): void => {
    if (textChunks.length === 0) {
      return;
    }

    events.push({
      type: "assistant.final",
      text: textChunks.join(""),
      providerMessageId
    });
    textChunks.length = 0;
  };

  for (const contentBlock of contentBlocks) {
    if (isAssistantOutput && contentBlock.type === "text") {
      const text = stringValue(contentBlock.text);
      if (text) {
        textChunks.push(text);
      }
      continue;
    }

    flushText();

    if (contentBlock.type === "tool_use") {
      const name = stringValue(contentBlock.name) || "tool";
      if (!isClaudeEditToolName(name)) {
        events.push({
          type: "activity",
          activityId: stringValue(contentBlock.id) || `claude-tool-${Date.now()}`,
          title: `Claude tool: ${name}`,
          status: "running"
        });
      }
      continue;
    }

    if (contentBlock.type === "tool_result") {
      const activityId =
        stringValue(contentBlock.tool_use_id) ||
        stringValue(contentBlock.toolUseId) ||
        stringValue(contentBlock.id);
      if (activityId) {
        events.push({
          type: "activity",
          activityId,
          title: "Claude tool result",
          status: isToolResultError(contentBlock) ? "failed" : "succeeded"
        });
      }
    }
  }
  flushText();

  const result = stringValue(event.result);
  if (result) {
    events.push({
      type: "assistant.final",
      text: result,
      providerMessageId,
      aggregate: true
    });
    events.push({
      type: "turn.completed",
      status: "completed"
    });
  }

  const errorMessage =
    stringValue(recordValue(event.error)?.message) ||
    (stringValue(event.type) === "error" ? stringValue(event.message) : undefined);
  if (errorMessage) {
    events.push({
      type: "turn.completed",
      status: "failed",
      message: errorMessage
    });
  }

  return {
    claudeSessionRef,
    providerMessageId,
    events
  };
};

const contentBlocksFrom = (value: unknown): ReadonlyArray<UnknownRecord> => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const block = recordValue(item);
      return block ? [block] : [];
    });
  }

  const block = recordValue(value);
  return block ? [block] : [];
};

const isToolResultError = (contentBlock: UnknownRecord): boolean =>
  booleanValue(contentBlock.is_error) === true ||
  booleanValue(contentBlock.isError) === true ||
  stringValue(contentBlock.status) === "error" ||
  stringValue(contentBlock.status) === "failed";

const isClaudeEditToolName = (name: string): boolean =>
  ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name);
