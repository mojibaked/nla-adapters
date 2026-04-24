import assert from "node:assert/strict";
import test from "node:test";

import { createMcpBrowserClient } from "../dist/mcp.js";

const makeFakeMcp = () => {
  const calls = [];
  const client = {
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      if (name === "tab_open") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tab_id: 42,
                url: args.url,
                title: "Example"
              })
            }
          ]
        };
      }
      if (name === "get_text") {
        return {
          content: [{ type: "text", text: `text for tab ${args.tab_id}` }]
        };
      }
      if (name === "tab_close") {
        return {
          content: [{ type: "text", text: `closed tab ${args.tab_id}` }]
        };
      }
      throw new Error(`unexpected tool ${name}`);
    }
  };
  return { client, calls };
};

test("McpBrowserClient maps openTab/getText/closeTab to MCP tool calls", async () => {
  const { client, calls } = makeFakeMcp();
  const browser = createMcpBrowserClient({ client });

  const tab = await browser.openTab("https://example.com");
  assert.equal(tab.tabId, 42);
  assert.equal(tab.url, "https://example.com");
  assert.equal(tab.title, "Example");

  const text = await browser.getText(tab.tabId);
  assert.equal(text, "text for tab 42");

  await browser.closeTab(tab.tabId);

  assert.deepEqual(calls.map((c) => c.name), ["tab_open", "get_text", "tab_close"]);
  assert.deepEqual(calls[0].args, { url: "https://example.com" });
  assert.deepEqual(calls[1].args, { tab_id: 42 });
  assert.deepEqual(calls[2].args, { tab_id: 42 });
});

test("McpBrowserClient raises when the tool reports isError", async () => {
  const client = {
    async callTool() {
      return {
        content: [{ type: "text", text: "error: extension not connected" }],
        isError: true
      };
    }
  };
  const browser = createMcpBrowserClient({ client });
  await assert.rejects(
    () => browser.openTab("https://x.test"),
    /extension not connected/
  );
});

test("McpBrowserClient honors a toolPrefix for namespaced tools", async () => {
  const calls = [];
  const client = {
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      const bare = name.replace(/^browser-mcp__/, "");
      if (bare === "tab_open") {
        return {
          content: [{ type: "text", text: JSON.stringify({ tab_id: 7, url: args.url, title: "t" }) }]
        };
      }
      if (bare === "tab_close") {
        return { content: [{ type: "text", text: `closed tab ${args.tab_id}` }] };
      }
      throw new Error(`unexpected tool ${name}`);
    }
  };
  const browser = createMcpBrowserClient({ client, toolPrefix: "browser-mcp__" });
  const tab = await browser.openTab("https://p.test");
  await browser.closeTab(tab.tabId);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["browser-mcp__tab_open", "browser-mcp__tab_close"]
  );
});
