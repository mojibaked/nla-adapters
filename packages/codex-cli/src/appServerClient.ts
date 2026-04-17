import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export type JsonRpcId = string | number;

export interface CodexAppServerRequestMessage {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

export interface CodexAppServerNotificationMessage {
  readonly method: string;
  readonly params: unknown;
}

export interface CodexAppServerClientHandlers {
  readonly onServerRequest: (message: CodexAppServerRequestMessage) => void;
  readonly onNotification: (message: CodexAppServerNotificationMessage) => void;
  readonly onStderr?: (line: string) => void;
  readonly onExit?: (error: Error) => void;
}

export interface CodexAppServerClient {
  readonly start: () => Promise<void>;
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  readonly notify: (method: string, params?: unknown) => void;
  readonly respond: (id: JsonRpcId, result: unknown) => void;
  readonly stop: () => void;
  readonly isRunning: () => boolean;
}

export interface CreateCodexAppServerClientOptions {
  readonly command: string;
  readonly commandArgs: ReadonlyArray<string>;
  readonly appServerArgs: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export const createCodexAppServerClient = (
  options: CreateCodexAppServerClientOptions,
  handlers: CodexAppServerClientHandlers
): CodexAppServerClient => new RealCodexAppServerClient(options, handlers);

class RealCodexAppServerClient implements CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutReader: readline.Interface | undefined;
  private stderrReader: readline.Interface | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;

  constructor(
    private readonly options: CreateCodexAppServerClientOptions,
    private readonly handlers: CodexAppServerClientHandlers
  ) {}

  start(): Promise<void> {
    if (this.isRunning()) {
      return Promise.resolve();
    }

    const child = spawn(
      this.options.command,
      [...this.options.commandArgs, ...this.options.appServerArgs],
      {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    this.child = child;
    this.stdoutReader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });
    this.stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity
    });

    this.stdoutReader.on("line", (line) => {
      this.handleLine(line);
    });
    this.stderrReader.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        this.handlers.onStderr?.(trimmed);
      }
    });
    child.once("error", (error) => {
      this.handleExit(new Error(`Failed to start Codex app-server: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      this.handleExit(new Error(`Codex app-server exited code=${code ?? ""} signal=${signal ?? ""}`.trim()));
    });

    return this.request("initialize", {
      clientInfo: {
        name: "nla-adapters-codex-cli",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    }).then(() => {
      this.notify("initialized");
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || !this.isRunning()) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = `codex-${++this.nextId}`;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || !this.isRunning()) {
      return;
    }

    const message = params === undefined
      ? { method }
      : { method, params };
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  respond(id: JsonRpcId, result: unknown): void {
    const child = this.child;
    if (!child || !this.isRunning()) {
      return;
    }

    child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  stop(): void {
    if (!this.child || !this.isRunning()) {
      return;
    }

    this.child.kill("SIGTERM");
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      this.handlers.onStderr?.(
        `Codex app-server emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const record = parsed as Record<string, unknown>;
    const id = record.id;
    const method = typeof record.method === "string" ? record.method : undefined;

    if (method && (typeof id === "string" || typeof id === "number")) {
      this.handlers.onServerRequest({
        id,
        method,
        params: record.params
      });
      return;
    }

    if ((typeof id === "string" || typeof id === "number") && ("result" in record || "error" in record)) {
      const key = String(id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }

      this.pending.delete(key);
      if ("error" in record && record.error) {
        const errorRecord = record.error && typeof record.error === "object"
          ? record.error as Record<string, unknown>
          : undefined;
        pending.reject(new Error(stringValue(errorRecord?.message) ?? `Codex request failed: ${key}`));
        return;
      }

      pending.resolve(record.result);
      return;
    }

    if (method) {
      this.handlers.onNotification({
        method,
        params: record.params
      });
    }
  }

  private handleExit(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = undefined;
    this.stderrReader = undefined;
    this.child = undefined;

    for (const request of pending) {
      request.reject(error);
    }

    this.handlers.onExit?.(error);
  }
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
