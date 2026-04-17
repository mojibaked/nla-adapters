import * as Effect from "effect/Effect";
import type { NlaSessionHandlerContext } from "@nla/sdk-core";
import type {
  NlaSessionControlDefinition,
  NlaSessionControlMessage,
  NlaSessionInteractionResolveMessage,
  NlaSessionInterruptMessage,
  NlaSessionMessage,
  NlaSessionResumeMessage,
  NlaSessionStartMessage
} from "@nla/protocol";
import {
  createCodexAppServerClient,
  type CodexAppServerClient,
  type CodexAppServerNotificationMessage
} from "./appServerClient.js";
import { codexSessionControls, parseCodexApprovalMode, parseCodexSandboxMode } from "./controls.js";
import type { CodexAdapterConfig } from "./config.js";
import { checkCodexAuth, prepareCodexTurn } from "./inputs.js";
import { buildCodexResolution, buildInputResponse, buildPendingInputRequest } from "./interactions.js";
import {
  assistantTextFromItem,
  codexActivityFromItem,
  turnErrorMessage
} from "./notifications.js";
import {
  mainActivityId,
  metadataString,
  readThreadId,
  readTurnId,
  recordValue,
  stringValue,
  toError
} from "./shared.js";
import {
  AsyncQueue,
  type CodexAdapterDependencies,
  CodexAdapterError,
  type CodexAppServerHandlers,
  type CodexSessionState,
  type CreateCodexAdapterOptions,
  DefaultCodexRuntimeSettings,
  type CodexTurnEvent
} from "./types.js";

export class CodexNlaRuntime {
  private readonly sessions = new Map<string, CodexSessionState>();
  private readonly dependencies: CodexAdapterDependencies;
  private readonly config: CodexAdapterConfig;
  private readonly createClient: (
    config: CodexAdapterConfig,
    handlers: CodexAppServerHandlers
  ) => CodexAppServerClient;

  constructor(
    dependencies: CodexAdapterDependencies,
    config: CodexAdapterConfig,
    createClient: CreateCodexAdapterOptions["createClient"] = (runtimeConfig, handlers) =>
      createCodexAppServerClient(
        {
          command: runtimeConfig.command,
          commandArgs: runtimeConfig.commandArgs,
          appServerArgs: runtimeConfig.appServerArgs,
          cwd: process.cwd(),
          env: runtimeConfig.childEnv
        },
        {
          onServerRequest: handlers.onServerRequest,
          onNotification: handlers.onNotification,
          onExit: handlers.onExit
        }
      )
  ) {
    this.dependencies = dependencies;
    this.config = config;
    this.createClient = createClient;
  }

  startOrResumeSession(
    ctx: NlaSessionHandlerContext,
    _message: NlaSessionStartMessage | NlaSessionResumeMessage
  ): void {
    const session = this.sessionState(ctx.session.id);
    ctx.setProviderRef(session.providerRef);
    ctx.started({
      providerRef: session.providerRef,
      state: {
        approvalMode: session.settings.approvalMode,
        sandboxMode: session.settings.sandboxMode
      }
    });
    ctx.execution({
      state: "idle",
      interruptible: false
    });
  }

  sessionControlsForSession(sessionId: string): ReadonlyArray<NlaSessionControlDefinition> {
    return codexSessionControls(this.sessionState(sessionId).settings);
  }

