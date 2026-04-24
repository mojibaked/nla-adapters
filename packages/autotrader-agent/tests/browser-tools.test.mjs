import assert from "node:assert/strict";
import test from "node:test";

import { createEnvelope } from "@nla/protocol";
import { createAdapterRuntime } from "@nla/sdk-core";
import { createAutotraderAgent } from "../dist/index.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }

  throw new Error("Timed out waiting for condition");
};

const createFakeStorage = () => {
  const store = new Map();
  return {
    getJson: async ({ scope, key }) => store.get(`${scope}:${key}`),
    putJson: async ({ scope, key, value }) => {
      store.set(`${scope}:${key}`, value);
    }
  };
};

test("autotrader agent exposes built-in browser tools directly", async () => {
  const navigateCalls = [];
  let issuedNavigate = false;

  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond() {
        if (!issuedNavigate) {
          issuedNavigate = true;
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:navigate",
                toolName: "navigate",
                input: {
                  url: "https://www.autotrader.com/cars-for-sale/all-cars/bmw/m4/san-francisco-ca?zip=94103"
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: "done"
        };
      }
    }),
    browser: {
      async navigate(input) {
        navigateCalls.push(input);
        return { ok: true };
      }
    },
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_browser_tools"
  }, {
    correlationId: "start:sess_autotrader_browser_tools"
  }));

  const turnMessages = [];
  await runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_browser_tools",
    role: "user",
    text: "find BMW M4 listings in San Francisco",
    metadata: {
      turnId: "turn_autotrader_browser_tools"
    }
  }, {
    correlationId: "turn:sess_autotrader_browser_tools"
  }), (message) => {
    turnMessages.push(message);
  });

  assert.deepEqual(navigateCalls, [
    {
      url: "https://www.autotrader.com/cars-for-sale/all-cars/bmw/m4/san-francisco-ca?zip=94103"
    }
  ]);
  assert.equal(
    turnMessages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
      && message.data.text === "done"
    ),
    true
  );
  assert.equal(
    turnMessages.some((message) => message.type === "session.completed"),
    true
  );
});

test("autotrader agent exposes the media URL browser tool directly", async () => {
  const mediaUrlCalls = [];
  let issuedListMediaUrls = false;

  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond() {
        if (!issuedListMediaUrls) {
          issuedListMediaUrls = true;
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:list-media-urls",
                toolName: "list_media_urls",
                input: {
                  limit: 5
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: "done"
        };
      }
    }),
    browser: {
      async listMediaUrls(input) {
        mediaUrlCalls.push(input);
        return {
          urls: [
            "https://images.autotrader.com/photo-1.jpg",
            "https://images.autotrader.com/photo-2.jpg"
          ],
          total: 2,
          truncated: false
        };
      }
    },
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_media_urls"
  }, {
    correlationId: "start:sess_autotrader_media_urls"
  }));

  const turnMessages = [];
  await runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_media_urls",
    role: "user",
    text: "share some image urls",
    metadata: {
      turnId: "turn_autotrader_media_urls"
    }
  }, {
    correlationId: "turn:sess_autotrader_media_urls"
  }), (message) => {
    turnMessages.push(message);
  });

  assert.deepEqual(mediaUrlCalls, [
    {
      limit: 5
    }
  ]);
  assert.equal(
    turnMessages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
      && message.data.text === "done"
    ),
    true
  );
  assert.equal(
    turnMessages.some((message) => message.type === "session.completed"),
    true
  );
});

test("autotrader agent treats missing get_html selectors as recoverable misses", async () => {
  const getHtmlCalls = [];
  let issuedGetHtml = false;

  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        const getHtmlResult = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "get_html"
        );
        if (!issuedGetHtml) {
          issuedGetHtml = true;
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:get-html-miss",
                toolName: "get_html",
                input: {
                  selector: "img[src*=\"dealer.com\"]"
                }
              }
            ]
          };
        }

        assert.ok(getHtmlResult);
        return {
          type: "assistant",
          text: "done"
        };
      }
    }),
    browser: {
      async getHtml(input) {
        getHtmlCalls.push(input);
        throw new Error("element not found");
      }
    },
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_get_html_miss"
  }, {
    correlationId: "start:sess_autotrader_get_html_miss"
  }));

  const turnMessages = [];
  await runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_get_html_miss",
    role: "user",
    text: "look for photos",
    metadata: {
      turnId: "turn_autotrader_get_html_miss"
    }
  }, {
    correlationId: "turn:sess_autotrader_get_html_miss"
  }), (message) => {
    turnMessages.push(message);
  });

  assert.deepEqual(getHtmlCalls, [
    {
      selector: "img[src*=\"dealer.com\"]",
      all: undefined,
      limit: undefined
    }
  ]);
  assert.equal(
    turnMessages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
      && message.data.text === "done"
    ),
    true
  );
  assert.equal(
    turnMessages.some((message) => message.type === "session.failed"),
    false
  );
});

