import { recordValue, stringValue } from "./shared.js";

export const codexActivityFromItem = (
  item: Record<string, unknown>,
  started: boolean
): {
  readonly activityId: string;
  readonly title: string;
  readonly status: "running" | "succeeded" | "failed";
} | undefined => {
  const type = stringValue(item.type);
  const activityId = stringValue(item.id) ?? `codex-item-${Date.now()}`;
  const status = started ? "running" : activityStatus(item.status);

  switch (type) {
    case "commandExecution":
      return {
        activityId,
        title: `Codex command: ${stringValue(item.command) ?? "shell"}`,
        status
      };
    case "dynamicToolCall":
      return {
        activityId,
        title: `Codex tool: ${stringValue(item.tool) ?? "tool"}`,
        status
      };
    case "mcpToolCall":
      return {
        activityId,
        title: `Codex MCP: ${stringValue(item.server) ?? "server"}.${stringValue(item.tool) ?? "tool"}`,
        status
      };
    case "webSearch":
      return {
        activityId,
        title: `Codex search: ${stringValue(item.query) ?? "web"}`,
        status
      };
    case "fileChange":
      return {
        activityId,
        title: "Codex file changes",
        status
      };
    default:
      return undefined;
  }
};

export const assistantTextFromItem = (item: Record<string, unknown>): string | undefined =>
  stringValue(item.type) === "agentMessage"
    ? stringValue(item.text)
    : undefined;

export const turnErrorMessage = (turn: Record<string, unknown> | undefined): string | undefined => {
  const error = recordValue(turn?.error);
  return stringValue(error?.message) ?? stringValue(error?.additionalDetails);
};

const activityStatus = (value: unknown): "succeeded" | "failed" =>
  stringValue(value) === "failed" || stringValue(value) === "declined"
    ? "failed"
    : "succeeded";
