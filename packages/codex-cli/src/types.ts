import type { AssetCapabilityClient } from "@nla-adapters/contracts";
import type { NlaInteractionPayload } from "@nla/protocol";
import type {
  CodexAppServerClient,
  CodexAppServerNotificationMessage,
  CodexAppServerRequestMessage
} from "./appServerClient.js";
import type { CodexAdapterConfig } from "./config.js";

export interface CodexTextInput {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: ReadonlyArray<never>;
}

export interface CodexLocalImageInput {
  readonly type: "localImage";
  readonly path: string;
}

export type CodexUserInput = CodexTextInput | CodexLocalImageInput;

export interface CodexTurnInput {
  readonly input: ReadonlyArray<CodexUserInput>;
  readonly cwd: string;
}

export interface CodexAdapterDependencies {
  readonly assets: Pick<AssetCapabilityClient, "materialize">;
}

export interface CreateCodexAdapterOptions {
  readonly config?: CodexAdapterConfig;
  readonly createClient?: (
    config: CodexAdapterConfig,
    handlers: CodexAppServerHandlers
  ) => CodexAppServerClient;
}

export type CodexApprovalMode = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexRuntimeSettings {
  readonly approvalMode: CodexApprovalMode;
  readonly sandboxMode: CodexSandboxMode;
}

export const DefaultCodexRuntimeSettings: CodexRuntimeSettings = {
  approvalMode: "never",
  sandboxMode: "danger-full-access"
};

export interface CodexAppServerHandlers {
  readonly onServerRequest: (message: CodexAppServerRequestMessage) => void;
  readonly onNotification: (message: CodexAppServerNotificationMessage) => void;
  readonly onExit: (error: Error) => void;
}

export interface CodexTurnState {
  readonly queue: AsyncQueue<CodexTurnEvent>;
  readonly assistantMessageId: string;
  readonly assistantMessages: Map<string, CodexAssistantMessageState>;
  deltaSequence: number;
  turnId?: string;
}

export interface CodexAssistantMessageState {
  text: string;
  completed: boolean;
}

export interface CodexSessionState {
  readonly sessionId: string;
  providerRef: string;
  settings: CodexRuntimeSettings;
  readonly pendingInputs: Map<string, PendingInputRequest>;
  client?: CodexAppServerClient;
  threadId?: string;
  resumeThreadRef?: string;
  turnState?: CodexTurnState;
}

export interface PendingInputRequest {
  readonly requestId: string;
  readonly rpcId: string | number;
  readonly method: string;
  readonly waitStatus: "awaiting_input" | "awaiting_approval";
  readonly input: NlaInteractionPayload;
  readonly optionLabels?: ReadonlyMap<string, string>;
  readonly questionIds?: ReadonlyArray<string>;
}

export interface CodexInputResolution {
  readonly optionId?: string;
  readonly text?: string;
  readonly value?: unknown;
  readonly payload: NlaInteractionPayload;
}

export type CodexTurnEvent =
  | {
      readonly type: "assistant.delta";
      readonly messageId?: string;
      readonly delta: string;
    }
  | {
      readonly type: "assistant.final";
      readonly messageId?: string;
      readonly text: string;
    }
  | {
      readonly type: "activity";
      readonly activityId: string;
      readonly title: string;
      readonly status: "running" | "succeeded" | "failed";
    }
  | {
      readonly type: "server.request";
      readonly request: CodexAppServerRequestMessage;
    }
  | {
      readonly type: "turn.completed";
      readonly status: "completed" | "failed" | "interrupted";
      readonly message?: string;
    }
  | {
      readonly type: "interrupted";
    }
  | {
      readonly type: "fatal";
      readonly error: Error;
    };

export class CodexAdapterError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "CodexAdapterError";
  }
}

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