test("autotrader agent interrupts an in-flight browser navigation", async () => {
  let observedSignal;

  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        const hasToolReply = request.messages.some((message) => message.role === "tool");
        if (!hasToolReply) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:navigate",
                toolName: "navigate",
                input: {
                  url: "https://www.autotrader.com/cars-for-sale/all-cars/bmw/m4/san-francisco-ca?zip=94103"
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: "done"
        };
      }
    }),
    browser: {
      async navigate(_input, options = {}) {
        observedSignal = options.signal;
        const signal = options.signal;
        await new Promise((resolve, reject) => {
          if (!signal) {
            reject(new Error("Expected AbortSignal"));
            return;
          }

          if (signal.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }

          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new Error("aborted"));
          }, {
            once: true
          });
        });
        return { ok: true };
      }
    },
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_browser_interrupt"
  }, {
    correlationId: "start:sess_autotrader_browser_interrupt"
  }));

  const turnMessages = [];
  const turnPromise = runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_browser_interrupt",
    role: "user",
    text: "search autotrader",
    metadata: {
      turnId: "turn_autotrader_browser_interrupt"
    }
  }, {
    correlationId: "turn:sess_autotrader_browser_interrupt"
  }), (message) => {
    turnMessages.push(message);
  });

  await waitFor(() => observedSignal !== undefined);
  await waitFor(() =>
    turnMessages.some((message) =>
      message.type === "session.execution"
      && message.data.turnId === "turn_autotrader_browser_interrupt"
      && message.data.state === "running"
    )
  );

  const interruptMessages = await runtime.handle(createEnvelope("session.interrupt", {
    sessionId: "sess_autotrader_browser_interrupt",
    turnId: "turn_autotrader_browser_interrupt"
  }, {
    correlationId: "interrupt:sess_autotrader_browser_interrupt"
  }));
  await turnPromise;

  const interruptResult = interruptMessages.find(
    (message) => message.type === "session.interrupt.result"
  );
  assert.ok(interruptResult);
  assert.equal(interruptResult.data.status, "interrupted");
  assert.equal(interruptResult.data.turnId, "turn_autotrader_browser_interrupt");
  assert.equal(interruptResult.data.message, "Interrupted");
  assert.equal(observedSignal.aborted, true);
  assert.equal(
    turnMessages.some((message) => message.type === "session.completed"),
    false
  );
  assert.equal(
    turnMessages.some((message) => message.type === "session.failed"),
    false
  );
});

test("autotrader agent requests approval before browser actions when enabled", async () => {
  const navigateCalls = [];

  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        const navigateResult = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "navigate"
        );
        if (!navigateResult) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:navigate-approval",
                toolName: "navigate",
                input: {
                  url: "https://www.autotrader.com/cars-for-sale/all-cars/bmw/m4/san-francisco-ca?zip=94103"
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: "done"
        };
      }
    }),
    browser: {
      async navigate(input) {
        navigateCalls.push(input);
        return { ok: true };
      }
    },
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.resume", {
    sessionId: "sess_autotrader_browser_approval",
    state: {
      autotraderApprovalMode: "actions"
    }
  }, {
    correlationId: "resume:sess_autotrader_browser_approval"
  }));

  const turnMessages = [];
  const turnPromise = runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_browser_approval",
    role: "user",
    text: "open the search page",
    metadata: {
      turnId: "turn_autotrader_browser_approval"
    }
  }, {
    correlationId: "turn:sess_autotrader_browser_approval"
  }), (message) => {
    turnMessages.push(message);
  });

  await waitFor(() =>
    turnMessages.some((message) =>
      message.type === "session.interaction.requested"
      && message.data.request.kind === "approval"
    )
  );

  const approvalRequest = turnMessages.find((message) =>
    message.type === "session.interaction.requested"
    && message.data.request.kind === "approval"
  );
  assert.ok(approvalRequest);
  assert.equal(approvalRequest.data.request.details.toolName, "navigate");

  await runtime.handle(createEnvelope("session.interaction.resolve", {
    sessionId: "sess_autotrader_browser_approval",
    resolution: {
      kind: "approval",
      requestId: approvalRequest.data.request.requestId,
      optionId: "approve"
    }
  }, {
    correlationId: "resolve:sess_autotrader_browser_approval"
  }));
  await turnPromise;

  assert.deepEqual(navigateCalls, [
    {
      url: "https://www.autotrader.com/cars-for-sale/all-cars/bmw/m4/san-francisco-ca?zip=94103"
    }
  ]);
  assert.equal(
    turnMessages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
      && message.data.text === "done"
    ),
    true
  );
});