  async handleTurn(
    ctx: NlaSessionHandlerContext,
    message: NlaSessionMessage
  ): Promise<void> {
    const session = this.sessionState(ctx.session.id);
    if (session.turnState) {
      this.emitTurnFailure(ctx, "Codex is already working on a turn", "session_busy");
      return;
    }

    const assistantMessageId = metadataString(message.data.metadata, "assistantMessageId")
      ?? ctx.createId("msg");

    try {
      const input = await Effect.runPromise(
        prepareCodexTurn(this.dependencies.assets, message.data)
      );
      ctx.execution({
        state: "running",
        turnId: metadataString(message.data.metadata, "turnId"),
        interruptible: true
      });
      this.emitMainActivity(ctx, "running", "Running Codex");

      if (this.config.authMode === "check") {
        const authenticated = await Effect.runPromise(checkCodexAuth(this.config, input.cwd));
        if (!authenticated) {
          throw new CodexAdapterError(
            "Codex CLI is not authenticated on this host. Run `codex login` in the target workspace, then retry.",
            "codex_auth_required"
          );
        }
      }

      const client = await this.ensureClient(session);
      await this.ensureThread(session, client, input.cwd);
      session.turnState = {
        queue: new AsyncQueue<CodexTurnEvent>(),
        assistantMessageId,
        assistantText: "",
        finalAssistantText: undefined,
        deltaSequence: 0
      };

      const response = await client.request("turn/start", {
        threadId: this.requireThreadId(session),
        input: input.input,
        cwd: input.cwd
      });

      const turnState = session.turnState;
      if (!turnState) {
        throw new CodexAdapterError("Missing Codex turn state", "codex_missing_turn_state");
      }

      turnState.turnId = readTurnId(response);
      await this.driveTurn(session, ctx);
    } catch (error) {
      session.turnState = undefined;
      const codexError = toError(error);
      this.emitMainActivity(ctx, "failed", "Codex failed");
      this.emitTurnFailure(ctx, codexError.message, codexError.code);
    }
  }

  async handleInput(
    ctx: NlaSessionHandlerContext,
    message: NlaSessionInteractionResolveMessage
  ): Promise<void> {
    const session = this.sessions.get(ctx.session.id);
    const pending = session?.pendingInputs.get(message.data.resolution.requestId);
    const turnState = session?.turnState;

    if (!session || !pending || !turnState) {
      this.emitTurnFailure(
        ctx,
        `Unknown Codex input request: ${message.data.resolution.requestId}`,
        "unknown_input_request"
      );
      return;
    }

    try {
      const resolution = buildCodexResolution(pending, message.data.resolution);
      session.pendingInputs.delete(pending.requestId);
      ctx.resolveInput({
        resolution: resolution.payload
      });
      ctx.execution({
        state: "running",
        turnId: turnState.turnId ?? metadataString(message.data.metadata, "turnId"),
        interruptible: true
      });
      this.emitMainActivity(ctx, "running", "Resuming Codex");
      this.requireClient(session).respond(pending.rpcId, buildInputResponse(pending, resolution));
      await this.driveTurn(session, ctx);
    } catch (error) {
      session.turnState = undefined;
      const codexError = toError(error);
      this.emitMainActivity(ctx, "failed", "Codex failed");
      this.emitTurnFailure(ctx, codexError.message, codexError.code);
    }
  }

  async handleSessionInterrupt(
    ctx: NlaSessionHandlerContext,
    message: NlaSessionInterruptMessage
  ): Promise<void> {
    const result = await this.interruptTurn(
      ctx.session.id,
      message.data.turnId?.trim() ? message.data.turnId.trim() : undefined
    );

    ctx.interruptResult({
      status: result.status,
      turnId: result.turnId,
      message: result.message
    });
  }

  handleSessionControl(
    ctx: NlaSessionHandlerContext,
    message: NlaSessionControlMessage
  ): void {
    const session = this.sessionState(ctx.session.id);
    const controlId = message.data.control.trim();
    if (session.turnState) {
      ctx.controlState({
        controlId,
        status: "busy",
        label: "Codex is already working on a turn"
      });
      return;
    }

    switch (controlId) {
      case "approval_mode": {
        const nextValue = parseCodexApprovalMode(message.data.optionId);
        if (!nextValue) {
          ctx.controlState({
            controlId,
            status: "rejected",
            label: "Choose a valid approval mode"
          });
          return;
        }

        session.settings = {
          ...session.settings,
          approvalMode: nextValue
        };
        session.threadId = undefined;
        ctx.controlState({
          controlId,
          status: "applied",
          optionId: nextValue,
          label: session.client?.isRunning()
            ? "Approval mode will apply on the next turn"
            : undefined
        });
        return;
      }
      case "sandbox_mode": {
        const nextValue = parseCodexSandboxMode(message.data.optionId);
        if (!nextValue) {
          ctx.controlState({
            controlId,
            status: "rejected",
            label: "Choose a valid sandbox mode"
          });
          return;
        }

        session.settings = {
          ...session.settings,
          sandboxMode: nextValue
        };
        session.threadId = undefined;
        ctx.controlState({
          controlId,
          status: "applied",
          optionId: nextValue,
          label: session.client?.isRunning()
            ? "Sandbox mode will apply on the next turn"
            : undefined
        });
        return;
      }
      default:
        ctx.controlState({
          controlId,
          status: "unsupported",
          label: `Unsupported Codex control: ${controlId}`
        });
    }
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.client?.stop();
    this.sessions.delete(sessionId);
  }

