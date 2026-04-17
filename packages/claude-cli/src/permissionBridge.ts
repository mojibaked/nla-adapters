import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { compactObject, parseJsonObject, recordValue, shellQuote, stringValue, type UnknownRecord } from "./shared.js";

const MCP_SERVER_NAME = "claude_permission_bridge";
const MCP_TOOL_NAME = "approve";
const MCP_PERMISSION_TOOL_ID = `mcp__${MCP_SERVER_NAME}__${MCP_TOOL_NAME}`;
const MCP_PROTOCOL_VERSION = "2024-11-05";

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan";

export interface ClaudePermissionBridgeOptions {
  readonly requestPermission: (input: {
    requestId: string;
    toolName: string;
    toolInput: unknown;
    toolUseId?: string;
    permissionRequest: UnknownRecord;
  }) => Promise<ClaudePermissionResult>;
  readonly requestQuestion: (input: {
    requestId: string;
    toolName: string;
    toolInput: unknown;
    toolUseId?: string;
    permissionRequest: UnknownRecord;
  }) => Promise<UnknownRecord>;
  readonly cwd?: string;
  readonly permissionMode?: ClaudePermissionMode;
  readonly timeoutMs?: number;
}

export interface ClaudePermissionBridgeStartResult {
  readonly socketPath: string;
  readonly mcpConfigPath: string;
  readonly settingsPath: string;
  readonly permissionTool: string;
}

export interface ClaudePermissionMcpServerOptions {
  readonly bridgePath: string;
  readonly input?: Readable;
}

export interface ClaudeHookBridgeOptions {
  readonly bridgePath: string;
}

interface PendingBridgeRequest {
  readonly mode: "permission" | "question";
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolUseId?: string;
}

interface JsonRpcRequest {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

interface BridgeEnvelope {
  readonly kind?: unknown;
  readonly payload?: unknown;
}

export interface ClaudePermissionResult {
  readonly behavior: "allow" | "deny";
  readonly updatedInput?: unknown;
  readonly message?: string;
  readonly toolUseID?: string;
}

export class ClaudePermissionBridge {
  private server?: net.Server;
  private socketPath?: string;
  private mcpConfigPath?: string;
  private settingsPath?: string;
  private tempDir?: string;
  private requestCounter = 0;
  private cwd?: string;
  private permissionMode: ClaudePermissionMode;
  private readonly timeoutMs: number;

  constructor(private readonly options: ClaudePermissionBridgeOptions) {
    this.cwd = stringValue(options.cwd);
    this.permissionMode = options.permissionMode ?? "default";
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  }

  setWorkingDirectory(cwd: string | undefined): void {
    this.cwd = stringValue(cwd);
  }

  setPermissionMode(mode: ClaudePermissionMode): void {
    this.permissionMode = mode;
  }

  async start(): Promise<ClaudePermissionBridgeStartResult> {
    if (this.socketPath && this.mcpConfigPath && this.settingsPath) {
      return {
        socketPath: this.socketPath,
        mcpConfigPath: this.mcpConfigPath,
        settingsPath: this.settingsPath,
        permissionTool: MCP_PERMISSION_TOOL_ID
      };
    }

    const tempDir = await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "claude-permission-bridge-"));
    const socketPath = path.join(tempDir, "bridge.sock");
    const mcpConfigPath = path.join(tempDir, "mcp.json");
    const settingsPath = path.join(tempDir, "settings.json");

