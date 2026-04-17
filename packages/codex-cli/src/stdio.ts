import { runAdapterStdio } from "@nla/transport-stdio-jsonl";
import {
  createCodexAdapter,
  type CodexAdapterDependencies,
  type CreateCodexAdapterOptions
} from "./adapter.js";

export const runCodexAdapterStdio = (
  dependencies: CodexAdapterDependencies,
  options: CreateCodexAdapterOptions = {}
): Promise<void> =>
  runAdapterStdio(createCodexAdapter(dependencies, options));
