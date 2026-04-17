export type ClaudeAuthMode = "check" | "skip";

export interface ClaudeAdapterConfig {
  readonly command: string;
  readonly commandArgs: ReadonlyArray<string>;
  readonly authMode: ClaudeAuthMode;
  readonly authStatusArgs: ReadonlyArray<string>;
  readonly authLoginArgs: ReadonlyArray<string>;
  readonly childEnv: NodeJS.ProcessEnv;
}

const DefaultAuthStatusArgs = ["auth", "status", "--json"] as const;
const DefaultAuthLoginArgs = ["auth", "login"] as const;

export const loadClaudeAdapterConfig = (
  env: NodeJS.ProcessEnv = process.env
): ClaudeAdapterConfig => ({
  command: env.CLAUDE_ADAPTER_COMMAND?.trim() || "claude",
  commandArgs: readJsonStringArray(env.CLAUDE_ADAPTER_COMMAND_ARGS_JSON),
  authMode: readAuthMode(env.CLAUDE_ADAPTER_AUTH_MODE),
  authStatusArgs: readJsonStringArray(
    env.CLAUDE_ADAPTER_AUTH_STATUS_ARGS_JSON,
    DefaultAuthStatusArgs
  ),
  authLoginArgs: readJsonStringArray(
    env.CLAUDE_ADAPTER_AUTH_LOGIN_ARGS_JSON,
    DefaultAuthLoginArgs
  ),
  childEnv: { ...env }
});

const readJsonStringArray = (
  value: string | undefined,
  fallback: ReadonlyArray<string> = []
): ReadonlyArray<string> => {
  if (!value?.trim()) {
    return [...fallback];
  }

  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Expected a JSON string array");
  }

  return parsed.map((entry) => entry.trim()).filter(Boolean);
};

const readAuthMode = (value: string | undefined): ClaudeAuthMode => {
  switch (value?.trim()) {
    case undefined:
    case "":
    case "check":
      return "check";
    case "skip":
      return "skip";
    default:
      throw new Error(`Unsupported CLAUDE_ADAPTER_AUTH_MODE: ${value}`);
  }
};