test("autotrader agent returns a rejected tool result when approval is denied", async () => {
  const navigateCalls = [];

  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        const navigateResult = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "navigate"
        );
        if (!navigateResult) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:navigate-rejected",
                toolName: "navigate",
                input: {
                  url: "https://www.autotrader.com/cars-for-sale/all-cars/bmw/m4/san-francisco-ca?zip=94103"
                }
              }
            ]
          };
        }

        const parsed = JSON.parse(navigateResult.text);
        return {
          type: "assistant",
          text: parsed.status === "rejected" ? "blocked" : "done"
        };
      }
    }),
    browser: {
      async navigate(input) {
        navigateCalls.push(input);
        return { ok: true };
      }
    },
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.resume", {
    sessionId: "sess_autotrader_browser_approval_reject",
    state: {
      autotraderApprovalMode: "actions"
    }
  }, {
    correlationId: "resume:sess_autotrader_browser_approval_reject"
  }));

  const turnMessages = [];
  const turnPromise = runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_browser_approval_reject",
    role: "user",
    text: "open the search page",
    metadata: {
      turnId: "turn_autotrader_browser_approval_reject"
    }
  }, {
    correlationId: "turn:sess_autotrader_browser_approval_reject"
  }), (message) => {
    turnMessages.push(message);
  });

  await waitFor(() =>
    turnMessages.some((message) =>
      message.type === "session.interaction.requested"
      && message.data.request.kind === "approval"
    )
  );

  const approvalRequest = turnMessages.find((message) =>
    message.type === "session.interaction.requested"
    && message.data.request.kind === "approval"
  );
  assert.ok(approvalRequest);

  await runtime.handle(createEnvelope("session.interaction.resolve", {
    sessionId: "sess_autotrader_browser_approval_reject",
    resolution: {
      kind: "approval",
      requestId: approvalRequest.data.request.requestId,
      optionId: "reject"
    }
  }, {
    correlationId: "resolve:sess_autotrader_browser_approval_reject"
  }));
  await turnPromise;

  assert.equal(navigateCalls.length, 0);
  assert.equal(
    turnMessages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
      && message.data.text === "blocked"
    ),
    true
  );
  assert.equal(
    turnMessages.some((message) => message.type === "session.failed"),
    false
  );
});

