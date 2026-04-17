import path from "node:path";
import * as Effect from "effect/Effect";
import type { AssetCapabilityClient } from "@nla-adapters/contracts";
import type { NlaInteractionPayload, NlaSessionMessage, NlaSessionMessagePart } from "@nla/protocol";
import { previewJson, recordValue, stringValue, type UnknownRecord } from "./shared.js";
import {
  ClaudeAdapterError,
  type ClaudeAdapterDependencies,
  type PendingClaudeApprovalInput,
  type PendingClaudeQuestionInput
} from "./types.js";
import type { ClaudePermissionResult } from "./permissionBridge.js";

export const prepareClaudePrompt = (
  dependencies: ClaudeAdapterDependencies,
  input: Pick<NlaSessionMessage["data"], "parts" | "text">,
  cwd: string = process.cwd()
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const parts = nlaSessionMessageParts(input);
    const segments = yield* Effect.forEach(
      parts,
      (part) => promptSegmentFromPart(dependencies, part, cwd),
      {
        concurrency: "unbounded"
      }
    );
    const text = segments.filter(Boolean).join("\n\n").trim();
    if (!text) {
      return yield* Effect.fail(new ClaudeAdapterError(
        "Claude input must include non-empty text content",
        "claude_empty_input"
      ));
    }
    return text;
  });

export const buildClaudeApprovalRequest = (input: {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolUseId?: string;
  readonly permissionRequest: UnknownRecord;
}): NlaInteractionPayload => ({
  kind: "approval",
  requestId: input.requestId,
  title: `Allow Claude ${input.toolName}?`,
  body: permissionBody(input.toolName, input.toolInput),
  options: [
    {
      id: "approve",
      label: "Approve",
      style: "primary"
    },
    {
      id: "deny",
      label: "Deny",
      style: "destructive"
    }
  ],
  details: {
    provider: "claude",
    toolName: input.toolName,
    toolInput: input.toolInput,
    toolUseId: input.toolUseId,
    permissionRequest: input.permissionRequest
  }
});

export const buildClaudeQuestionRequest = (input: {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolUseId?: string;
  readonly permissionRequest: UnknownRecord;
}): {
  readonly request: NlaInteractionPayload;
  readonly answerKey: string;
  readonly optionLabels: ReadonlyMap<string, string>;
} => {
  const questions = questionList(input.toolInput);
  const firstQuestion = questions[0];
  const answerKey =
    stringValue(firstQuestion?.question) ??
    stringValue(firstQuestion?.header) ??
    "response";

  const options = (Array.isArray(firstQuestion?.options) ? firstQuestion.options : [])
    .flatMap((entry, index) => {
      const option = recordValue(entry);
      const label = stringValue(option?.label);
      return label
        ? [{
            id: `option_${index + 1}`,
            label
          }]
        : [];
    });

  const optionLabels = new Map(options.map((option) => [option.id, option.label]));

  return {
    request: {
      kind: "form",
      requestId: input.requestId,
      title: questions.length === 1
        ? questionTitle(firstQuestion)
        : "Claude has questions",
      body: questions.length === 1
        ? questionBody(firstQuestion)
        : `${questions.length} questions need answers.`,
      questions: [
        {
          id: input.requestId,
          title: questionTitle(firstQuestion),
          body: questionBody(firstQuestion),
          allowsText: true,
          options: options.map((option, index) => ({
            id: option.id,
            label: option.label,
            style: index === 0 ? "primary" : "secondary"
          }))
        }
      ],
      details: {
        provider: "claude",
        toolName: input.toolName,
        toolInput: input.toolInput,
        toolUseId: input.toolUseId,
        questions,
        permissionRequest: input.permissionRequest
      }
    },
    answerKey,
    optionLabels
  };
};

export const buildClaudeApprovalResolution = (
  pending: PendingClaudeApprovalInput,
  resolution: NlaInteractionPayload
): ClaudePermissionResult => {
  const record = recordValue(resolution) ?? {};
  const optionId = stringValue(record.optionId)?.trim().toLowerCase();
  const text = stringValue(record.text);
  const value = recordValue(record.value);

  if (optionId === "approve" || optionId === "allow" || optionId === "approved") {
    return {
      behavior: "allow",
      updatedInput: Object.prototype.hasOwnProperty.call(value ?? {}, "updatedInput")
        ? value?.updatedInput
        : pending.toolInput,
      toolUseID: pending.toolUseId
    };
  }

  return {
    behavior: "deny",
    message: text || stringValue(value?.message) || stringValue(value?.reason) || "Denied by host.",
    toolUseID: pending.toolUseId
  };
};

export const buildClaudeQuestionResolution = (
  pending: PendingClaudeQuestionInput,
  resolution: NlaInteractionPayload
): UnknownRecord => {
  const record = recordValue(resolution) ?? {};
  const optionId = stringValue(record.optionId);
  const text = stringValue(record.text);
  const value = recordValue(record.value);
  const answers = recordValue(value?.answers) ?? answerRecord(
    pending.answerKey,
    text || (optionId ? pending.optionLabels.get(optionId) : undefined)
  );

  return preToolUseHookOutput({
    permissionDecision: "allow",
    permissionDecisionReason: "Answered in the Claude adapter.",
    updatedInput: {
      ...(recordValue(pending.toolInput) ?? {}),
      questions: questionList(pending.toolInput),
      answers
    }
  });
};