  private async interruptTurn(
    sessionId: string,
    turnId?: string
  ): Promise<{
    readonly status: "interrupted" | "no_active_work";
    readonly turnId?: string;
    readonly message: string;
  }> {
    const session = this.sessions.get(sessionId);
    const turnState = session?.turnState;
    if (!session || !turnState || (turnId && turnState.turnId && turnId !== turnState.turnId)) {
      return {
        status: "no_active_work",
        message: "No active Codex turn"
      };
    }

    turnState.queue.push({
      type: "interrupted"
    });

    if (session.client && session.threadId && turnState.turnId) {
      try {
        await session.client.request("turn/interrupt", {
          threadId: session.threadId,
          turnId: turnState.turnId
        });
      } catch {
        // Best-effort interrupt.
      }
    }

    return {
      status: "interrupted",
      turnId: turnState.turnId,
      message: "Interrupted"
    };
  }

  private async driveTurn(
    session: CodexSessionState,
    ctx: NlaSessionHandlerContext
  ): Promise<void> {
    const turnState = session.turnState;
    if (!turnState) {
      throw new CodexAdapterError("Missing Codex turn state", "codex_missing_turn_state");
    }

    while (true) {
      const event = await turnState.queue.next();

      switch (event.type) {
        case "assistant.delta":
          turnState.deltaSequence += 1;
          turnState.assistantText += event.delta;
          ctx.messageDelta({
            messageId: turnState.assistantMessageId,
            role: "assistant",
            delta: event.delta
          });
          continue;
        case "assistant.final":
          turnState.finalAssistantText = event.text;
          continue;
        case "activity":
          ctx.activity({
            activityId: event.activityId,
            title: event.title,
            status: event.status
          });
          continue;
        case "server.request": {
          const pending = buildPendingInputRequest(event.request, session.sessionId);
          if (!pending) {
            throw new CodexAdapterError(
              `Unsupported Codex server request: ${event.request.method}`,
              "codex_unsupported_server_request"
            );
          }

          session.pendingInputs.set(pending.requestId, pending);
          ctx.execution({
            state: "awaiting_input",
            turnId: turnState.turnId,
            interruptible: true
          });
          this.emitMainActivity(ctx, "running", "Codex is waiting for input");
          ctx.requestInput({
            request: pending.input
          });
          return;
        }
        case "turn.completed": {
          const finalText = turnState.finalAssistantText ?? turnState.assistantText;
          session.turnState = undefined;

          if (event.status === "completed") {
            this.emitMainActivity(ctx, "succeeded", "Codex completed");
            if (finalText) {
              ctx.emit("session.message", {
                sessionId: ctx.session.id,
                role: "assistant",
                text: finalText
              }, {
                id: turnState.assistantMessageId
              });
            }
            ctx.complete();
            return;
          }

          if (event.status === "interrupted") {
            return;
          }

          throw new CodexAdapterError(event.message ?? "Codex turn failed", "codex_turn_failed");
        }
        case "interrupted":
          session.turnState = undefined;
          return;
        case "fatal":
          session.turnState = undefined;
          throw event.error;
      }
    }
  }

