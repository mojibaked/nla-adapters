import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { BrowserClient, BrowserTab } from "./types.js";

/**
 * Minimal surface of the MCP Client we depend on. The real
 * @modelcontextprotocol/sdk Client satisfies this; tests can
 * provide a hand-rolled fake.
 */
export interface McpToolCaller {
  callTool(request: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    content?: ReadonlyArray<{ type?: string; text?: string }>;
    isError?: boolean;
  }>;
}

export interface McpBrowserClientOptions {
  readonly client: McpToolCaller | Client;
  /** Prefix for tool names if the host namespaces browser-mcp tools. */
  readonly toolPrefix?: string;
}

export const createMcpBrowserClient = (
  options: McpBrowserClientOptions
): BrowserClient => {
  const client = options.client as McpToolCaller;
  const prefix = options.toolPrefix ?? "";
  const tool = (name: string) => `${prefix}${name}`;

  return {
    async openTab(url: string): Promise<BrowserTab> {
      const result = await callTool(client, tool("tab_open"), { url });
      const payload = expectJson(result, "tab_open");
      const tabId = asInteger(payload["tab_id"]);
      if (tabId === undefined) {
        throw new Error(`tab_open returned no tab_id: ${JSON.stringify(payload)}`);
      }
      return {
        tabId,
        url: asString(payload["url"]) ?? url,
        title: asString(payload["title"]) ?? ""
      };
    },

    async getText(tabId: number): Promise<string> {
      const result = await callTool(client, tool("get_text"), { tab_id: tabId });
      return firstText(result) ?? "";
    },

    async closeTab(tabId: number): Promise<void> {
      await callTool(client, tool("tab_close"), { tab_id: tabId });
    }
  };
};

const callTool = async (
  client: McpToolCaller,
  name: string,
  args: Record<string, unknown>
): Promise<{
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  isError?: boolean;
}> => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const message = firstText(result) ?? `tool ${name} reported isError`;
    throw new Error(message);
  }
  return result;
};

const firstText = (result: {
  content?: ReadonlyArray<{ type?: string; text?: string }>;
}): string | undefined => {
  const entries = Array.isArray(result.content) ? result.content : [];
  for (const entry of entries) {
    if (entry && entry.type === "text" && typeof entry.text === "string") {
      return entry.text;
    }
  }
  return undefined;
};

const expectJson = (
  result: { content?: ReadonlyArray<{ type?: string; text?: string }> },
  label: string
): Record<string, unknown> => {
  const text = firstText(result);
  if (!text) throw new Error(`${label} returned no text content`);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${label} returned non-JSON text: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;