const nlaSessionMessageParts = (
  input: Pick<NlaSessionMessage["data"], "parts" | "text">
): ReadonlyArray<NlaSessionMessagePart> => {
  if (Array.isArray(input.parts) && input.parts.length > 0) {
    return input.parts;
  }

  if (typeof input.text === "string" && input.text.trim()) {
    return [
      {
        type: "text",
        text: input.text
      }
    ];
  }

  throw new ClaudeAdapterError("Claude input must include non-empty text or parts", "claude_empty_input");
};

const promptSegmentFromPart = (
  dependencies: ClaudeAdapterDependencies,
  part: NlaSessionMessagePart,
  cwd: string
): Effect.Effect<string, Error> => {
  switch (stringValue(part.type)) {
    case "text":
      return Effect.succeed(typeof part.text === "string" ? part.text : "");
    case "image":
      return imagePromptSegment(dependencies.assets, part, cwd);
    case "localImage":
      return localImagePromptSegment(part, cwd);
    default:
      return Effect.fail(new ClaudeAdapterError(
        `Unsupported Claude input part type: ${stringValue(part.type) ?? "(empty)"}`,
        "claude_unsupported_input_part"
      ));
  }
};

const imagePromptSegment = (
  assets: Pick<AssetCapabilityClient, "materialize"> | undefined,
  part: NlaSessionMessagePart,
  cwd: string
): Effect.Effect<string, Error> => {
  const record = part as Record<string, unknown>;
  const assetId = stringValue(record.assetId);
  if (!assetId) {
    return Effect.fail(new ClaudeAdapterError(
      "Claude image parts must include assetId",
      "claude_invalid_image_part"
    ));
  }

  if (!assets) {
    return Effect.fail(new ClaudeAdapterError(
      "Claude image input requires an assets capability",
      "claude_missing_assets_capability"
    ));
  }

  const filename = stringValue(record.filename);
  return assets.materialize({
    assetId,
    filename,
    location: "session-cwd",
    cwd
  }).pipe(
    Effect.map((materializedPath) =>
      markdownImage(
        promptPath(materializedPath, cwd),
        filename ?? assetId
      )
    )
  );
};

const localImagePromptSegment = (
  part: NlaSessionMessagePart,
  cwd: string
): Effect.Effect<string, Error> => {
  const record = part as Record<string, unknown>;
  const imagePath = stringValue(record.path);
  if (!imagePath) {
    return Effect.fail(new ClaudeAdapterError(
      "Claude localImage parts must include path",
      "claude_invalid_image_part"
    ));
  }

  return Effect.succeed(
    markdownImage(
      promptPath(imagePath, cwd),
      stringValue(record.filename) ?? path.basename(imagePath)
    )
  );
};

const markdownImage = (imagePath: string, label: string): string =>
  `![${markdownLabel(label)}](${markdownPath(imagePath)})`;

const promptPath = (imagePath: string, cwd: string): string => {
  if (!path.isAbsolute(imagePath)) {
    return imagePath.split(path.sep).join("/");
  }

  const relative = path.relative(cwd, imagePath);
  return relative && !relative.startsWith("..")
    ? relative.split(path.sep).join("/")
    : imagePath;
};

const markdownLabel = (value: string): string =>
  value.replace(/[\[\]]+/g, "_");

const markdownPath = (value: string): string =>
  encodeURI(value).replace(/\(/g, "%28").replace(/\)/g, "%29");

const questionList = (toolInput: unknown): ReadonlyArray<UnknownRecord> => {
  const input = recordValue(toolInput);
  return Array.isArray(input?.questions)
    ? input.questions.flatMap((entry) => {
        const question = recordValue(entry);
        return question ? [question] : [];
      })
    : [];
};

const questionTitle = (question: UnknownRecord | undefined): string =>
  stringValue(question?.question) || stringValue(question?.header) || "Claude has a question";

const questionBody = (question: UnknownRecord | undefined): string | undefined => {
  const description = stringValue(question?.description);
  if (description) {
    return description;
  }

  const options = Array.isArray(question?.options)
    ? question.options.flatMap((entry) => {
        const option = recordValue(entry);
        return option ? [option] : [];
      })
    : [];

  if (options.length === 0) {
    return undefined;
  }

  return options
    .map((option, index) => {
      const label = stringValue(option.label) || `Option ${index + 1}`;
      const detail = stringValue(option.description);
      return detail ? `${index + 1}. ${label} - ${detail}` : `${index + 1}. ${label}`;
    })
    .join("\n");
};

const permissionBody = (toolName: string, toolInput: unknown): string | undefined => {
  const input = recordValue(toolInput);
  if (toolName === "Bash" && input) {
    return stringValue(input.command) || previewJson(toolInput);
  }
  if (input) {
    const filePath = stringValue(input.file_path) || stringValue(input.filePath) || stringValue(input.path);
    if (filePath) {
      return filePath;
    }
  }
  return previewJson(toolInput);
};

const answerRecord = (key: string, answer: string | undefined): UnknownRecord =>
  answer
    ? { [key]: answer }
    : {};

const preToolUseHookOutput = (input: {
  readonly permissionDecision: "allow" | "deny" | "ask" | "defer";
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: unknown;
}): UnknownRecord => ({
  suppressOutput: true,
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: input.permissionDecision,
    ...(input.permissionDecisionReason
      ? { permissionDecisionReason: input.permissionDecisionReason }
      : {}),
    ...(input.updatedInput !== undefined
      ? { updatedInput: input.updatedInput }
      : {})
  }
});