test("autotrader agent requests approval for each tool call in the same turn", async () => {
  const navigateCalls = [];
  const getHtmlCalls = [];

  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        const navigateResult = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "navigate"
        );
        const getHtmlResult = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "get_html"
        );
        const saveListingsResult = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "save_listings"
        );

        if (!navigateResult) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:navigate-sequence",
                toolName: "navigate",
                input: {
                  url: "https://www.autotrader.com/cars-for-sale/all-cars/bmw/m4/san-francisco-ca?zip=94103"
                }
              }
            ]
          };
        }

        if (!getHtmlResult) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:get-html-sequence",
                toolName: "get_html",
                input: {
                  selector: "script[data-cmp=\"listingsCollectionSchema\"]"
                }
              }
            ]
          };
        }

        if (!saveListingsResult) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:save-listings-sequence",
                toolName: "save_listings",
                input: {
                  source: "<script type=\"application/ld+json\">{\"@graph\":[]}</script>"
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: "done"
        };
      }
    }),
    browser: {
      async navigate(input) {
        navigateCalls.push(input);
        return { ok: true };
      },
      async getHtml(input) {
        getHtmlCalls.push(input);
        return "<script type=\"application/ld+json\">{\"@graph\":[]}</script>";
      }
    },
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.resume", {
    sessionId: "sess_autotrader_browser_approval_sequence",
    state: {
      autotraderApprovalMode: "actions"
    }
  }, {
    correlationId: "resume:sess_autotrader_browser_approval_sequence"
  }));

  const turnMessages = [];
  const turnPromise = runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_browser_approval_sequence",
    role: "user",
    text: "open search results and cache them",
    metadata: {
      turnId: "turn_autotrader_browser_approval_sequence"
    }
  }, {
    correlationId: "turn:sess_autotrader_browser_approval_sequence"
  }), (message) => {
    turnMessages.push(message);
  });

  const approvalRequests = () => turnMessages.filter((message) =>
    message.type === "session.interaction.requested"
    && message.data.request.kind === "approval"
  );

  await waitFor(() => approvalRequests().length === 1);
  assert.equal(approvalRequests()[0]?.data.request.details.toolName, "navigate");
  await runtime.handle(createEnvelope("session.interaction.resolve", {
    sessionId: "sess_autotrader_browser_approval_sequence",
    resolution: {
      kind: "approval",
      requestId: approvalRequests()[0].data.request.requestId,
      optionId: "approve"
    }
  }, {
    correlationId: "resolve-1:sess_autotrader_browser_approval_sequence"
  }));

  await waitFor(() => approvalRequests().length === 2);
  assert.equal(approvalRequests()[1]?.data.request.details.toolName, "get_html");
  await runtime.handle(createEnvelope("session.interaction.resolve", {
    sessionId: "sess_autotrader_browser_approval_sequence",
    resolution: {
      kind: "approval",
      requestId: approvalRequests()[1].data.request.requestId,
      optionId: "approve"
    }
  }, {
    correlationId: "resolve-2:sess_autotrader_browser_approval_sequence"
  }));

  await waitFor(() => approvalRequests().length === 3);
  assert.equal(approvalRequests()[2]?.data.request.details.toolName, "save_listings");
  await runtime.handle(createEnvelope("session.interaction.resolve", {
    sessionId: "sess_autotrader_browser_approval_sequence",
    resolution: {
      kind: "approval",
      requestId: approvalRequests()[2].data.request.requestId,
      optionId: "approve"
    }
  }, {
    correlationId: "resolve-3:sess_autotrader_browser_approval_sequence"
  }));

  await turnPromise;

  assert.deepEqual(navigateCalls, [
    {
      url: "https://www.autotrader.com/cars-for-sale/all-cars/bmw/m4/san-francisco-ca?zip=94103"
    }
  ]);
  assert.deepEqual(getHtmlCalls, [
    {
      selector: "script[data-cmp=\"listingsCollectionSchema\"]",
      all: undefined,
      limit: undefined
    }
  ]);
  assert.equal(
    turnMessages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
      && message.data.text === "done"
    ),
    true
  );
});

test("autotrader agent requests approval before scroll when enabled", async () => {
  const scrollCalls = [];

  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        const scrollResult = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "scroll"
        );
        if (!scrollResult) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:scroll-approval",
                toolName: "scroll",
                input: {
                  dy: 600
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: "scrolled"
        };
      }
    }),
    browser: {
      async scroll(input) {
        scrollCalls.push(input);
        return { mode: "page", dy: input.dy };
      }
    },
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.resume", {
    sessionId: "sess_autotrader_browser_scroll_approval",
    state: {
      autotraderApprovalMode: "actions"
    }
  }, {
    correlationId: "resume:sess_autotrader_browser_scroll_approval"
  }));

  const turnMessages = [];
  const turnPromise = runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_browser_scroll_approval",
    role: "user",
    text: "scroll down",
    metadata: {
      turnId: "turn_autotrader_browser_scroll_approval"
    }
  }, {
    correlationId: "turn:sess_autotrader_browser_scroll_approval"
  }), (message) => {
    turnMessages.push(message);
  });

  await waitFor(() =>
    turnMessages.some((message) =>
      message.type === "session.interaction.requested"
      && message.data.request.kind === "approval"
    )
  );

  const approvalRequest = turnMessages.find((message) =>
    message.type === "session.interaction.requested"
    && message.data.request.kind === "approval"
  );
  assert.ok(approvalRequest);
  assert.equal(approvalRequest.data.request.details.toolName, "scroll");

  await runtime.handle(createEnvelope("session.interaction.resolve", {
    sessionId: "sess_autotrader_browser_scroll_approval",
    resolution: {
      kind: "approval",
      requestId: approvalRequest.data.request.requestId,
      optionId: "approve"
    }
  }, {
    correlationId: "resolve:sess_autotrader_browser_scroll_approval"
  }));
  await turnPromise;

  assert.deepEqual(scrollCalls, [
    {
      selector: undefined,
      dy: 600
    }
  ]);
  assert.equal(
    turnMessages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
      && message.data.text === "scrolled"
    ),
    true
  );
});
