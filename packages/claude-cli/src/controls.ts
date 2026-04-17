import type { NlaSessionControlDefinition } from "@nla/protocol";
import type { ClaudeRuntimeSettings } from "./types.js";
import type { ClaudePermissionMode } from "./permissionBridge.js";

export const claudeSessionControls = (
  settings: ClaudeRuntimeSettings
): ReadonlyArray<NlaSessionControlDefinition> => [
  {
    id: "permission_mode",
    kind: "select",
    label: "Mode",
    description: "Controls how the Claude adapter handles approval prompts.",
    placement: "header",
    applyMode: "immediate",
    value: settings.permissionMode,
    options: [
      {
        id: "default",
        label: "Default"
      },
      {
        id: "acceptEdits",
        label: "Accept Edits"
      },
      {
        id: "plan",
        label: "Plan"
      }
    ]
  }
];

export const parseClaudePermissionMode = (
  value: string | undefined
): ClaudePermissionMode | undefined => {
  switch (value?.trim()) {
    case "default":
    case "acceptEdits":
    case "plan":
      return value.trim() as ClaudePermissionMode;
    default:
      return undefined;
  }
};

export const claudePermissionModeLabel = (mode: ClaudePermissionMode): string => {
  switch (mode) {
    case "acceptEdits":
      return "Accept Edits";
    case "plan":
      return "Plan";
    case "default":
    default:
      return "Default";
  }
};
