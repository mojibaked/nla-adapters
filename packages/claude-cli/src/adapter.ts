import { defineAdapter, type NlaAdapterDefinition } from "@nla/sdk-core";
import {
  NLA_THREADS_PROFILE_V1,
  type NlaSessionInterruptMessage
} from "@nla/protocol";
import { loadClaudeAdapterConfig } from "./config.js";
import { ClaudeNlaRuntime } from "./runtime.js";
import type {
  ClaudeAdapterDependencies,
  CreateClaudeAdapterOptions
} from "./types.js";

export type {
  ClaudeAdapterDependencies,
  CreateClaudeAdapterOptions
} from "./types.js";
export { prepareClaudePrompt } from "./inputs.js";

export const createClaudeAdapter = (
  dependencies: ClaudeAdapterDependencies = {},
  options: CreateClaudeAdapterOptions = {}
): NlaAdapterDefinition => {
  const runtime = new ClaudeNlaRuntime(
    dependencies,
    options.config ?? loadClaudeAdapterConfig()
  );

  return defineAdapter({
    id: "claude.cli",
    name: "Claude CLI Adapter",
    description: [
      "Process-backed Claude adapter using Claude stream-json sessions.",
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
    sessionInterrupt: async (ctx, message: NlaSessionInterruptMessage) => {
      await runtime.handleSessionInterrupt(ctx, message);
    },
    sessionControl: async (ctx, message) => {
      runtime.handleSessionControl(ctx, message);
    },
    sessionStop: async (ctx) => {
      await runtime.stopSession(ctx.session.id);
      ctx.stopped();
    }
  });
};

export const ClaudeAdapter = createClaudeAdapter();
