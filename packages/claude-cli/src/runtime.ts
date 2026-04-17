import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
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
import { checkClaudeAuth } from "./auth.js";
import {
  claudePermissionModeLabel,
  claudeSessionControls,
  parseClaudePermissionMode
} from "./controls.js";
import type { ClaudeAdapterConfig } from "./config.js";
import {
  buildClaudeApprovalRequest,
  buildClaudeApprovalResolution,
  buildClaudeQuestionRequest,
  buildClaudeQuestionResolution,
  prepareClaudePrompt
} from "./inputs.js";
import { parseClaudeOutputLine } from "./notifications.js";
import { ClaudePermissionBridge, type ClaudePermissionResult } from "./permissionBridge.js";
import { recordValue, stringValue, type UnknownRecord } from "./shared.js";
import {
  AsyncQueue,
  ClaudeAdapterError,
  type ClaudeAdapterDependencies,
  DefaultClaudeRuntimeSettings,
  type ClaudeSessionState,
  type PendingClaudeApprovalInput,
  type PendingClaudeQuestionInput
} from "./types.js";

export class ClaudeNlaRuntime {
  private readonly sessions = new Map<string, ClaudeSessionState>();
  private readonly dependencies: ClaudeAdapterDependencies;
  private readonly config: ClaudeAdapterConfig;

  constructor(
    dependencies: ClaudeAdapterDependencies,
    config: ClaudeAdapterConfig
  ) {
    this.dependencies = dependencies;
    this.config = config;
  }

  startOrResumeSession(
    ctx: NlaSessionHandlerContext,
    message: NlaSessionStartMessage | NlaSessionResumeMessage
  ): void {
    const session = this.sessionState(ctx.session.id);
    const cwd = sessionCwd(message);
    if (cwd) {
      session.cwd = cwd;
    }

    if ("providerRef" in message.data) {
      const providerRef = stringValue(message.data.providerRef);
      if (providerRef && !isPlaceholderProviderRef(providerRef)) {
        session.providerRef = providerRef;
        session.claudeSessionRef = providerRef;
      }
    }

    session.bridge?.setWorkingDirectory(session.cwd);
    session.bridge?.setPermissionMode(session.settings.permissionMode);

    ctx.setProviderRef(session.providerRef);
    ctx.started({
      providerRef: session.providerRef,
      state: startedState(session)
    });
    ctx.execution({
      state: "idle",
      interruptible: false
    });
  }

  sessionControlsForSession(sessionId: string): ReadonlyArray<NlaSessionControlDefinition> {
    return claudeSessionControls(this.sessionState(sessionId).settings);
  }

  async handleTurn(
    ctx: NlaSessionHandlerContext,
    message: NlaSessionMessage
  ): Promise<void> {
    const session = this.sessionState(ctx.session.id);
    if (session.turnState) {
      this.emitTurnFailure(ctx, "Claude is already working on a turn", "session_busy");
      return;
    }

    try {
      const prompt = await Effect.runPromise(
        prepareClaudePrompt(this.dependencies, message.data, session.cwd)
      );
      const assistantMessageId = ctx.createId("msg");
      const authenticated = this.config.authMode === "skip"
        ? true
        : await checkClaudeAuth(this.config, session.cwd);

      if (authenticated === false) {
        throw new ClaudeAdapterError(
          "Claude CLI is not authenticated on this host. Run `claude auth login` in the target workspace, then retry.",
          "claude_auth_required"
        );
      }

      await this.ensureClient(session);

      session.turnState = {
        queue: new AsyncQueue(),
        assistantMessageId,
        turnId: metadataTurnId(message.data.metadata),
        assistantText: "",
        finalAssistantText: undefined,
        activitySequence: 0
      };

      ctx.execution({
        state: "running",
        turnId: metadataTurnId(message.data.metadata),
        interruptible: true
      });
      this.emitMainActivity(ctx, "running", "Running Claude");
      this.requireChild(session).stdin.write(`${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: prompt
        }
      })}\n`);

      await this.driveTurn(session, ctx);
    } catch (error) {
      session.turnState = undefined;
      this.emitMainActivity(ctx, "failed", "Claude failed");
      const claudeError = toClaudeError(error);
      this.emitTurnFailure(ctx, claudeError.message, claudeError.code);
    }
  }

