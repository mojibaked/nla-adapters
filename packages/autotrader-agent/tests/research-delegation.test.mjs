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

const createFakeResearchLauncher = (
  assistantText = "Research result with sources: https://example.test/research"
) => {
  const launches = [];
  const turns = [];
  const stops = [];

  return {
    launches,
    turns,
    stops,
    launcher: {
      async launch(request) {
        launches.push(request);
        const sessionId = `child_research_${launches.length}`;

        return {
          sessionId,
          ephemeral: true,
          async sendUserTurn(turn) {
            turns.push(turn);
            return streamMessages([
              createEnvelope("session.message", {
                sessionId,
                turnId: turn.turnId,
                role: "assistant",
                text: assistantText
              })
            ]);
          },
          async resolveInteraction() {
            throw new Error("Unexpected research interaction in test");
          },
          async interrupt() {},
          async stop(input) {
            stops.push(input);
          }
        };
      }
    }
  };
};

async function* streamMessages(messages) {
  for (const message of messages) {
    yield message;
  }
}

test("research_vehicle_market is exposed only when a research launcher is provided", async () => {
  const withLauncherRequests = [];
  const fakeResearch = createFakeResearchLauncher();
  const runtimeWithLauncher = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        withLauncherRequests.push(request);
        return {
          type: "assistant",
          text: "done"
        };
      }
    }),
    storage: createFakeStorage(),
    researchLauncher: fakeResearch.launcher
  }));

  await runtimeWithLauncher.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_research_tool_available"
  }));
  await runtimeWithLauncher.handle(createEnvelope("session.message", {
    sessionId: "sess_autotrader_research_tool_available",
    role: "user",
    text: "research market context",
    metadata: {
      turnId: "turn_autotrader_research_tool_available"
    }
  }));

  assert.equal(
    withLauncherRequests[0].tools.some((tool) => tool.name === "research_vehicle_market"),
    true
  );

  const withoutLauncherRequests = [];
  const runtimeWithoutLauncher = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        withoutLauncherRequests.push(request);
        return {
          type: "assistant",
          text: "done"
        };
      }
    }),
    storage: createFakeStorage()
  }));

  await runtimeWithoutLauncher.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_research_tool_absent"
  }));
  await runtimeWithoutLauncher.handle(createEnvelope("session.message", {
    sessionId: "sess_autotrader_research_tool_absent",
    role: "user",
    text: "research market context",
    metadata: {
      turnId: "turn_autotrader_research_tool_absent"
    }
  }));

  assert.equal(
    withoutLauncherRequests[0].tools.some((tool) => tool.name === "research_vehicle_market"),
    false
  );
});

test("research_vehicle_market delegates a child turn to the research target", async () => {
  const fakeResearch = createFakeResearchLauncher(
    "The 2021 RAV4 Hybrid is generally reliable; check battery warranty. Source: https://example.test/rav4"
  );
  const modelRequests = [];
  let requestedResearch = false;
  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond(request) {
        modelRequests.push(request);

        if (!requestedResearch) {
          requestedResearch = true;
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:research",
                toolName: "research_vehicle_market",
                input: {
                  query: "What should I know about 2021 Toyota RAV4 Hybrid reliability?",
                  vehicleContext: "2021 Toyota RAV4 Hybrid XLE",
                  listingContext: "$29,500, 42,000 miles, San Jose dealer"
                }
              }
            ]
          };
        }

        return {
          type: "assistant",
          text: "research complete"
        };
      }
    }),
    storage: createFakeStorage(),
    researchLauncher: fakeResearch.launcher
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_research_delegate"
  }));
  const messages = await runtime.handle(createEnvelope("session.message", {
    sessionId: "sess_autotrader_research_delegate",
    role: "user",
    text: "check reliability before I call the dealer",
    metadata: {
      turnId: "turn_autotrader_research_delegate"
    }
  }));

  assert.equal(fakeResearch.launches.length, 1);
  assert.equal(fakeResearch.launches[0].target.id, "research.agent");
  assert.equal(
    fakeResearch.launches[0].target.metadata.installId,
    "research.agent.process"
  );
  assert.equal(fakeResearch.turns.length, 1);
  assert.match(
    fakeResearch.turns[0].text,
    /What should I know about 2021 Toyota RAV4 Hybrid reliability/
  );
  assert.match(fakeResearch.turns[0].text, /2021 Toyota RAV4 Hybrid XLE/);
  assert.match(fakeResearch.turns[0].text, /\$29,500, 42,000 miles/);
  assert.equal(fakeResearch.stops.length, 1);

  const toolMessage = modelRequests[1].messages.find((message) =>
    message.role === "tool"
    && message.toolName === "research_vehicle_market"
  );
  assert.ok(toolMessage);
  assert.match(toolMessage.text, /2021 RAV4 Hybrid is generally reliable/);
  assert.match(toolMessage.text, /https:\/\/example\.test\/rav4/);
  assert.equal(
    messages.some((message) => message.type === "session.completed"),
    true
  );
});

test("browser tools still work when a research launcher is provided", async () => {
  const fakeResearch = createFakeResearchLauncher();
  const navigateCalls = [];
  let requestedNavigate = false;
  const runtime = createAdapterRuntime(createAutotraderAgent({
    createModel: () => ({
      async respond() {
        if (!requestedNavigate) {
          requestedNavigate = true;
          return {
            type: "tool_calls",
            calls: [
              {
                callId: "call:navigate",
                toolName: "navigate",
                input: {
                  url: "https://www.autotrader.com/cars-for-sale/all-cars/toyota/rav4/san-jose-ca?zip=95112"
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
        return {
          ok: true
        };
      }
    },
    storage: createFakeStorage(),
    researchLauncher: fakeResearch.launcher
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_autotrader_research_browser"
  }));
  const messages = await runtime.handle(createEnvelope("session.message", {
    sessionId: "sess_autotrader_research_browser",
    role: "user",
    text: "find RAV4 listings",
    metadata: {
      turnId: "turn_autotrader_research_browser"
    }
  }));

  assert.deepEqual(navigateCalls, [
    {
      url: "https://www.autotrader.com/cars-for-sale/all-cars/toyota/rav4/san-jose-ca?zip=95112"
    }
  ]);
  assert.equal(fakeResearch.launches.length, 0);
  assert.equal(
    messages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
      && message.data.text === "done"
    ),
    true
  );
});
