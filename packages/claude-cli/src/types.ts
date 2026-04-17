import type { AssetCapabilityClient } from "@nla-adapters/contracts";
import type { NlaInteractionPayload } from "@nla/protocol";
import type { ClaudeAdapterConfig } from "./config.js";
import type {
  ClaudePermissionBridge,
  ClaudePermissionMode,
  ClaudePermissionResult
} from "./permissionBridge.js";
import type { UnknownRecord } from "./shared.js";

export interface ClaudeAdapterDependencies {
  readonly assets?: Pick<AssetCapabilityClient, "materialize">;
}

export interface CreateClaudeAdapterOptions {
  readonly config?: ClaudeAdapterConfig;
}

export interface ClaudeRuntimeSettings {
  readonly permissionMode: ClaudePermissionMode;
}

export const DefaultClaudeRuntimeSettings: ClaudeRuntimeSettings = {
  permissionMode: "default"
};

export interface ClaudeSessionState {
  readonly sessionId: string;
  providerRef: string;
  claudeSessionRef?: string;
  settings: ClaudeRuntimeSettings;
  cwd: string;
  child?: import("node:child_process").ChildProcessWithoutNullStreams;
  stdoutReader?: import("node:readline").Interface;
  stderrReader?: import("node:readline").Interface;
  bridge?: ClaudePermissionBridge;
  pendingInputs: Map<string, PendingClaudeInput>;
  turnState?: ClaudeTurnState;
}

export interface ClaudeTurnState {
  readonly queue: AsyncQueue<ClaudeTurnEvent>;
  readonly assistantMessageId: string;
  turnId?: string;
  assistantText: string;
  finalAssistantText?: string;
  providerMessageId?: string;
  activitySequence: number;
}

interface PendingClaudeInputBase {
  readonly requestId: string;
  readonly kind: "approval" | "form";
  readonly waitStatus: "awaiting_input" | "awaiting_approval";
  readonly request: NlaInteractionPayload;
  readonly permissionRequest: UnknownRecord;
  readonly reject: (error: Error) => void;
}

export interface PendingClaudeApprovalInput extends PendingClaudeInputBase {
  readonly kind: "approval";
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolUseId?: string;
  readonly resolve: (result: ClaudePermissionResult) => void;
}

export interface PendingClaudeQuestionInput extends PendingClaudeInputBase {
  readonly kind: "form";
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolUseId?: string;
  readonly answerKey: string;
  readonly optionLabels: ReadonlyMap<string, string>;
  readonly resolve: (result: UnknownRecord) => void;
}

export type ClaudeTurnEvent =
  | {
      readonly type: "assistant.delta";
      readonly delta: string;
      readonly providerMessageId?: string;
    }
  | {
      readonly type: "assistant.final";
      readonly text: string;
      readonly providerMessageId?: string;
    }
  | {
      readonly type: "activity";
      readonly activityId: string;
      readonly title: string;
      readonly status: "running" | "succeeded" | "failed";
    }
  | {
      readonly type: "interaction.requested";
      readonly status: "awaiting_input" | "awaiting_approval";
      readonly request: NlaInteractionPayload;
    }
  | {
      readonly type: "turn.completed";
      readonly status: "completed" | "failed";
      readonly message?: string;
    }
  | {
      readonly type: "interrupted";
    }
  | {
      readonly type: "fatal";
      readonly error: Error;
    };

export class ClaudeAdapterError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "ClaudeAdapterError";
  }
}

export type PendingClaudeInput =
  | PendingClaudeApprovalInput
  | PendingClaudeQuestionInput;

export class AsyncQueue<T> {
  private readonly items: Array<T> = [];
  private readonly waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
