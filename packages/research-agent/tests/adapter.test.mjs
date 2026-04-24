import assert from "node:assert/strict";
import test from "node:test";

import { createEnvelope } from "@nla/protocol";
import { createAdapterRuntime } from "@nla/sdk-core";
import { createResearchAgent, runResearchQuery } from "../dist/index.js";

test("runResearchQuery passes normalized input and normalizes dependency output", async () => {
  const calls = [];
  const dependencies = {
    now: () => new Date("2026-04-22T12:00:00.000Z"),
    research: {
      async query(input) {
        calls.push(input);
        return {
          answer: "  EV adoption is rising.  ",
          sources: [
            {
              title: "  Example Report  ",
              url: "  https://example.test/report  ",
              snippet: "  Sales increased year over year.  "
            },
            {},
            { title: "   " }
          ],
          metadata: {
            confidence: "medium"
          }
        };
      }
    }
  };

  const result = await runResearchQuery(dependencies, {
    query: "  EV market  ",
    parts: [{ type: "text", text: "EV market" }],
    sessionId: "sess_research_helper",
    turnId: "turn_research_helper",
    metadata: {
      requestId: "request_1"
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "EV market");
  assert.equal(calls[0].text, "EV market");
  assert.deepEqual(calls[0].parts, [{ type: "text", text: "EV market" }]);
  assert.equal(result.answer, "EV adoption is rising.");
  assert.equal(result.checkedAt, "2026-04-22T12:00:00.000Z");
  assert.deepEqual(result.sources, [
    {
      title: "Example Report",
      url: "https://example.test/report",
      snippet: "Sales increased year over year."
    }
  ]);
  assert.deepEqual(result.metadata, {
    confidence: "medium"
  });
});

test("research agent session replies with answer and source details", async () => {
  let receivedInput;
  const runtime = createAdapterRuntime(createResearchAgent({
    research: {
      async query(input) {
        receivedInput = input;
        return {
          answer: "Hydrogen fuel cell adoption remains niche for passenger cars.",
          checkedAt: "2026-04-22T13:00:00.000Z",
          sources: [
            {
              title: "IEA Global EV Outlook",
              url: "https://www.iea.org/reports/global-ev-outlook",
              snippet: "Battery electric vehicles dominate current deployment."
            }
          ]
        };
      }
    }
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_research_agent"
  }));

  const messages = [];
  await runtime.handleStream(createEnvelope("session.message", {
    sessionId: "sess_research_agent",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Research hydrogen passenger car adoption."
      }
    ],
    metadata: {
      turnId: "turn_research_agent"
    }
  }), (message) => {
    messages.push(message);
  });

  const assistant = messages.find((message) =>
    message.type === "session.message"
    && message.data.role === "assistant"
  );

  assert.ok(assistant);
  assert.match(assistant.data.text, /Hydrogen fuel cell adoption remains niche/);
  assert.match(assistant.data.text, /IEA Global EV Outlook/);
  assert.match(assistant.data.text, /https:\/\/www\.iea\.org\/reports\/global-ev-outlook/);
  assert.equal(assistant.data.metadata.kind, "research.result");
  assert.equal(assistant.data.metadata.checkedAt, "2026-04-22T13:00:00.000Z");
  assert.equal(receivedInput.query, "Research hydrogen passenger car adoption.");
  assert.equal(receivedInput.sessionId, "sess_research_agent");
  assert.equal(receivedInput.turnId, "turn_research_agent");
  assert.equal(
    messages.some((message) => message.type === "session.completed"),
    true
  );
});

test("research dependency failure emits a failed session turn", async () => {
  const runtime = createAdapterRuntime(createResearchAgent({
    research: {
      async query() {
        throw new Error("research backend down");
      }
    }
  }));

  await runtime.handle(createEnvelope("session.start", {
    sessionId: "sess_research_failure"
  }));

  const messages = await runtime.handle(createEnvelope("session.message", {
    sessionId: "sess_research_failure",
    role: "user",
    text: "Research failing dependency.",
    metadata: {
      turnId: "turn_research_failure"
    }
  }));

  const failure = messages.find((message) => message.type === "session.failed");

  assert.ok(failure);
  assert.equal(failure.data.code, "runtime_error");
  assert.match(failure.data.message, /research backend down/);
  assert.equal(
    messages.some((message) =>
      message.type === "session.message"
      && message.data.role === "assistant"
    ),
    false
  );
});
