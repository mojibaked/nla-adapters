import * as Effect from "effect/Effect";
import type { NlaSessionHandlerContext } from "@nla/sdk-core";
import type { NlaThreadsHandlerContext } from "@nla/sdk-core";
import type {
  NlaSessionControlDefinition,
  NlaSessionControlMessage,
  NlaSessionInteractionResolveMessage,
  NlaSessionInterruptMessage,
  NlaSessionMessage,
  NlaSessionResumeMessage,
  NlaSessionStartMessage,
  NlaThreadsHistoryRequestMessage,
  NlaThreadsListRequestMessage
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
  agentMessageDeltaId,
  assistantTextFromItem,
  codexActivityFromItem,
  codexExplorationFromItem,
  codexExplorationTitle,
  codexReasoningActivityId,
  codexReasoningSummaryDeltaFromParams,
  codexReasoningSummaryFromItem,
  codexReasoningTitle,
  itemId,
  type CodexActivity,
  type CodexExplorationItem,
  type CodexReasoningSummaryDelta,
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
import { getCodexThreadHistory, listCodexThreads } from "./threads.js";
import {
  AsyncQueue,
  type CodexAssistantMessageState,
  type CodexAdapterDependencies,
  CodexAdapterError,
  type CodexAppServerHandlers,
  type CodexExplorationGroup,
  type CodexSessionState,
  type CodexTurnState,
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
    message: NlaSessionStartMessage | NlaSessionResumeMessage
  ): void {
    const session = this.sessionState(ctx.session.id);
    const resumeThreadRef = "threadRef" in message.data
      ? stringValue(message.data.threadRef)
      : undefined;
    const providerRef = "providerRef" in message.data
      ? stringValue(message.data.providerRef)
      : undefined;

    if (providerRef) {
      session.providerRef = providerRef;
    }
    if (resumeThreadRef) {
      session.providerRef = resumeThreadRef;
      session.resumeThreadRef = resumeThreadRef;
      session.threadId = undefined;
    }

    ctx.setProviderRef(session.providerRef);
    ctx.started({
      providerRef: session.providerRef,
      threadRef: session.resumeThreadRef ?? session.threadId,
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

  async listThreads(
    ctx: NlaThreadsHandlerContext<NlaThreadsListRequestMessage>,
    message: NlaThreadsListRequestMessage
  ): Promise<void> {
    const result = await listCodexThreads({
      configDir: this.config.configDir,
      scope: message.data.scope,
      cursor: message.data.cursor,
      limit: message.data.limit
    });

    for (const thread of result.threads) {
      ctx.thread(thread);
    }

    ctx.complete({
      nextCursor: result.nextCursor
    });
  }

  async getThreadHistory(
    ctx: NlaThreadsHandlerContext<NlaThreadsHistoryRequestMessage>,
    message: NlaThreadsHistoryRequestMessage
  ): Promise<void> {
    const result = await getCodexThreadHistory({
      configDir: this.config.configDir,
      threadRef: message.data.threadRef,
      cursor: message.data.cursor,
      limit: message.data.limit
    });

    for (const item of result.items) {
      ctx.historyItem(item);
    }

    ctx.complete({
      nextCursor: result.nextCursor
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
    const hostTurnId = metadataString(message.data.metadata, "turnId");

    try {
      const input = await Effect.runPromise(
        prepareCodexTurn(this.dependencies.assets, message.data)
      );

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
        assistantMessages: new Map(),
        explorationItemGroups: new Map(),
        reasoningSummaries: new Map(),
        hostTurnId,
        explorationGroupSequence: 0,
        deltaSequence: 0
      };
      ctx.execution({
        state: "running",
        turnId: hostTurnId,
        interruptible: true
      });
      this.emitMainActivity(ctx, "running", "Running Codex");

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
        turnId: turnState.hostTurnId ?? metadataString(message.data.metadata, "turnId"),
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
    if (!session || !turnState || !this.matchesActiveTurn(turnState, turnId)) {
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
      turnId: turnState.hostTurnId ?? turnState.turnId,
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
          this.assistantMessageState(turnState, event.messageId).text += event.delta;
          ctx.messageDelta({
            messageId: event.messageId ?? turnState.assistantMessageId,
            role: "assistant",
            delta: event.delta
          });
          continue;
        case "assistant.final":
          this.completeAssistantMessage(ctx, turnState, event.messageId, event.text);
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
            turnId: turnState.hostTurnId ?? turnState.turnId,
            interruptible: true
          });
          this.emitMainActivity(ctx, "running", "Codex is waiting for input");
          ctx.requestInput({
            request: pending.input
          });
          return;
        }
        case "turn.completed": {
          session.turnState = undefined;

          if (event.status === "completed") {
            this.completePendingAssistantMessages(ctx, turnState);
            this.emitMainActivity(ctx, "succeeded", "Codex completed");
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

  private matchesActiveTurn(turnState: CodexTurnState, requestedTurnId?: string): boolean {
    if (!requestedTurnId) {
      return true;
    }

    return requestedTurnId === turnState.hostTurnId || requestedTurnId === turnState.turnId;
  }

  private activityFromItem(
    turnState: CodexTurnState,
    item: Record<string, unknown>,
    started: boolean
  ): Extract<CodexTurnEvent, { readonly type: "activity" }> | undefined {
    const exploration = codexExplorationFromItem(item, started);
    const reasoning = exploration
      ? undefined
      : this.reasoningActivityFromItem(turnState, item, started);
    const activity = exploration
      ? this.updateExplorationGroup(turnState, exploration)
      : reasoning ?? codexActivityFromItem(item, started);

    if (!exploration && activity) {
      this.closeExplorationGroup(turnState);
    }

    return activity
      ? {
          type: "activity",
          ...activity
        }
      : undefined;
  }

  private updateExplorationGroup(
    turnState: CodexTurnState,
    item: CodexExplorationItem
  ): CodexActivity {
    let group = turnState.explorationItemGroups.get(item.itemId);
    const existingCall = group?.calls.find((call) => call.itemId === item.itemId);

    if (group && existingCall) {
      existingCall.actions = item.actions;
      existingCall.status = item.status;
    } else {
      group = group ?? turnState.currentExplorationGroup ?? this.createExplorationGroup(turnState);
      group.calls.push({
        itemId: item.itemId,
        actions: item.actions,
        status: item.status
      });
      turnState.explorationItemGroups.set(item.itemId, group);
    }

    const status = this.explorationGroupStatus(group);
    turnState.currentExplorationGroup = status === "failed" ? undefined : group;

    return {
      activityId: group.activityId,
      title: codexExplorationTitle(
        group.calls.flatMap((call) => call.actions),
        status
      ),
      status
    };
  }

  private reasoningActivityFromItem(
    turnState: CodexTurnState,
    item: Record<string, unknown>,
    started: boolean
  ): CodexActivity | undefined {
    if (started) {
      return undefined;
    }

    if (stringValue(item.type) !== "reasoning") {
      return undefined;
    }

    const reasoningItemId = itemId(item);
    if (!reasoningItemId) {
      return undefined;
    }

    const summary = codexReasoningSummaryFromItem(item) ?? this.reasoningSummaryText(turnState, reasoningItemId);
    turnState.reasoningSummaries.delete(reasoningItemId);
    if (!summary) {
      return undefined;
    }

    return {
      activityId: codexReasoningActivityId(reasoningItemId),
      title: codexReasoningTitle(summary, "succeeded"),
      status: "succeeded"
    };
  }

  private updateReasoningSummary(
    turnState: CodexTurnState,
    delta: CodexReasoningSummaryDelta
  ): CodexActivity {
    const summary = turnState.reasoningSummaries.get(delta.itemId) ?? { parts: [] };
    summary.parts[delta.summaryIndex] = `${summary.parts[delta.summaryIndex] ?? ""}${delta.delta}`;
    turnState.reasoningSummaries.set(delta.itemId, summary);

    return {
      activityId: codexReasoningActivityId(delta.itemId),
      title: codexReasoningTitle(this.reasoningSummaryText(turnState, delta.itemId) ?? "", "running"),
      status: "running"
    };
  }

  private reasoningSummaryText(turnState: CodexTurnState, itemId: string): string | undefined {
    const summary = turnState.reasoningSummaries.get(itemId);
    const text = summary?.parts
      .filter((part) => Boolean(part?.trim()))
      .map((part) => part.trim())
      .join(" ");

    return text || undefined;
  }

  private createExplorationGroup(turnState: CodexTurnState): CodexExplorationGroup {
    turnState.explorationGroupSequence += 1;
    return {
      activityId: `codex-exploring:${turnState.hostTurnId ?? turnState.turnId ?? "turn"}:${turnState.explorationGroupSequence}`,
      calls: []
    };
  }

  private closeExplorationGroup(turnState: CodexTurnState): void {
    turnState.currentExplorationGroup = undefined;
  }

  private explorationGroupStatus(group: CodexExplorationGroup): CodexActivity["status"] {
    if (group.calls.some((call) => call.status === "failed")) {
      return "failed";
    }
    if (group.calls.some((call) => call.status === "running")) {
      return "running";
    }
    return "succeeded";
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

    const response = session.resumeThreadRef
      ? await client.request("thread/resume", {
          threadId: session.resumeThreadRef,
          cwd,
          approvalPolicy: session.settings.approvalMode,
          sandbox: session.settings.sandboxMode,
          persistExtendedHistory: false
        })
      : await client.request("thread/start", {
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
    session.providerRef = threadId;
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
          this.closeExplorationGroup(session.turnState);
          session.turnState.queue.push({
            type: "assistant.delta",
            messageId: agentMessageDeltaId(params),
            delta
          });
        }
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const delta = codexReasoningSummaryDeltaFromParams(params);
        if (delta && session.turnState) {
          this.closeExplorationGroup(session.turnState);
          session.turnState.queue.push({
            type: "activity",
            ...this.updateReasoningSummary(session.turnState, delta)
          });
        }
        return;
      }
      case "item/reasoning/summaryPartAdded":
      case "item/reasoning/textDelta":
        return;
      case "item/started":
      case "item/completed": {
        const item = recordValue(params?.item);
        if (!item || !session.turnState) {
          return;
        }

        const activity = this.activityFromItem(
          session.turnState,
          item,
          message.method === "item/started"
        );
        if (activity) {
          session.turnState.queue.push(activity);
        }

        const assistantText = assistantTextFromItem(item);
        if (assistantText && message.method === "item/completed") {
          this.closeExplorationGroup(session.turnState);
          session.turnState.queue.push({
            type: "assistant.final",
            messageId: itemId(item),
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

  private assistantMessageState(
    turnState: CodexTurnState,
    messageId = turnState.assistantMessageId
  ): CodexAssistantMessageState {
    const existing = turnState.assistantMessages.get(messageId);
    if (existing) {
      return existing;
    }

    const created: CodexAssistantMessageState = {
      text: "",
      completed: false
    };
    turnState.assistantMessages.set(messageId, created);
    return created;
  }

  private completeAssistantMessage(
    ctx: NlaSessionHandlerContext,
    turnState: CodexTurnState,
    messageId: string | undefined,
    text: string
  ): void {
    const resolvedMessageId = messageId ?? turnState.assistantMessageId;
    const state = this.assistantMessageState(turnState, resolvedMessageId);
    state.text = text;

    if (state.completed) {
      return;
    }

    state.completed = true;
    ctx.emit("session.message", {
      sessionId: ctx.session.id,
      role: "assistant",
      text
    }, {
      id: resolvedMessageId
    });
  }

  private completePendingAssistantMessages(
    ctx: NlaSessionHandlerContext,
    turnState: CodexTurnState
  ): void {
    for (const [messageId, message] of turnState.assistantMessages) {
      if (!message.completed && message.text) {
        this.completeAssistantMessage(ctx, turnState, messageId, message.text);
      }
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
