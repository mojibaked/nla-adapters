import { recordValue, stringValue } from "./shared.js";

export type CodexActivityStatus = "running" | "succeeded" | "failed";

export interface CodexActivity {
  readonly activityId: string;
  readonly title: string;
  readonly status: CodexActivityStatus;
}

export interface CodexExplorationAction {
  readonly verb: "Read" | "List" | "Search";
  readonly label: string;
}

export interface CodexExplorationItem {
  readonly itemId: string;
  readonly actions: ReadonlyArray<CodexExplorationAction>;
  readonly status: CodexActivityStatus;
}

export interface CodexReasoningSummaryDelta {
  readonly itemId: string;
  readonly summaryIndex: number;
  readonly delta: string;
}

export const codexActivityFromItem = (
  item: Record<string, unknown>,
  started: boolean
): CodexActivity | undefined => {
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

export const codexExplorationFromItem = (
  item: Record<string, unknown>,
  started: boolean
): CodexExplorationItem | undefined => {
  if (stringValue(item.type) !== "commandExecution") {
    return undefined;
  }

  const itemId = stringValue(item.id) ?? `codex-item-${Date.now()}`;
  const actions = commandActions(item.commandActions);
  if (!actions || actions.length === 0) {
    return undefined;
  }

  return {
    itemId,
    actions,
    status: started ? "running" : activityStatus(item.status)
  };
};

export const codexExplorationTitle = (
  actions: ReadonlyArray<CodexExplorationAction>,
  status: CodexActivityStatus
): string => {
  const prefix = status === "running"
    ? "Exploring"
    : status === "failed"
      ? "Exploration failed"
      : "Explored";
  const details = explorationDetails(actions);

  return details ? `${prefix}: ${details}` : prefix;
};

export const codexReasoningSummaryFromItem = (
  item: Record<string, unknown>
): string | undefined => {
  if (stringValue(item.type) !== "reasoning") {
    return undefined;
  }

  return summaryText(item.summary);
};

export const codexReasoningSummaryDeltaFromParams = (
  params: Record<string, unknown> | undefined
): CodexReasoningSummaryDelta | undefined => {
  const itemId = stringValue(params?.itemId) ?? stringValue(params?.item_id);
  const delta = stringValue(params?.delta);
  const summaryIndex = numberValue(params?.summaryIndex) ?? numberValue(params?.summary_index) ?? 0;

  return itemId && delta
    ? {
        itemId,
        summaryIndex,
        delta
      }
    : undefined;
};

export const codexReasoningActivityId = (itemId: string): string => `codex-reasoning:${itemId}`;

export const codexReasoningTitle = (
  summary: string,
  status: CodexActivityStatus
): string => {
  const prefix = status === "running"
    ? "Thinking"
    : status === "failed"
      ? "Thinking failed"
      : "Thought";
  const compact = compactLabel(summary);

  return compact ? `${prefix}: ${compact}` : prefix;
};

export const assistantTextFromItem = (item: Record<string, unknown>): string | undefined =>
  stringValue(item.type) === "agentMessage"
    ? stringValue(item.text)
    : undefined;

export const itemId = (item: Record<string, unknown> | undefined): string | undefined =>
  stringValue(item?.id) ?? stringValue(item?.itemId) ?? stringValue(item?.item_id);

export const agentMessageDeltaId = (params: Record<string, unknown> | undefined): string | undefined => {
  const item = recordValue(params?.item);
  return stringValue(params?.itemId)
    ?? stringValue(params?.item_id)
    ?? stringValue(params?.id)
    ?? itemId(item);
};

export const turnErrorMessage = (turn: Record<string, unknown> | undefined): string | undefined => {
  const error = recordValue(turn?.error);
  return stringValue(error?.message) ?? stringValue(error?.additionalDetails);
};

const activityStatus = (value: unknown): "succeeded" | "failed" =>
  stringValue(value) === "failed" || stringValue(value) === "declined"
    ? "failed"
    : "succeeded";

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

const summaryText = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const summary = value
    .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    .map((entry) => entry.trim())
    .join(" ");

  return summary || undefined;
};

const commandActions = (
  value: unknown
): ReadonlyArray<CodexExplorationAction> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const actions: CodexExplorationAction[] = [];
  for (const entry of value) {
    const action = commandAction(entry);
    if (!action) {
      return undefined;
    }
    actions.push(action);
  }
  return actions;
};

const commandAction = (value: unknown): CodexExplorationAction | undefined => {
  const record = recordValue(value);
  const type = stringValue(record?.type);

  switch (type) {
    case "read":
      return {
        verb: "Read",
        label: compactLabel(
          stringValue(record?.name)
            ?? fileName(stringValue(record?.path))
            ?? stringValue(record?.command)
            ?? "file"
        )
      };
    case "listFiles":
    case "list_files":
      return {
        verb: "List",
        label: compactLabel(
          stringValue(record?.path)
            ?? stringValue(record?.command)
            ?? "files"
        )
      };
    case "search": {
      const query = stringValue(record?.query);
      const path = stringValue(record?.path);
      return {
        verb: "Search",
        label: compactLabel(
          query && path
            ? `${query} in ${path}`
            : query ?? path ?? stringValue(record?.command) ?? "workspace"
        )
      };
    }
    default:
      return undefined;
  }
};

const explorationDetails = (
  actions: ReadonlyArray<CodexExplorationAction>
): string => {
  const maxShown = 4;
  const uniqueActions: CodexExplorationAction[] = [];
  const seen = new Set<string>();

  for (const action of actions) {
    const key = `${action.verb}:${action.label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueActions.push(action);
  }

  const shown = uniqueActions.slice(0, maxShown);
  const grouped = new Map<CodexExplorationAction["verb"], string[]>();
  for (const action of shown) {
    grouped.set(action.verb, [...(grouped.get(action.verb) ?? []), action.label]);
  }

  const parts = [...grouped.entries()].map(([verb, labels]) => `${verb} ${labels.join(", ")}`);
  const omitted = uniqueActions.length - shown.length;
  if (omitted > 0) {
    parts.push(`+${omitted} more`);
  }

  return parts.join("; ");
};

const compactLabel = (value: string): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 64 ? `${compact.slice(0, 61)}...` : compact;
};

const fileName = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
};