  async handleInput(
    ctx: NlaSessionHandlerContext,
    message: NlaSessionInteractionResolveMessage
  ): Promise<void> {
    const session = this.sessions.get(ctx.session.id);
    const requestId = message.data.resolution.requestId;
    const pending = session?.pendingInputs.get(requestId);

    if (!session || !pending || !session.turnState) {
      this.emitTurnFailure(
        ctx,
        `Unknown Claude input request: ${requestId}`,
        "unknown_input_request"
      );
      return;
    }

    try {
      session.pendingInputs.delete(requestId);
      ctx.resolveInput({
        resolution: message.data.resolution
      });

      switch (pending.kind) {
        case "approval":
          pending.resolve(buildClaudeApprovalResolution(pending, message.data.resolution));
          break;
        case "form":
          pending.resolve(buildClaudeQuestionResolution(pending, message.data.resolution));
          break;
      }

      ctx.execution({
        state: "running",
        turnId: session.turnState.turnId ?? metadataTurnId(message.data.metadata),
        interruptible: true
      });
      this.emitMainActivity(ctx, "running", "Resuming Claude");
      await this.driveTurn(session, ctx);
    } catch (error) {
      session.turnState = undefined;
      this.emitMainActivity(ctx, "failed", "Claude failed");
      const claudeError = toClaudeError(error);
      this.emitTurnFailure(ctx, claudeError.message, claudeError.code);
    }
  }

