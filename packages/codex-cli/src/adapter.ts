import { defineAdapter, type NlaAdapterDefinition } from "@nla/sdk-core";
import { NLA_THREADS_PROFILE_V1 } from "@nla/protocol";
import { loadCodexAdapterConfig } from "./config.js";
import { CodexNlaRuntime } from "./runtime.js";
import type {
  CodexAdapterDependencies,
  CreateCodexAdapterOptions
} from "./types.js";

export type {
  CodexAdapterDependencies,
  CodexLocalImageInput,
  CodexTextInput,
  CodexTurnInput,
  CodexUserInput,
  CreateCodexAdapterOptions
} from "./types.js";
export { prepareCodexTurn } from "./inputs.js";

export const createCodexAdapter = (
  dependencies: CodexAdapterDependencies,
  options: CreateCodexAdapterOptions = {}
): NlaAdapterDefinition => {
  const runtime = new CodexNlaRuntime(
    dependencies,
    options.config ?? loadCodexAdapterConfig(),
    options.createClient
  );

  return defineAdapter({
    id: "codex.cli",
    name: "Codex CLI Adapter",
    description: [
      "Process-backed Codex adapter using `codex app-server` over stdio.",
      "Authored directly as an NLA session adapter."
    ].join(" "),
    capabilities: {
      sessions: true,
      streaming: true,
      interactions: true,
      sessionControls: true,
      history: true,
      threads: {
        list: true,
        history: true,
        resume: true
      }
    },
    profiles: {
      [NLA_THREADS_PROFILE_V1]: {
        list: true,
        history: true,
        attach: true
      }
    },
    threadsList: async (ctx, message) => {
      await runtime.listThreads(ctx, message);
    },
    threadsHistory: async (ctx, message) => {
      await runtime.getThreadHistory(ctx, message);
    },
    sessionStart: async (ctx, message) => {
      runtime.startOrResumeSession(ctx, message);
    },
    sessionResume: async (ctx, message) => {
      runtime.startOrResumeSession(ctx, message);
    },
    sessionMessage: async (ctx, message) => {
      await runtime.handleTurn(ctx, message);
    },
    sessionControls: async (ctx) =>
      runtime.sessionControlsForSession(ctx.session.id),
    sessionInput: async (ctx, message) => {
      await runtime.handleInput(ctx, message);
    },
    sessionInterrupt: async (ctx, message) => {
      await runtime.handleSessionInterrupt(ctx, message);
    },
    sessionControl: async (ctx, message) => {
      runtime.handleSessionControl(ctx, message);
    },
    sessionStop: async (ctx, _message) => {
      runtime.stopSession(ctx.session.id);
      ctx.stopped();
    }
  });
};
