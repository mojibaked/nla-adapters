import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import type { AssetCapabilityClient } from "@nla-adapters/contracts";
import type { NlaSessionMessage, NlaSessionMessagePart } from "@nla/protocol";
import type { CodexAdapterConfig } from "./config.js";
import { stringValue } from "./shared.js";
import type { CodexTurnInput, CodexUserInput } from "./types.js";

export const prepareCodexTurn = (
  assets: Pick<AssetCapabilityClient, "materialize">,
  input: Pick<NlaSessionMessage["data"], "parts" | "text">
): Effect.Effect<CodexTurnInput, Error> =>
  Effect.gen(function* () {
    const parts = nlaSessionMessageParts(input);
    const collected = yield* Effect.forEach(parts, (part) => codexInputForPart(assets, part), {
      concurrency: "unbounded"
    });
    const prepared = collected.flat();

    if (prepared.length === 0) {
      return yield* Effect.fail(new Error("Codex input must include text or image content"));
    }

    return {
      input: prepared,
      cwd: process.cwd()
    } satisfies CodexTurnInput;
  });

export const checkCodexAuth = (
  config: CodexAdapterConfig,
  cwd: string
): Effect.Effect<boolean, Error> =>
  Effect.async<boolean, Error>((resume) => {
    const child = spawn(
      config.command,
      [...config.commandArgs, ...config.authStatusArgs],
      {
        cwd,
        env: config.childEnv,
        stdio: ["ignore", "ignore", "ignore"]
      }
    );

    let settled = false;

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resume(Effect.fail(new Error(`Failed to start Codex auth check: ${error.message}`)));
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resume(Effect.succeed(code === 0));
    });

    return Effect.sync(() => {
      if (!settled && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    });
  });

const nlaSessionMessageParts = (
  input: Pick<NlaSessionMessage["data"], "parts" | "text">
): ReadonlyArray<NlaSessionMessagePart> => {
  if (Array.isArray(input.parts) && input.parts.length > 0) {
    return input.parts;
  }

  if (typeof input.text === "string" && input.text.trim()) {
    return [
      {
        type: "text",
        text: input.text
      }
    ];
  }

  throw new Error("Codex input must include non-empty text or parts");
};

const codexInputForPart = (
  assets: Pick<AssetCapabilityClient, "materialize">,
  part: NlaSessionMessagePart
): Effect.Effect<ReadonlyArray<CodexUserInput>, Error> => {
  const type = stringValue(part.type);
  switch (type) {
    case "text":
      return Effect.succeed(typeof part.text === "string" && part.text.trim()
        ? [
            {
              type: "text",
              text: part.text,
              text_elements: []
            }
          ]
        : []);
    case "image": {
      const record = part as Record<string, unknown>;
      const assetId = stringValue(record.assetId);
      if (!assetId) {
        return Effect.fail(new Error("Codex image parts must include assetId"));
      }

      const filename = stringValue(record.filename);
      return assets.materialize({
        assetId,
        filename,
        location: "session-cwd"
      }).pipe(
        Effect.map((path) => [
          {
            type: "localImage",
            path
          }
        ] as const)
      );
    }
    case "localImage": {
      const record = part as Record<string, unknown>;
      const path = stringValue(record.path);
      if (!path) {
        return Effect.fail(new Error("Codex localImage parts must include path"));
      }

      return Effect.succeed([
        {
          type: "localImage",
          path
        }
      ]);
    }
    default:
      return Effect.fail(new Error(`Unsupported Codex input part type: ${type ?? "(empty)"}`));
  }
};
