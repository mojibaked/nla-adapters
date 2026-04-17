import { runAdapterStdio } from "@nla/transport-stdio-jsonl";
import {
  createClaudeAdapter,
  type ClaudeAdapterDependencies,
  type CreateClaudeAdapterOptions
} from "./adapter.js";

export const runClaudeAdapterStdio = (
  dependencies: ClaudeAdapterDependencies = {},
  options: CreateClaudeAdapterOptions = {}
): Promise<void> =>
  runAdapterStdio(createClaudeAdapter(dependencies, options));
