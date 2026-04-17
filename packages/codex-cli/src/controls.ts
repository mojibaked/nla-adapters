import type { NlaSessionControlDefinition } from "@nla/protocol";
import type {
  CodexApprovalMode,
  CodexRuntimeSettings,
  CodexSandboxMode
} from "./types.js";

export const codexSessionControls = (
  settings: CodexRuntimeSettings
): ReadonlyArray<NlaSessionControlDefinition> => [
  {
    id: "approval_mode",
    kind: "select",
    label: "Approval Mode",
    description: "Controls when Codex asks for approval before executing commands.",
    placement: "header",
    applyMode: "next_turn",
    value: settings.approvalMode,
    options: [
      {
        id: "untrusted",
        label: "Untrusted"
      },
      {
        id: "on-request",
        label: "On Request"
      },
      {
        id: "on-failure",
        label: "On Failure"
      },
      {
        id: "never",
        label: "Never"
      }
    ]
  },
  {
    id: "sandbox_mode",
    kind: "select",
    label: "Sandbox",
    description: "Controls the filesystem sandbox used for the next Codex thread.",
    placement: "sheet",
    applyMode: "next_turn",
    value: settings.sandboxMode,
    options: [
      {
        id: "read-only",
        label: "Read Only"
      },
      {
        id: "workspace-write",
        label: "Workspace Write"
      },
      {
        id: "danger-full-access",
        label: "Danger Full Access"
      }
    ]
  }
];

export const parseCodexApprovalMode = (
  value: string | undefined
): CodexApprovalMode | undefined => {
  const normalized = value?.trim();

  switch (normalized) {
    case "untrusted":
    case "on-failure":
    case "on-request":
    case "never":
      return normalized;
    default:
      return undefined;
  }
};

export const parseCodexSandboxMode = (
  value: string | undefined
): CodexSandboxMode | undefined => {
  const normalized = value?.trim();

  switch (normalized) {
    case "read-only":
    case "workspace-write":
    case "danger-full-access":
      return normalized;
    default:
      return undefined;
  }
};
