import {
  launchBrowserMcp,
  type BrowserMcp,
  type BrowserMcpGetHtmlAllResult,
  type BrowserMcpLaunchOptions,
  type BrowserMcpSnapshot,
} from "browser-mcp";
import {
  tool,
  type NlaSessionToolDefinition,
} from "@nla/sdk-core";
import {
  requestAutotraderToolApproval,
  type AutotraderApprovalRejectedResult,
} from "./approval.js";

export interface AutotraderBrowserDependencies {
  readonly browser?: BrowserMcp;
  readonly browserOptions?: BrowserMcpLaunchOptions;
}

type BrowserActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: "rejected"; readonly message: string };
type BrowserSnapshotResult = BrowserMcpSnapshot | AutotraderApprovalRejectedResult;
type BrowserGetTextResult = string | AutotraderApprovalRejectedResult;
type BrowserGetHtmlResult =
  | string
  | BrowserMcpGetHtmlAllResult
  | AutotraderApprovalRejectedResult;
type BrowserSelectOptionResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly status: "rejected"; readonly message: string };
type BrowserScrollResult =
  | { readonly mode: string; readonly dy?: number }
  | { readonly ok: false; readonly status: "rejected"; readonly message: string };
type BrowserWaitForResult = { ok: true } | AutotraderApprovalRejectedResult;

export const createBrowserLoader = (
  dependencies: AutotraderBrowserDependencies
): (() => Promise<BrowserMcp>) => {
  let browserPromise: Promise<BrowserMcp> | undefined;

  return async () => {
    if (!browserPromise) {
      browserPromise = dependencies.browser
        ? Promise.resolve(dependencies.browser)
        : launchBrowserMcp(dependencies.browserOptions);
    }
    return await browserPromise;
  };
};