    const server = net.createServer((socket) => {
      void this.handleSocket(socket).catch((error) => {
        socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    await fs.writeFile(
      mcpConfigPath,
      JSON.stringify(createClaudePermissionMcpConfig({ bridgePath: socketPath }), null, 2),
      "utf8"
    );
    await fs.writeFile(
      settingsPath,
      JSON.stringify(createClaudeHookSettings({ bridgePath: socketPath }), null, 2),
      "utf8"
    );

    this.server = server;
    this.tempDir = tempDir;
    this.socketPath = socketPath;
    this.mcpConfigPath = mcpConfigPath;
    this.settingsPath = settingsPath;

    return {
      socketPath,
      mcpConfigPath,
      settingsPath,
      permissionTool: MCP_PERMISSION_TOOL_ID
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    const tempDir = this.tempDir;
    this.tempDir = undefined;
    this.socketPath = undefined;
    this.mcpConfigPath = undefined;
    this.settingsPath = undefined;

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async handleSocket(socket: net.Socket): Promise<void> {
    const request = await readSocketJson(socket);
    const payload = recordValue(request) as BridgeEnvelope | undefined;
    const kind = stringValue(payload?.kind);

    const result = kind === "hook"
      ? await this.requestHookInput(payload?.payload)
      : await this.requestPermission(payload?.payload);

    await writeSocketJson(socket, result);
  }

  private async requestPermission(payload: unknown): Promise<ClaudePermissionResult> {
    const args = recordValue(payload) ?? {};
    const toolName = permissionToolName(args);
    const toolInput = permissionToolInput(args);
    const toolUseId = permissionToolUseId(args);
    const requestId = `claude-permission-${sanitizeId(toolUseId) || ++this.requestCounter}`;

    const autoAccepted = acceptEditsAutoApproval({
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      toolName,
      toolInput
    });
    if (autoAccepted) {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        toolUseID: toolUseId
      };
    }

    return withTimeout(
      this.options.requestPermission({
        requestId,
        toolName,
        toolInput,
        toolUseId,
        permissionRequest: args
      }),
      this.timeoutMs,
      `Claude permission request ${requestId} timed out.`
    );
  }

  private async requestHookInput(payload: unknown): Promise<UnknownRecord> {
    const hook = recordValue(payload) ?? {};
    const toolName = permissionToolName(hook);
    if (toolName !== "AskUserQuestion") {
      return preToolUseHookOutput({
        permissionDecision: "allow",
        permissionDecisionReason: "Allowed by the Claude adapter hook bridge.",
        updatedInput: permissionToolInput(hook)
      });
    }

    const toolInput = permissionToolInput(hook);
    const toolUseId = permissionToolUseId(hook);
    const requestId = `claude-question-${sanitizeId(toolUseId) || ++this.requestCounter}`;

    return withTimeout(
      this.options.requestQuestion({
        requestId,
        toolName,
        toolInput,
        toolUseId,
        permissionRequest: hook
      }),
      this.timeoutMs,
      `Claude question request ${requestId} timed out.`
    );
  }
}

export async function runClaudePermissionMcpServer(options: ClaudePermissionMcpServerOptions): Promise<void> {
  if (!options.bridgePath.trim()) {
    throw new Error("--bridge is required");
  }

  const rl = readline.createInterface({
    input: options.input || process.stdin,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    await handleMcpLine(line, options);
  }
}

export async function runClaudeHookBridge(options: ClaudeHookBridgeOptions): Promise<void> {
  if (!options.bridgePath.trim()) {
    throw new Error("--bridge is required");
  }

  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
  }

  const payload = chunks.join("").trim();
  const parsed = payload ? JSON.parse(payload) as unknown : {};
  const result = await sendHookRequestToBridge(options.bridgePath, parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function createClaudePermissionMcpConfig(input: {
  bridgePath: string;
}): UnknownRecord {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [defaultPermissionMcpEntrypointPath(), "--bridge", input.bridgePath]
      }
    }
  };
}

export function createClaudeHookSettings(input: {
  bridgePath: string;
}): UnknownRecord {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [
            {
              type: "command",
              command: [
                process.execPath,
                defaultHookEntrypointPath(),
                "--bridge",
                input.bridgePath
              ].map(shellQuote).join(" "),
              timeout: 3600
            }
          ]
        }
      ]
    }
  };
}

function defaultPermissionMcpEntrypointPath(): string {
  return fileURLToPath(new URL("./permissionMcp.js", import.meta.url));
}

