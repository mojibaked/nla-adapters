import type { NlaSessionToolContextBase } from "@nla/sdk-core";
import type { NlaSessionControlDefinition } from "@nla/protocol";

export type AutotraderApprovalMode = "never" | "actions";
export type AutotraderToolName =
  | "navigate"
  | "snapshot"
  | "get_text"
  | "get_html"
  | "list_media_urls"
  | "click"
  | "fill"
  | "select_option"
  | "press_key"
  | "scroll"
  | "wait_for"
  | "save_listings"
  | "list_stored_listings"
  | "get_stored_listing"
  | "find_stale_listings";

export interface AutotraderApprovalRejectedResult {
  readonly ok: false;
  readonly status: "rejected";
  readonly message: string;
}

export type AutotraderToolApproval =
  | { readonly status: "approved" }
  | AutotraderApprovalRejectedResult;

export const AutotraderApprovalModeStateKey = "autotraderApprovalMode";
export const DefaultAutotraderApprovalMode: AutotraderApprovalMode = "actions";

export const autotraderSessionControls = (
  approvalMode: AutotraderApprovalMode
): ReadonlyArray<NlaSessionControlDefinition> => [
  {
    id: "approval_mode",
    kind: "select",
    label: "Approval",
    description: "Controls when Autotrader asks for approval before each tool call.",
    placement: "header",
    applyMode: "next_turn",
    value: approvalMode,
    options: [
      {
        id: "actions",
        label: "Each Tool"
      },
      {
        id: "never",
        label: "Never"
      }
    ]
  }
];

export const parseAutotraderApprovalMode = (
  value: string | undefined
): AutotraderApprovalMode | undefined => {
  switch (value?.trim()) {
    case "never":
    case "actions":
      return value.trim() as AutotraderApprovalMode;
    default:
      return undefined;
  }
};

export const getAutotraderApprovalMode = (
  state: Record<string, unknown> | undefined,
  fallback: AutotraderApprovalMode = DefaultAutotraderApprovalMode
): AutotraderApprovalMode => {
  const mode = parseAutotraderApprovalMode(
    typeof state?.[AutotraderApprovalModeStateKey] === "string"
      ? state[AutotraderApprovalModeStateKey] as string
      : undefined
  );
  return mode ?? fallback;
};

export const withAutotraderApprovalModeState = (
  state: Record<string, unknown> | undefined,
  approvalMode: AutotraderApprovalMode
): Record<string, unknown> => ({
  ...(state ?? {}),
  [AutotraderApprovalModeStateKey]: approvalMode
});

export const requestAutotraderToolApproval = async (
  context: Pick<NlaSessionToolContextBase, "session" | "raw" | "awaitInput">,
  toolName: AutotraderToolName,
  details: Readonly<Record<string, unknown>>
): Promise<AutotraderToolApproval> => {
  const approvalMode = getAutotraderApprovalMode(context.session.state, "never");
  if (approvalMode === "never") {
    return {
      status: "approved"
    };
  }

  const requestId = context.raw.createId("approval");
  const { resolution } = await context.awaitInput({
    kind: "approval",
    requestId,
    title: `Allow tool: ${toolName}?`,
    body: "Autotrader Agent wants to run a tool.",
    options: [
      {
        id: "approve",
        label: "Approve",
        style: "primary"
      },
      {
        id: "reject",
        label: "Reject",
        style: "destructive"
      }
    ],
    details: {
      toolName,
      approvalMode,
      ...details
    }
  });

  if (optionIdFromResolution(resolution) === "approve") {
    return {
      status: "approved"
    };
  }

  return {
    ok: false,
    status: "rejected",
    message: `User rejected ${toolName}.`
  };
};

const optionIdFromResolution = (resolution: unknown): string | undefined => {
  const record =
    resolution && typeof resolution === "object" && !Array.isArray(resolution)
      ? (resolution as Record<string, unknown>)
      : undefined;
  const value = record?.optionId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
