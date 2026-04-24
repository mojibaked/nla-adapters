import assert from "node:assert/strict";
import test from "node:test";

import {
  createBrowserResearchClient,
  mapWithConcurrency,
  researchPage,
  synthesizeFindings
} from "../dist/index.js";

test("mapWithConcurrency preserves order and caps in-flight work", async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  let inFlight = 0;
  let maxInFlight = 0;

  const results = await mapWithConcurrency(items, 3, async (n) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10 + (n % 3) * 5));
    inFlight -= 1;
    return n * 2;
  });

  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12, 14]);
  assert.ok(maxInFlight <= 3, `in-flight peaked at ${maxInFlight}, expected <= 3`);
});

test("mapWithConcurrency rejects invalid concurrency", async () => {
  await assert.rejects(
    () => mapWithConcurrency([1], 0, async (n) => n),
    /concurrency must be a positive integer/
  );
});

test("researchPage opens, extracts, and closes the tab", async () => {
  const events = [];
  const browser = {
    async openTab(url) {
      events.push(["open", url]);
      return { tabId: 42, url, title: "Example" };
    },
    async getText(tabId) {
      events.push(["getText", tabId]);
      return "Relevant content about topic X.";
    },
    async closeTab(tabId) {
      events.push(["close", tabId]);
    }
  };
  const llm = {
    async complete() {
      return {
        text: JSON.stringify({
          claims: [
            { text: "Topic X is well-studied.", quote: "well-studied" }
          ]
        })
      };
    }
  };

  const finding = await researchPage(
    { browser, llm },
    {
      query: "topic X overview",
      candidate: { url: "https://example.test/x" }
    }
  );

  assert.equal(finding.url, "https://example.test/x");
  assert.equal(finding.claims.length, 1);
  assert.equal(finding.claims[0].text, "Topic X is well-studied.");
  assert.equal(finding.claims[0].quote, "well-studied");
  assert.equal(finding.error, undefined);
  assert.deepEqual(events, [
    ["open", "https://example.test/x"],
    ["getText", 42],
    ["close", 42]
  ]);
});

test("researchPage skips the browser when candidate.content is pre-fetched", async () => {
  let browserCalled = false;
  const browser = {
    async openTab() { browserCalled = true; throw new Error("should not open tab"); },
    async getText() { throw new Error("should not read text"); },
    async closeTab() { throw new Error("should not close"); }
  };
  const llm = {
    async complete() {
      return { text: JSON.stringify({ claims: [{ text: "from prefetch" }] }) };
    }
  };

  const finding = await researchPage(
    { browser, llm },
    {
      query: "q",
      candidate: {
        url: "https://pre.test",
        title: "Pre-fetched",
        content: "Already have the page text here."
      }
    }
  );

  assert.equal(browserCalled, false);
  assert.equal(finding.title, "Pre-fetched");
  assert.equal(finding.claims[0].text, "from prefetch");
});

test("researchPage surfaces browser errors and still closes the tab", async () => {
  const closes = [];
  const browser = {
    async openTab() { return { tabId: 7, url: "x", title: "t" }; },
    async getText() { throw new Error("getText blew up"); },
    async closeTab(tabId) { closes.push(tabId); }
  };
  const llm = {
    async complete() { throw new Error("llm should not be called"); }
  };

  const finding = await researchPage(
    { browser, llm },
    { query: "q", candidate: { url: "https://err.test" } }
  );

  assert.equal(finding.error, "getText blew up");
  assert.deepEqual(finding.claims, []);
  assert.deepEqual(closes, [7]);
});

test("synthesizeFindings short-circuits when no relevant findings exist", async () => {
  let called = false;
  const llm = { async complete() { called = true; return { text: "should not run" }; } };
  const result = await synthesizeFindings(llm, {
    query: "q",
    findings: [
      { url: "https://a.test", claims: [], error: "failed" },
      { url: "https://b.test", claims: [] }
    ]
  });
  assert.equal(called, false);
  assert.match(result.answer, /No research findings/);
  assert.deepEqual(result.citedUrls, []);
});

test("BrowserResearchClient runs search -> parallel extract -> synthesize", async () => {
  const searchCalls = [];
  const opened = [];
  const closed = [];
  let nextTabId = 100;

  const search = {
    async search(input) {
      searchCalls.push(input);
      return [
        { url: "https://a.test/1", title: "A1", snippet: "a1" },
        { url: "https://b.test/2", title: "B2", snippet: "b2" }
      ];
    }
  };

  const browser = {
    async openTab(url) {
      const tabId = nextTabId++;
      opened.push({ tabId, url });
      return { tabId, url, title: `title-${tabId}` };
    },
    async getText(tabId) {
      return `page text for tab ${tabId}`;
    },
    async closeTab(tabId) {
      closed.push(tabId);
    }
  };

  const llm = {
    async complete(request) {
      const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
      if (lastUser?.content.includes("Page text")) {
        return {
          text: JSON.stringify({
            claims: [{ text: "extracted finding", quote: "verbatim quote" }]
          })
        };
      }
      return { text: "Final synthesized answer [1][2]." };
    }
  };

  const client = createBrowserResearchClient({ search, browser, llm, concurrency: 2 });
  const result = await client.query({ query: "test query", text: "test query", parts: [] });

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].query, "test query");
  assert.equal(searchCalls[0].maxResults, 8);
  assert.equal(opened.length, 2);
  assert.equal(closed.length, 2);
  assert.match(result.answer, /Final synthesized answer/);
  assert.ok(result.sources);
  assert.equal(result.sources.length, 2);
  const urls = result.sources.map((source) => source.url).sort();
  assert.deepEqual(urls, ["https://a.test/1", "https://b.test/2"]);
  assert.equal(result.sources[0].snippet, "verbatim quote");
});