  async handleSessionInterrupt(
    ctx: NlaSessionHandlerContext,
    message: NlaSessionInterruptMessage
  ): Promise<void> {
    const requestedTurnId = message.data.turnId?.trim() || undefined;
    const result = await this.interruptTurn(ctx.session.id, requestedTurnId);

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
        label: "Claude is already working on a turn"
      });
      return;
    }

    switch (controlId) {
      case "permission_mode": {
        const nextValue = parseClaudePermissionMode(message.data.optionId);
        if (!nextValue) {
          ctx.controlState({
            controlId,
            status: "rejected",
            label: "Choose a valid Claude mode"
          });
          return;
        }

        session.settings = {
          ...session.settings,
          permissionMode: nextValue
        };
        session.bridge?.setPermissionMode(nextValue);
        ctx.controlState({
          controlId,
          status: "applied",
          optionId: nextValue,
          label: claudePermissionModeLabel(nextValue)
        });
        return;
      }
      default:
        ctx.controlState({
          controlId,
          status: "unsupported",
          label: `Unsupported Claude control: ${controlId}`
        });
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    for (const pending of session.pendingInputs.values()) {
      pending.reject(new Error("Claude session stopped"));
    }
    session.pendingInputs.clear();
    session.turnState = undefined;

    await this.stopChild(session);
    if (session.bridge) {
      await session.bridge.stop();
      session.bridge = undefined;
    }

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
    if (!session || !turnState) {
      return {
        status: "no_active_work",
        message: "No active Claude turn"
      };
    }

    for (const pending of session.pendingInputs.values()) {
      pending.reject(new ClaudeAdapterError("Claude turn interrupted", "claude_interrupted"));
    }
    session.pendingInputs.clear();

    turnState.queue.push({
      type: "interrupted"
    });
    session.turnState = undefined;

    await this.interruptChild(session);

    return {
      status: "interrupted",
      turnId,
      message: "Interrupted"
    };
  }

  private async driveTurn(
    session: ClaudeSessionState,
    ctx: NlaSessionHandlerContext
  ): Promise<void> {
    const turnState = session.turnState;
    if (!turnState) {
      throw new ClaudeAdapterError("Missing Claude turn state", "claude_missing_turn_state");
    }

    while (true) {
      const event = await turnState.queue.next();

      switch (event.type) {
        case "assistant.delta":
          if (event.providerMessageId) {
            turnState.providerMessageId = event.providerMessageId;
          }
          turnState.assistantText += event.delta;
          ctx.messageDelta({
            messageId: turnState.assistantMessageId,
            role: "assistant",
            delta: event.delta
          });
          continue;
        case "assistant.final":
          if (event.providerMessageId) {
            turnState.providerMessageId = event.providerMessageId;
          }
          turnState.finalAssistantText = event.text;
          continue;
        case "activity":
          ctx.activity({
            activityId: event.activityId,
            title: event.title,
            status: event.status
          });
          continue;
        case "interaction.requested":
          ctx.execution({
            state: "awaiting_input",
            turnId: session.turnState?.turnId,
            interruptible: true
          });
          this.emitMainActivity(ctx, "running", "Claude is waiting for input");
          ctx.requestInput({
            request: event.request
          });
          return;
        case "turn.completed": {
          const finalText = turnState.finalAssistantText ?? turnState.assistantText;
          session.turnState = undefined;

          if (event.status === "completed") {
            this.emitMainActivity(ctx, "succeeded", "Claude completed");
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

          throw new ClaudeAdapterError(event.message ?? "Claude turn failed", "claude_turn_failed");
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

  private sessionState(sessionId: string): ClaudeSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: ClaudeSessionState = {
      sessionId,
      providerRef: placeholderProviderRef(sessionId),
      settings: DefaultClaudeRuntimeSettings,
      cwd: process.cwd(),
      pendingInputs: new Map()
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private async ensureClient(session: ClaudeSessionState): Promise<ChildProcessWithoutNullStreams> {
    const existing = session.child;
    if (existing && existing.exitCode === null && !existing.killed) {
      return existing;
    }

    const bridge = await this.ensureBridge(session);
    const bridgeStart = await bridge.start();
    const args = [
      ...this.config.commandArgs,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config",
      bridgeStart.mcpConfigPath,
      "--settings",
      bridgeStart.settingsPath,
      "--allowedTools",
      bridgeStart.permissionTool,
      "--permission-prompt-tool",
      bridgeStart.permissionTool
    ];

    if (session.claudeSessionRef && !isPlaceholderProviderRef(session.claudeSessionRef)) {
      args.push("--resume", session.claudeSessionRef);
    }

    const child = spawn(this.config.command, args, {
      cwd: session.cwd,
      env: this.config.childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutReader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });
    const stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity
    });

    session.child = child;
    session.stdoutReader = stdoutReader;
    session.stderrReader = stderrReader;

    stdoutReader.on("line", (line) => {
      this.handleClaudeOutputLine(session, line);
    });
    stderrReader.on("line", (line) => {
      this.handleClaudeStderrLine(session, line);
    });
    child.on("error", (error) => {
      this.handleChildExit(session, new ClaudeAdapterError(
        `Failed to start Claude CLI: ${error.message}`,
        "claude_start_failed"
      ));
    });
    child.on("exit", (code, signal) => {
      this.handleChildExit(
        session,
        code === 0
          ? undefined
          : new ClaudeAdapterError(
              `Claude exited code=${code ?? ""} signal=${signal ?? ""}`.trim(),
              "claude_process_exit"
            )
      );
    });

    return child;
  }

  private async ensureBridge(session: ClaudeSessionState): Promise<ClaudePermissionBridge> {
    if (session.bridge) {
      session.bridge.setWorkingDirectory(session.cwd);
      session.bridge.setPermissionMode(session.settings.permissionMode);
      return session.bridge;
    }

    const bridge = new ClaudePermissionBridge({
      cwd: session.cwd,
      permissionMode: session.settings.permissionMode,
      requestPermission: async (input) =>
        this.requestPermission(session, input),
      requestQuestion: async (input) =>
        this.requestQuestion(session, input)
    });

    session.bridge = bridge;
    return bridge;
  }

  private requestPermission(
    session: ClaudeSessionState,
    input: {
      requestId: string;
      toolName: string;
      toolInput: unknown;
      toolUseId?: string;
      permissionRequest: UnknownRecord;
    }
  ): Promise<ClaudePermissionResult> {
    const turnState = session.turnState;
    if (!turnState) {
      return Promise.reject(
        new ClaudeAdapterError(
          "Claude requested approval without an active turn",
          "claude_missing_turn_state"
        )
      );
    }

    return new Promise<ClaudePermissionResult>((resolve, reject) => {
      const pending: PendingClaudeApprovalInput = {
        requestId: input.requestId,
        kind: "approval",
        waitStatus: "awaiting_approval",
        request: buildClaudeApprovalRequest(input),
        toolName: input.toolName,
        toolInput: input.toolInput,
        toolUseId: input.toolUseId,
        permissionRequest: input.permissionRequest,
        resolve,
        reject
      };

      session.pendingInputs.set(pending.requestId, pending);
      turnState.queue.push({
        type: "interaction.requested",
        status: pending.waitStatus,
        request: pending.request
      });
    });
  }

  private requestQuestion(
    session: ClaudeSessionState,
    input: {
      requestId: string;
      toolName: string;
      toolInput: unknown;
      toolUseId?: string;
      permissionRequest: UnknownRecord;
    }
  ): Promise<UnknownRecord> {
    const turnState = session.turnState;
    if (!turnState) {
      return Promise.reject(
        new ClaudeAdapterError(
          "Claude requested input without an active turn",
          "claude_missing_turn_state"
        )
      );
    }

    return new Promise<UnknownRecord>((resolve, reject) => {
      const question = buildClaudeQuestionRequest(input);
      const pending: PendingClaudeQuestionInput = {
        requestId: input.requestId,
        kind: "form",
        waitStatus: "awaiting_input",
        request: question.request,
        toolName: input.toolName,
        toolInput: input.toolInput,
        toolUseId: input.toolUseId,
        permissionRequest: input.permissionRequest,
        answerKey: question.answerKey,
        optionLabels: question.optionLabels,
        resolve,
        reject
      };

      session.pendingInputs.set(pending.requestId, pending);
      turnState.queue.push({
        type: "interaction.requested",
        status: pending.waitStatus,
        request: pending.request
      });
    });
  }

  private handleClaudeOutputLine(session: ClaudeSessionState, line: string): void {
    let parsed;
    try {
      parsed = parseClaudeOutputLine(line);
    } catch (error) {
      if (session.turnState) {
        session.turnState.queue.push({
          type: "fatal",
          error: toClaudeError(error)
        });
      }
      return;
    }

    if (parsed.claudeSessionRef) {
      session.claudeSessionRef = parsed.claudeSessionRef;
      session.providerRef = parsed.claudeSessionRef;
    }

    const turnState = session.turnState;
    if (!turnState) {
      return;
    }

    for (const event of parsed.events) {
      turnState.queue.push(event);
    }
  }

  private handleClaudeStderrLine(session: ClaudeSessionState, line: string): void {
    const text = line.trim();
    if (!text || !session.turnState) {
      return;
    }

    session.turnState.activitySequence += 1;
    session.turnState.queue.push({
      type: "activity",
      activityId: `claude:${session.sessionId}:stderr:${session.turnState.activitySequence}`,
      title: text,
      status: "running"
    });
  }

  private handleChildExit(
    session: ClaudeSessionState,
    error?: ClaudeAdapterError
  ): void {
    if (session.stdoutReader) {
      session.stdoutReader.close();
      session.stdoutReader = undefined;
    }
    if (session.stderrReader) {
      session.stderrReader.close();
      session.stderrReader = undefined;
    }
    session.child = undefined;

    if (error && session.turnState) {
      session.turnState.queue.push({
        type: "fatal",
        error
      });
    }
  }

  private async stopChild(session: ClaudeSessionState): Promise<void> {
    const child = session.child;
    if (!child) {
      if (session.stdoutReader) {
        session.stdoutReader.close();
        session.stdoutReader = undefined;
      }
      if (session.stderrReader) {
        session.stderrReader.close();
        session.stderrReader = undefined;
      }
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });

    child.kill("SIGTERM");
    await exited.catch(() => undefined);
    this.handleChildExit(session);
  }

  private async interruptChild(session: ClaudeSessionState): Promise<void> {
    const child = session.child;
    if (!child) {
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });

    child.kill("SIGINT");
    const interrupted = await Promise.race([
      exited.then(() => true),
      delay(250).then(() => false)
    ]);

    if (!interrupted && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      const terminated = await Promise.race([
        exited.then(() => true),
        delay(500).then(() => false)
      ]);
      if (!terminated && child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      await exited.catch(() => undefined);
      return;
    }

    await exited.catch(() => undefined);
  }

  private emitMainActivity(
    ctx: NlaSessionHandlerContext,
    status: "running" | "succeeded" | "failed",
    title: string
  ): void {
    ctx.activity({
      activityId: `claude:${ctx.session.id}`,
      title,
      status
    });
  }

  // Managed-agent adapters use `session.failed` to fail the current turn while
  // keeping the session alive for later turns. `ctx.fail(...)` would tear down
  // the sdk-core session state, which is not what wrappers like Claude want.
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

  private requireChild(session: ClaudeSessionState): ChildProcessWithoutNullStreams {
    if (!session.child || session.child.exitCode !== null || session.child.killed) {
      throw new ClaudeAdapterError("Claude CLI is not running", "claude_not_running");
    }
    return session.child;
  }
}

const sessionCwd = (
  message: NlaSessionStartMessage | NlaSessionResumeMessage
): string | undefined => {
  const metadata = recordValue(message.data.metadata);
  return stringValue(metadata?.cwd);
};

const metadataTurnId = (metadata: unknown): string | undefined =>
  stringValue(recordValue(metadata)?.turnId);

const startedState = (session: ClaudeSessionState): Record<string, unknown> => ({
  permissionMode: session.settings.permissionMode,
  ...(session.claudeSessionRef ? { claudeSessionRef: session.claudeSessionRef } : {})
});

// Claude only reveals its durable session id after stream-json output begins,
// so the adapter has to start with a stable placeholder providerRef.
const placeholderProviderRef = (sessionId: string): string => `claude.cli:${sessionId}`;

const isPlaceholderProviderRef = (providerRef: string): boolean =>
  providerRef.startsWith("claude.cli:");

const toClaudeError = (error: unknown): ClaudeAdapterError =>
  error instanceof ClaudeAdapterError
    ? error
    : new ClaudeAdapterError(error instanceof Error ? error.message : String(error));

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
