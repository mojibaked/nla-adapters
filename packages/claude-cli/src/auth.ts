import { spawn } from "node:child_process";
import path from "node:path";
import type { ClaudeAdapterConfig } from "./config.js";
import { parseJsonObject } from "./shared.js";

export const shouldRunClaudeAuthCheck = (command: string): boolean =>
  path.basename(command) === "claude";

export const checkClaudeAuth = async (
  config: ClaudeAdapterConfig,
  cwd: string
): Promise<boolean | undefined> => {
  if (!shouldRunClaudeAuthCheck(config.command)) {
    return undefined;
  }

  const result = await captureCommand(
    config.command,
    [...config.commandArgs, ...config.authStatusArgs],
    cwd,
    config.childEnv,
    8_000
  );
  if (!result) {
    return undefined;
  }

  const text = `${result.stdout}\n${result.stderr}`.trim();
  const parsed =
    parseJsonObject(result.stdout.trim()) ||
    parseJsonObject(result.stderr.trim()) ||
    parseJsonObject(text);

  if (typeof parsed?.loggedIn === "boolean") {
    return parsed.loggedIn;
  }
  if (/\blogged\s+in\b/i.test(text) && !/\bnot\s+logged\s+in\b/i.test(text)) {
    return true;
  }
  if (/\bnot\s+logged\s+in\b|\blogin\s+required\b|\bunauthenticated\b/i.test(text)) {
    return false;
  }
  return undefined;
};

const captureCommand = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string } | undefined> =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      resolve(undefined);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    const timer = setTimeout(() => {
      finish(null);
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => {
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