function defaultHookEntrypointPath(): string {
  return fileURLToPath(new URL("./hook.js", import.meta.url));
}

async function handleMcpLine(
  line: string,
  options: ClaudePermissionMcpServerOptions
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    writeJsonRpcError(null, -32700, error instanceof Error ? error.message : String(error));
    return;
  }

  const request = recordValue(parsed) as JsonRpcRequest | undefined;
  if (!request?.method) {
    writeJsonRpcError(request?.id ?? null, -32600, "Invalid JSON-RPC request.");
    return;
  }

  if (request.id === undefined || request.id === null) {
    return;
  }

  switch (request.method) {
    case "initialize":
      writeJsonRpcResult(request.id, {
        protocolVersion: requestedProtocolVersion(request.params) || MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "claude-permission-bridge",
          version: "0.1.0"
        }
      });
      return;
    case "ping":
      writeJsonRpcResult(request.id, {});
      return;
    case "tools/list":
      writeJsonRpcResult(request.id, {
        tools: [
          {
            name: MCP_TOOL_NAME,
            description: "Ask the Claude adapter whether Claude may use a requested tool.",
            inputSchema: {
              type: "object",
              additionalProperties: true,
              properties: {
                tool_name: { type: "string" },
                tool_input: { type: "object", additionalProperties: true },
                tool_use_id: { type: "string" }
              }
            }
          }
        ]
      });
      return;
    case "resources/list":
      writeJsonRpcResult(request.id, { resources: [] });
      return;
    case "prompts/list":
      writeJsonRpcResult(request.id, { prompts: [] });
      return;
    case "tools/call":
      await handleToolCall(request as JsonRpcRequest & { id: string | number }, options);
      return;
    default:
      writeJsonRpcError(request.id, -32601, `Unsupported MCP method: ${request.method}`);
  }
}

async function handleToolCall(
  request: JsonRpcRequest & { id: string | number | null },
  options: ClaudePermissionMcpServerOptions
): Promise<void> {
  const params = recordValue(request.params) ?? {};
  const name = stringValue(params.name);
  if (name !== MCP_TOOL_NAME) {
    writeJsonRpcError(request.id, -32602, `Unsupported tool: ${name || "<missing>"}`);
    return;
  }

  try {
    const decision = await sendPermissionRequestToBridge(options.bridgePath, params.arguments);
    writeJsonRpcResult(request.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(decision)
        }
      ]
    });
  } catch (error) {
    writeJsonRpcResult(request.id, {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }
      ]
    });
  }
}

async function sendPermissionRequestToBridge(
  bridgePath: string,
  payload: unknown
): Promise<ClaudePermissionResult> {
  const response = await sendBridgeRequest(bridgePath, {
    kind: "permission",
    payload
  });

  if (!recordValue(response)) {
    throw new Error("Claude permission bridge returned a non-object response.");
  }
  if (typeof recordValue(response)?.error === "string") {
    throw new Error(String(recordValue(response)?.error));
  }

  return response as ClaudePermissionResult;
}

async function sendHookRequestToBridge(
  bridgePath: string,
  payload: unknown
): Promise<UnknownRecord> {
  const response = await sendBridgeRequest(bridgePath, {
    kind: "hook",
    payload
  });
  const record = recordValue(response);
  if (!record) {
    throw new Error("Claude hook bridge returned a non-object response.");
  }
  if (typeof record.error === "string") {
    throw new Error(record.error);
  }
  return record;
}

