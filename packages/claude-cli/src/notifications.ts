import { recordValue, stringValue, type UnknownRecord } from "./shared.js";
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
  const providerMessageId = stringValue(event.message_id) || stringValue(event.messageId);
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

  const contentBlock = recordValue(streamEvent?.content_block);
  if (contentBlock?.type === "tool_use") {
    const name = stringValue(contentBlock.name) || "tool";
    if (!isClaudeEditToolName(name)) {
      events.push({
        type: "activity",
        activityId: stringValue(contentBlock.id) || `claude-tool-${Date.now()}`,
        title: `Claude tool: ${name}`,
        status: "running"
      });
    }
  }

  const result = stringValue(event.result);
  if (result) {
    events.push({
      type: "assistant.final",
      text: result,
      providerMessageId
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

const isClaudeEditToolName = (name: string): boolean =>
  ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name);
