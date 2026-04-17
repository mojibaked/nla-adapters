export type CodexAuthMode = "check" | "skip";

export interface CodexAdapterConfig {
  readonly command: string;
  readonly commandArgs: ReadonlyArray<string>;
  readonly appServerArgs: ReadonlyArray<string>;
  readonly authMode: CodexAuthMode;
  readonly authStatusArgs: ReadonlyArray<string>;
  readonly childEnv: NodeJS.ProcessEnv;
}

const DefaultAppServerArgs = ["app-server"] as const;
const DefaultAuthStatusArgs = ["login", "status"] as const;

export const loadCodexAdapterConfig = (
  env: NodeJS.ProcessEnv = process.env
): CodexAdapterConfig => ({
  command: env.CODEX_ADAPTER_COMMAND?.trim() || "codex",
  commandArgs: readJsonStringArray(env.CODEX_ADAPTER_COMMAND_ARGS_JSON),
  appServerArgs: readJsonStringArray(env.CODEX_ADAPTER_APP_SERVER_ARGS_JSON, DefaultAppServerArgs),
  authMode: readAuthMode(env.CODEX_ADAPTER_AUTH_MODE),
  authStatusArgs: readJsonStringArray(
    env.CODEX_ADAPTER_AUTH_STATUS_ARGS_JSON,
    DefaultAuthStatusArgs
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

const readAuthMode = (value: string | undefined): CodexAuthMode => {
  switch (value?.trim()) {
    case undefined:
    case "":
    case "check":
      return "check";
    case "skip":
      return "skip";
    default:
      throw new Error(`Unsupported CODEX_ADAPTER_AUTH_MODE: ${value}`);
  }
};
