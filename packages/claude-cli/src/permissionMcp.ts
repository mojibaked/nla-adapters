import { runClaudePermissionMcpServer } from "./permissionBridge.js";

const readBridgePath = (argv: ReadonlyArray<string>): string => {
  const flagIndex = argv.indexOf("--bridge");
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (!value?.trim()) {
    throw new Error("--bridge is required");
  }
  return value.trim();
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

runClaudePermissionMcpServer({
  bridgePath: readBridgePath(process.argv.slice(2))
}).catch((error) => {
  process.stderr.write(`[claude-permission-mcp] ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
