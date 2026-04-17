import type { NlaInteractionPayload } from "@nla/protocol";
import type { CodexAppServerRequestMessage } from "./appServerClient.js";
import { recordValue, stringValue } from "./shared.js";
import type { CodexInputResolution, PendingInputRequest } from "./types.js";

export const buildPendingInputRequest = (
  request: CodexAppServerRequestMessage,
  sessionId: string
): PendingInputRequest | undefined => {
  const params = recordValue(request.params);
  switch (request.method) {
    case "item/tool/requestUserInput": {
      const questions = Array.isArray(params?.questions)
        ? params.questions.flatMap((entry) => {
            const question = recordValue(entry);
            return question ? [question] : [];
          })
        : [];
      const firstQuestion = questions[0];
      const firstOptions = Array.isArray(firstQuestion?.options)
        ? firstQuestion.options.flatMap((entry, index) => {
            const option = recordValue(entry);
            const label = stringValue(option?.label);
            return label
              ? [
                  {
                    id: `option_${index + 1}`,
                    label
                  }
                ]
              : [];
          })
        : [];
      const options = firstOptions.length > 0
        ? firstOptions
        : [
            {
              id: "submit",
              label: "Submit"
            }
          ];

      return {
        requestId: `${sessionId}:${String(request.id)}`,
        rpcId: request.id,
        method: request.method,
        waitStatus: "awaiting_input",
        input: {
          kind: "form",
          requestId: `${sessionId}:${String(request.id)}`,
          title: stringValue(firstQuestion?.header) ?? "Codex requires input",
          body: questions
            .map((question) => [stringValue(question.header), stringValue(question.question)].filter(Boolean).join(": "))
            .filter(Boolean)
            .join("\n"),
          questions: [
            {
              id: `${sessionId}:${String(request.id)}`,
              title: stringValue(firstQuestion?.header) ?? "Response",
              body: stringValue(firstQuestion?.question),
              allowsText: true,
              options: options.map((option, index) => ({
                id: option.id,
                label: option.label,
                style: index === 0 ? "primary" : "secondary"
              }))
            }
          ]
        },
        optionLabels: new Map(options.map((option) => [option.id, option.label])),
        questionIds: questions.map((question) => stringValue(question.id) ?? "response")
      };
    }
    case "item/commandExecution/requestApproval":
      return {
        requestId: `${sessionId}:${String(request.id)}`,
        rpcId: request.id,
        method: request.method,
        waitStatus: "awaiting_approval",
        input: {
          kind: "approval",
          requestId: `${sessionId}:${String(request.id)}`,
          title: "Approve Codex command",
          body: stringValue(params?.command) ?? stringValue(params?.reason),
          options: [
            {
              id: "accept",
              label: "Accept",
              style: "primary"
            },
            {
              id: "accept_for_session",
              label: "Accept For Session"
            },
            {
              id: "decline",
              label: "Decline",
              style: "destructive"
            },
            {
              id: "cancel",
              label: "Cancel"
            }
          ]
        }
      };
    case "item/fileChange/requestApproval":
      return {
        requestId: `${sessionId}:${String(request.id)}`,
        rpcId: request.id,
        method: request.method,
        waitStatus: "awaiting_approval",
        input: {
          kind: "approval",
          requestId: `${sessionId}:${String(request.id)}`,
          title: "Approve Codex file changes",
          body: stringValue(params?.reason),
          options: [
            {
              id: "accept",
              label: "Accept",
              style: "primary"
            },
            {
              id: "accept_for_session",
              label: "Accept For Session"
            },
            {
              id: "decline",
              label: "Decline",
              style: "destructive"
            },
            {
              id: "cancel",
              label: "Cancel"
            }
          ]
        }
      };
    case "mcpServer/elicitation/request":
      return {
        requestId: `${sessionId}:${String(request.id)}`,
        rpcId: request.id,
        method: request.method,
        waitStatus: "awaiting_approval",
        input: {
          kind: "approval",
          requestId: `${sessionId}:${String(request.id)}`,
          title: "Codex MCP elicitation",
          body: stringValue(params?.message),
          options: [
            {
              id: "accept",
              label: "Accept",
              style: "primary"
            },
            {
              id: "decline",
              label: "Decline",
              style: "destructive"
            },
            {
              id: "cancel",
              label: "Cancel"
            }
          ]
        }
      };
    default:
      return undefined;
  }
};

export const buildCodexResolution = (
  pending: PendingInputRequest,
  resolution: NlaInteractionPayload
): CodexInputResolution => {
  const record = recordValue(resolution) ?? {};
  const optionId = stringValue(record.optionId);
  const text = stringValue(record.text);
  return {
    optionId,
    text,
    value: resolution,
    payload: {
      kind: typeof resolution.kind === "string" ? resolution.kind : pending.input.kind,
      requestId: pending.requestId,
      ...(optionId ? { optionId } : {}),
      ...(text ? { text } : {}),
      value: resolution
    }
  };
};

export const buildInputResponse = (
  pending: PendingInputRequest,
  resolution: CodexInputResolution
): unknown => {
  switch (pending.method) {
    case "item/tool/requestUserInput": {
      const labelAnswer = resolution.optionId
        ? pending.optionLabels?.get(resolution.optionId)
        : undefined;
      const answer = resolution.text || labelAnswer || "Submit";
      const questionIds = pending.questionIds?.length
        ? pending.questionIds
        : ["response"];

      return {
        answers: Object.fromEntries(
          questionIds.map((questionId) => [
            questionId,
            {
              answers: [answer]
            }
          ])
        )
      };
    }
    case "item/commandExecution/requestApproval":
      return {
        decision: approvalDecision(resolution.optionId, true)
      };
    case "item/fileChange/requestApproval":
      return {
        decision: approvalDecision(resolution.optionId, false)
      };
    case "mcpServer/elicitation/request":
      return {
        action: elicitationAction(resolution.optionId),
        content: resolution.text ?? null,
        _meta: null
      };
    default:
      return {};
  }
};

const approvalDecision = (
  optionId: string | undefined,
  allowSession: boolean
): "accept" | "acceptForSession" | "decline" | "cancel" => {
  switch (optionId) {
    case "accept_for_session":
      return allowSession ? "acceptForSession" : "accept";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
    case "accept":
    default:
      return "accept";
  }
};

const elicitationAction = (optionId: string | undefined): "accept" | "decline" | "cancel" => {
  switch (optionId) {
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
    case "accept":
    default:
      return "accept";
  }
};
