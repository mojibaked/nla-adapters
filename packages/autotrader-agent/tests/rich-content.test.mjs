import assert from "node:assert/strict";
import test from "node:test";

import { createEnvelope } from "@nla/protocol";
import { createAdapterRuntime } from "@nla/sdk-core";
import { createAutotraderAgent } from "../dist/index.js";

const createFakeStorage = () => {
  const store = new Map();
  return {
    getJson: async ({ scope, key }) => store.get(`${scope}:${key}`),
    putJson: async ({ scope, key, value }) => {
      store.set(`${scope}:${key}`, value);
    }
  };
};

const jsonLdPayload = {
  about: {
    offers: {
      itemOffered: [
        {
          vehicleIdentificationNumber: "VIN00000000000001",
          name: "New 2026 BMW M4 Competition",
          image: "https://example/one.jpg",
          itemCondition: "http://schema.org/NewCondition",
          offers: {
            price: "91980.00",
            priceCurrency: "USD",
            url: "https://example/pdp/1",
            seller: {
              name: "BMW of San Francisco"
            }
          },
          brand: { name: "BMW" },
          model: "M4",
          vehicleModelDate: 2026,
          mileageFromOdometer: { value: "16" },
          sku: 1
        },
        {
          vehicleIdentificationNumber: "VIN00000000000002",
          name: "Used 2023 BMW M4 Competition",
          image: "https://example/two.jpg",
          itemCondition: "http://schema.org/UsedCondition",
          offers: {
            price: "75995.00",
            priceCurrency: "USD",
            url: "https://example/pdp/2",
            seller: {
              name: "Example Motorcars"
            }
          },
          brand: { name: "BMW" },
          model: "M4",
          vehicleModelDate: 2023,
          mileageFromOdometer: { value: "17,922" },
          sku: 2
        }
      ]
    }
  }
};

test("autotrader agent interleaves image parts after matching listing blocks", async () => {
  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        const saved = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "save_listings"
        );
        if (!saved) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:save-listings-inline-images",
                toolName: "save_listings",
                input: {
                  source: jsonLdPayload
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: [
            "I found two strong matches.",
            "1. 2026 BMW M4 Competition for $91,980 at BMW of San Francisco.",
            "2. 2023 BMW M4 Competition for $75,995 from Example Motorcars."
          ].join("\n\n")
        };
      }
    }),
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_rich_content"
  }, {
    correlationId: "start:sess_autotrader_rich_content"
  }));

  const turnMessages = [];
  await runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_rich_content",
    role: "user",
    text: "Find me BMW M4 listings.",
    metadata: {
      turnId: "turn_autotrader_rich_content"
    }
  }, {
    correlationId: "turn:sess_autotrader_rich_content"
  }), (message) => {
    turnMessages.push(message);
  });

  const assistantMessage = turnMessages.find((message) =>
    message.type === "session.message"
    && message.data.role === "assistant"
  );
  assert.ok(assistantMessage);
  assert.equal(assistantMessage.data.text.includes("I found two strong matches."), true);
  assert.ok(Array.isArray(assistantMessage.data.parts));

  const parts = assistantMessage.data.parts;
  const imageParts = parts.filter((part) => part.type === "image");
  assert.equal(imageParts.length, 2);
  assert.equal(imageParts[0].imageUrl, "https://example/one.jpg");
  assert.equal(imageParts[1].imageUrl, "https://example/two.jpg");

  const firstImageIndex = parts.findIndex((part) =>
    part.type === "image" && part.imageUrl === "https://example/one.jpg"
  );
  const secondImageIndex = parts.findIndex((part) =>
    part.type === "image" && part.imageUrl === "https://example/two.jpg"
  );
  assert.match(parts[firstImageIndex - 1].text, /2026 BMW M4 Competition/);
  assert.match(parts[secondImageIndex - 1].text, /2023 BMW M4 Competition/);
});

test("autotrader agent keeps markdown tables text-only", async () => {
  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        const saved = request.messages.find((message) =>
          message.role === "tool" && message.toolName === "save_listings"
        );
        if (!saved) {
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:save-listings-table",
                toolName: "save_listings",
                input: {
                  source: jsonLdPayload
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: [
            "| Year | Model | Price |",
            "| --- | --- | --- |",
            "| 2026 | BMW M4 Competition | $91,980 |",
            "| 2023 | BMW M4 Competition | $75,995 |"
          ].join("\n")
        };
      }
    }),
    storage: createFakeStorage()
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_table_text_only"
  }, {
    correlationId: "start:sess_autotrader_table_text_only"
  }));

  const turnMessages = [];
  await runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_autotrader_table_text_only",
    role: "user",
    text: "Show me the search results as a table.",
    metadata: {
      turnId: "turn_autotrader_table_text_only"
    }
  }, {
    correlationId: "turn:sess_autotrader_table_text_only"
  }), (message) => {
    turnMessages.push(message);
  });

  const assistantMessage = turnMessages.find((message) =>
    message.type === "session.message"
    && message.data.role === "assistant"
  );
  assert.ok(assistantMessage);
  assert.equal(assistantMessage.data.text.includes("| Year | Model | Price |"), true);
  assert.equal(assistantMessage.data.parts, undefined);
});