export const createAutotraderBrowserTools = (
  getBrowser: () => Promise<BrowserMcp>
): ReadonlyArray<NlaSessionToolDefinition<{}, any, any>> => [
  tool<{}, unknown, BrowserActionResult>({
    name: "navigate",
    description:
      "Navigate the active browser tab to an absolute URL. Launches browser-mcp automatically on first use. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Absolute URL to open.",
        },
      },
    },
    execute: async (context, input) => {
      const approval = await requestAutotraderToolApproval(context, "navigate", {
        url: requireString(input, "url", "navigate requires `url`"),
      });
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.navigate(
        {
          url: requireString(input, "url", "navigate requires `url`"),
        },
        {
          signal: context.signal,
        }
      );
    },
  }),
  tool<{}, unknown, BrowserSnapshotResult>({
    name: "snapshot",
    description:
      "Take an accessibility snapshot of the active page. Interactive elements receive refs like `r12`; use them as selectors in the form `[data-mcp-ref=\"r12\"]` for click/fill/select_option. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async (context) => {
      const approval = await requestAutotraderToolApproval(context, "snapshot", {});
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.snapshot({
        signal: context.signal,
      });
    },
  }),
  tool<{}, unknown, BrowserGetTextResult>({
    name: "get_text",
    description:
      "Return the visible text content of the active page. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async (context) => {
      const approval = await requestAutotraderToolApproval(context, "get_text", {});
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.getText({
        signal: context.signal,
      });
    },
  }),
  tool<{}, unknown, BrowserGetHtmlResult>({
    name: "get_html",
    description:
      "Return outerHTML for a CSS selector. With `all: true`, returns all matches up to `limit`; otherwise returns the first match as a raw HTML string. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["selector"],
      properties: {
        selector: {
          type: "string",
          description: "CSS selector.",
        },
        all: {
          type: "boolean",
          description: "Return all matches instead of only the first.",
        },
        limit: {
          type: "number",
          description: "Maximum number of matches when `all` is true.",
        },
      },
    },
    execute: async (context, input) => {
      const selector = requireString(input, "selector", "get_html requires `selector`");
      const all = requireOptionalBoolean(input, "all");
      const limit = requireOptionalNumber(input, "limit");
      const approval = await requestAutotraderToolApproval(context, "get_html", {
        selector,
        ...(typeof all === "boolean" ? { all } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
      });
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.getHtml(
        {
          selector,
          all,
          limit,
        },
        {
          signal: context.signal,
        }
      );
    },
  }),
  tool<{}, unknown, BrowserActionResult>({
    name: "click",
    description:
      "Click an element by CSS selector or snapshot ref selector like `[data-mcp-ref=\"r12\"]`. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["selector"],
      properties: {
        selector: {
          type: "string",
          description: "CSS selector or snapshot ref selector.",
        },
      },
    },
    execute: async (context, input) => {
      const selector = requireString(input, "selector", "click requires `selector`");
      const approval = await requestAutotraderToolApproval(context, "click", {
        selector,
      });
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.click(
        {
          selector,
        },
        {
          signal: context.signal,
        }
      );
    },
  }),
  tool<{}, unknown, BrowserActionResult>({
    name: "fill",
    description:
      "Fill an input or textarea by CSS selector or snapshot ref selector like `[data-mcp-ref=\"r12\"]`. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["selector", "value"],
      properties: {
        selector: {
          type: "string",
          description: "CSS selector or snapshot ref selector.",
        },
        value: {
          type: "string",
          description: "Text to set.",
        },
      },
    },
    execute: async (context, input) => {
      const selector = requireString(input, "selector", "fill requires `selector`");
      const value = requireString(input, "value", "fill requires `value`", {
        allowEmpty: true,
      });
      const approval = await requestAutotraderToolApproval(context, "fill", {
        selector,
        value: summarizeValue(value),
      });
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.fill(
        {
          selector,
          value,
        },
        {
          signal: context.signal,
        }
      );
    },
  }),
  tool<{}, unknown, BrowserSelectOptionResult>({
    name: "select_option",
    description:
      "Select an option in a native <select> by CSS selector or snapshot ref selector. Provide either `value` or `label`. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["selector"],
      properties: {
        selector: {
          type: "string",
          description: "CSS selector or snapshot ref selector for the <select>.",
        },
        value: {
          type: "string",
          description: "Option value attribute.",
        },
        label: {
          type: "string",
          description: "Visible option text.",
        },
      },
    },
    execute: async (context, input) => {
      const selector = requireString(input, "selector", "select_option requires `selector`");
      const value = requireOptionalString(input, "value");
      const label = requireOptionalString(input, "label");
      const approval = await requestAutotraderToolApproval(context, "select_option", {
        selector,
        ...(value ? { value } : {}),
        ...(label ? { label } : {}),
      });
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      const result = await browser.selectOption(
        {
          selector,
          value,
          label,
        },
        {
          signal: context.signal,
        }
      );
      return {
        ok: true,
        value: result.value,
      };
    },
  }),
  tool<{}, unknown, BrowserActionResult>({
    name: "press_key",
    description:
      "Dispatch a key press, optionally targeting a selector. Useful for Enter, Escape, ArrowDown, and Tab. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: {
        key: {
          type: "string",
          description: "Key name, e.g. `Enter`, `Escape`, `ArrowDown`.",
        },
        selector: {
          type: "string",
          description: "Optional CSS selector or snapshot ref selector to focus first.",
        },
      },
    },
    execute: async (context, input) => {
      const key = requireString(input, "key", "press_key requires `key`");
      const selector = requireOptionalString(input, "selector");
      const approval = await requestAutotraderToolApproval(context, "press_key", {
        key,
        ...(selector ? { selector } : {}),
      });
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.pressKey(
        {
          key,
          selector,
        },
        {
          signal: context.signal,
        }
      );
    },
  }),
  tool<{}, unknown, BrowserScrollResult>({
    name: "scroll",
    description:
      "Scroll the page by pixel delta, or scroll an element into view by selector. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: {
          type: "string",
          description: "Optional CSS selector or snapshot ref selector to scroll into view.",
        },
        dy: {
          type: "number",
          description: "Pixels to scroll vertically.",
        },
      },
    },
    execute: async (context, input) => {
      const selector = requireOptionalString(input, "selector");
      const dy = requireOptionalNumber(input, "dy");
      const approval = await requestAutotraderToolApproval(context, "scroll", {
        ...(selector ? { selector } : {}),
        ...(typeof dy === "number" ? { dy } : {}),
      });
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.scroll(
        {
          selector,
          dy,
        },
        {
          signal: context.signal,
        }
      );
    },
  }),
  tool<{}, unknown, BrowserWaitForResult>({
    name: "wait_for",
    description:
      "Wait for an element matching a CSS selector to appear. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["selector"],
      properties: {
        selector: {
          type: "string",
          description: "CSS selector.",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds.",
        },
      },
    },
    execute: async (context, input) => {
      const selector = requireString(input, "selector", "wait_for requires `selector`");
      const timeoutMs = requireOptionalNumber(input, "timeout_ms");
      const approval = await requestAutotraderToolApproval(context, "wait_for", {
        selector,
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      });
      if (approval.status === "rejected") {
        return approval;
      }

      const browser = await getBrowser();
      return await browser.waitFor(
        {
          selector,
          timeoutMs,
        },
        {
          signal: context.signal,
        }
      );
    },
  }),
];

const requireRecord = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};

const requireString = (
  input: unknown,
  key: string,
  message: string,
  options: {
    readonly allowEmpty?: boolean;
  } = {}
): string => {
  const value = requireRecord(input)[key];
  if (typeof value !== "string") {
    throw new Error(message);
  }
  if (!options.allowEmpty && !value.trim()) {
    throw new Error(message);
  }
  return options.allowEmpty ? value : value.trim();
};

const requireOptionalString = (input: unknown, key: string): string | undefined => {
  const value = requireRecord(input)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const requireOptionalBoolean = (input: unknown, key: string): boolean | undefined => {
  const value = requireRecord(input)[key];
  return typeof value === "boolean" ? value : undefined;
};

const requireOptionalNumber = (input: unknown, key: string): number | undefined => {
  const value = requireRecord(input)[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const summarizeValue = (value: string): string =>
  value.length <= 120 ? value : `${value.slice(0, 117)}...`;