  private sessionState(sessionId: string): CodexSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: CodexSessionState = {
      sessionId,
      providerRef: `codex.cli:${sessionId}`,
      settings: DefaultCodexRuntimeSettings,
      pendingInputs: new Map()
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private async ensureClient(session: CodexSessionState): Promise<CodexAppServerClient> {
    if (session.client?.isRunning()) {
      return session.client;
    }

    const client = this.createClient(this.config, {
      onServerRequest: (message) => {
        session.turnState?.queue.push({
          type: "server.request",
          request: message
        });
      },
      onNotification: (message) => {
        this.handleNotification(session, message);
      },
      onExit: (error) => {
        session.client = undefined;
        session.threadId = undefined;
        if (session.turnState) {
          session.turnState.queue.push({
            type: "fatal",
            error
          });
        }
      }
    });

    await client.start();
    session.client = client;
    return client;
  }

  private async ensureThread(
    session: CodexSessionState,
    client: CodexAppServerClient,
    cwd: string
  ): Promise<void> {
    if (session.threadId) {
      return;
    }

    const response = await client.request("thread/start", {
      cwd,
      approvalPolicy: session.settings.approvalMode,
      sandbox: session.settings.sandboxMode,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });
    const threadId = readThreadId(response);
    if (!threadId) {
      throw new CodexAdapterError("Codex app-server did not return a thread id", "codex_missing_thread");
    }

    session.threadId = threadId;
  }

  private handleNotification(
    session: CodexSessionState,
    message: CodexAppServerNotificationMessage
  ): void {
    const params = recordValue(message.params);
    switch (message.method) {
      case "thread/started":
        session.threadId = readThreadId(params) ?? session.threadId;
        return;
      case "turn/started":
        if (session.turnState && !session.turnState.turnId) {
          session.turnState.turnId = readTurnId(params);
        }
        return;
      case "item/agentMessage/delta": {
        const delta = stringValue(params?.delta);
        if (delta && session.turnState) {
          session.turnState.queue.push({
            type: "assistant.delta",
            delta
          });
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = recordValue(params?.item);
        if (!item || !session.turnState) {
          return;
        }

        const activity = codexActivityFromItem(item, message.method === "item/started");
        if (activity) {
          session.turnState.queue.push({
            type: "activity",
            ...activity
          });
        }

        const assistantText = assistantTextFromItem(item);
        if (assistantText && message.method === "item/completed") {
          session.turnState.queue.push({
            type: "assistant.final",
            text: assistantText
          });
        }
        return;
      }
      case "turn/completed": {
        if (!session.turnState) {
          return;
        }

        const turn = recordValue(params?.turn);
        const status = stringValue(turn?.status);
        session.turnState.queue.push({
          type: "turn.completed",
          status: status === "failed" || status === "interrupted" ? status : "completed",
          message: turnErrorMessage(turn)
        });
        return;
      }
      case "error":
        if (session.turnState) {
          session.turnState.queue.push({
            type: "fatal",
            error: new CodexAdapterError(
              stringValue(recordValue(params?.error)?.message) ??
                stringValue(params?.message) ??
                "Codex app-server reported an error",
              "codex_app_server_error"
            )
          });
        }
        return;
      default:
        return;
    }
  }

  private emitMainActivity(
    ctx: NlaSessionHandlerContext,
    status: "running" | "succeeded" | "failed",
    title: string
  ): void {
    ctx.activity({
      activityId: mainActivityId(ctx.session.id),
      title,
      status
    });
  }

  // Managed-agent adapters use `session.failed` to fail the current turn while
  // keeping the session alive for later turns. `ctx.fail(...)` would tear down
  // the sdk-core session state, which is not what wrappers like Codex/Claude want.
  private emitTurnFailure(
    ctx: NlaSessionHandlerContext,
    message: string,
    code?: string
  ): void {
    ctx.emit("session.failed", {
      sessionId: ctx.session.id,
      ok: false as const,
      code,
      message
    });
  }

  private requireClient(session: CodexSessionState): CodexAppServerClient {
    if (!session.client) {
      throw new CodexAdapterError("Codex app-server is not running", "codex_not_running");
    }

    return session.client;
  }

  private requireThreadId(session: CodexSessionState): string {
    if (!session.threadId) {
      throw new CodexAdapterError("Codex thread is not available", "codex_missing_thread");
    }

    return session.threadId;
  }
}