async function sendBridgeRequest(
  bridgePath: string,
  payload: UnknownRecord
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(bridgePath);
    const rl = readline.createInterface({
      input: socket,
      crlfDelay: Infinity
    });
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      rl.close();
      socket.end();
      fn();
    };

    socket.once("error", (error) => {
      finish(() => reject(error));
    });
    rl.once("line", (line) => {
      finish(() => {
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
}

async function readSocketJson(socket: net.Socket): Promise<unknown> {
  const rl = readline.createInterface({
    input: socket,
    crlfDelay: Infinity
  });

  return await new Promise<unknown>((resolve, reject) => {
    rl.once("line", (line) => {
      rl.close();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      rl.close();
      reject(error);
    });
  });
}

async function writeSocketJson(socket: net.Socket, payload: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requestedProtocolVersion(params: unknown): string | undefined {
  return stringValue(recordValue(params)?.protocolVersion);
}

function writeJsonRpcResult(id: string | number | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeJsonRpcError(id: string | number | null, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function permissionToolName(args: UnknownRecord): string {
  const direct =
    stringValue(args.tool_name) ||
    stringValue(args.toolName) ||
    stringValue(args.tool);
  if (direct) return direct;

  const tool = recordValue(args.tool);
  return stringValue(tool?.name) || "tool";
}

function permissionToolInput(args: UnknownRecord): unknown {
  if (Object.prototype.hasOwnProperty.call(args, "tool_input")) return args.tool_input;
  if (Object.prototype.hasOwnProperty.call(args, "toolInput")) return args.toolInput;
  if (Object.prototype.hasOwnProperty.call(args, "input")) return args.input;
  if (Object.prototype.hasOwnProperty.call(args, "arguments")) return args.arguments;
  return args;
}

function permissionToolUseId(args: UnknownRecord): string | undefined {
  return stringValue(args.tool_use_id) || stringValue(args.toolUseId);
}

function preToolUseHookOutput(input: {
  permissionDecision: "allow" | "deny" | "ask" | "defer";
  permissionDecisionReason?: string;
  updatedInput?: unknown;
}): UnknownRecord {
  return {
    suppressOutput: true,
    hookSpecificOutput: compactObject({
      hookEventName: "PreToolUse",
      permissionDecision: input.permissionDecision,
      permissionDecisionReason: input.permissionDecisionReason,
      updatedInput: input.updatedInput
    })
  };
}

function acceptEditsAutoApproval(input: {
  cwd?: string;
  permissionMode: ClaudePermissionMode;
  toolName: string;
  toolInput: unknown;
}): { reason: string } | undefined {
  if (input.permissionMode !== "acceptEdits" || !input.cwd) return undefined;

  if (isClaudeEditTool(input.toolName)) {
    const filePaths = claudeEditToolPaths(input.toolName, input.toolInput);
    if (filePaths.length > 0 && filePaths.every((filePath) => isAutoAcceptedWritablePath(filePath, input.cwd!))) {
      return { reason: "Claude acceptEdits file write inside cwd." };
    }
    return undefined;
  }

  if (input.toolName === "Bash") {
    const command = recordValue(input.toolInput) ? stringValue(recordValue(input.toolInput)?.command) : undefined;
    if (!command) return undefined;
    const operands = acceptedBashPathOperands(command);
    if (operands && operands.length > 0 && operands.every((filePath) => isAutoAcceptedWritablePath(filePath, input.cwd!))) {
      return { reason: "Claude acceptEdits filesystem command inside cwd." };
    }
  }

  return undefined;
}

function isClaudeEditTool(toolName: string): boolean {
  return ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName);
}

function claudeEditToolPaths(toolName: string, toolInput: unknown): string[] {
  const input = recordValue(toolInput) ?? {};
  const paths = [
    stringValue(input.file_path),
    stringValue(input.filePath),
    stringValue(input.path)
  ];
  if (toolName === "NotebookEdit") {
    paths.push(stringValue(input.notebook_path), stringValue(input.notebookPath));
  }
  return paths.filter((value): value is string => Boolean(value));
}

function acceptedBashPathOperands(command: string): string[] | undefined {
  if (hasShellControlSyntax(command)) return undefined;

  const words = shellWords(command);
  if (!words || words.length === 0) return undefined;

  const unwrapped = unwrapAcceptEditsCommand(words);
  if (!unwrapped || unwrapped.length === 0) return undefined;

  const executable = path.basename(unwrapped[0]);
  const args = unwrapped.slice(1);
  switch (executable) {
    case "mkdir":
    case "touch":
    case "rm":
    case "rmdir":
      return simpleFilesystemPathOperands(args);
    case "mv":
    case "cp":
      return simpleFilesystemPathOperands(args).length >= 2
        ? simpleFilesystemPathOperands(args)
        : undefined;
    case "sed":
      return sedWritablePathOperands(args);
    default:
      return undefined;
  }
}

function hasShellControlSyntax(command: string): boolean {
  return /[;&|<>`\r\n]/.test(command) || command.includes("$(");
}

function unwrapAcceptEditsCommand(words: string[]): string[] | undefined {
  let remaining = [...words];
  while (remaining.length > 0) {
    while (remaining.length > 0 && isSafeEnvironmentAssignment(remaining[0])) {
      remaining = remaining.slice(1);
    }

    const executable = path.basename(remaining[0] || "");
    if (executable === "nohup") {
      remaining = remaining.slice(1);
      continue;
    }
    if (executable === "nice") {
      remaining = remaining.slice(1);
      while (remaining[0]?.startsWith("-")) remaining = remaining.slice(1);
      continue;
    }
    if (executable === "timeout") {
      remaining = remaining.slice(1);
      while (remaining[0]?.startsWith("-")) remaining = remaining.slice(1);
      if (remaining.length === 0) return undefined;
      remaining = remaining.slice(1);
      continue;
    }
    break;
  }
  return remaining.length > 0 ? remaining : undefined;
}

function isSafeEnvironmentAssignment(word: string): boolean {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
  if (!match) return false;
  return ["LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR"].includes(match[1]);
}

function simpleFilesystemPathOperands(args: string[]): string[] {
  const operands: string[] = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) continue;
    operands.push(arg);
  }
  return operands;
}

function sedWritablePathOperands(args: string[]): string[] | undefined {
  let hasInPlace = false;
  let sawScript = false;
  const operands: string[] = [];
  let afterDoubleDash = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && (arg === "-i" || arg.startsWith("-i"))) {
      hasInPlace = true;
      continue;
    }
    if (!afterDoubleDash && arg === "-e") {
      index += 1;
      sawScript = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-e")) {
      sawScript = true;
      continue;
    }
    if (!afterDoubleDash && arg === "-f") {
      return undefined;
    }
    if (!afterDoubleDash && arg.startsWith("-")) continue;
    if (!sawScript) {
      sawScript = true;
      continue;
    }
    operands.push(arg);
  }

  return hasInPlace && operands.length > 0 ? operands : undefined;
}

function isAutoAcceptedWritablePath(filePath: string, cwd: string): boolean {
  if (!filePath || filePath.includes("\0")) return false;
  if (hasShellPathExpansion(filePath)) return false;
  const cwdResolved = path.resolve(cwd);
  const resolved = path.resolve(cwdResolved, filePath);
  const relative = path.relative(cwdResolved, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return !isProtectedClaudePath(relative);
}

function hasShellPathExpansion(filePath: string): boolean {
  return filePath.startsWith("~") || filePath.includes("$") || /[*?\[\]{}]/.test(filePath);
}

function isProtectedClaudePath(relativePath: string): boolean {
  const parts = relativePath.split(path.sep).filter(Boolean);
  const basename = parts.at(-1);
  if (basename && [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json", ".claude.json"].includes(basename)) {
    return true;
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === ".claude") {
      const next = parts[index + 1];
      if (next && ["commands", "agents", "skills", "worktrees"].includes(next)) continue;
      return true;
    }
    if ([".git", ".vscode", ".idea", ".husky"].includes(part)) return true;
  }
  return false;
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === "\"" && char === "\\") {
        index += 1;
        if (index < command.length) current += command[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      if (index < command.length) current += command[index];
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) return undefined;
  if (current) words.push(current);
  return words;
}

function sanitizeId(value: string | undefined): string | undefined {
  const clean = value?.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  if (timeoutMs <= 0) {
    return await promise;
  }

  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}
