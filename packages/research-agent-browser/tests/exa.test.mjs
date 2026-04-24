import assert from "node:assert/strict";
import test from "node:test";

import { createExaSearchClient } from "../dist/exa.js";

test("ExaSearchClient posts to /search and maps results to candidates", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        return {
          results: [
            {
              url: "https://a.test/1",
              title: "A1",
              text: "page text for A1",
              snippet: "snippet A1"
            },
            {
              url: "https://b.test/2",
              title: "B2",
              summary: "summary B2"
              // no text — should come back without content
            },
            {
              title: "bad — no url"
            }
          ]
        };
      },
      async text() { return ""; }
    };
  };

  const client = createExaSearchClient({
    apiKey: "test-key",
    fetch: fakeFetch
  });
  const results = await client.search({ query: "quantum computing overview", maxResults: 5 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.exa.ai/search");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], "test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.query, "quantum computing overview");
  assert.equal(body.numResults, 5);
  assert.equal(body.contents.text.includeHtmlTags, false);

  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://a.test/1");
  assert.equal(results[0].title, "A1");
  assert.equal(results[0].content, "page text for A1");
  assert.equal(results[0].snippet, "snippet A1");
  assert.equal(results[1].url, "https://b.test/2");
  assert.equal(results[1].snippet, "summary B2");
  assert.equal(results[1].content, undefined);
});

test("ExaSearchClient surfaces HTTP errors", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    async json() { return {}; },
    async text() { return '{"error":"bad key"}'; }
  });
  const client = createExaSearchClient({ apiKey: "k", fetch: fakeFetch });
  await assert.rejects(
    () => client.search({ query: "x" }),
    /Exa search failed \(401 Unauthorized\)/
  );
});

test("ExaSearchClient rejects empty apiKey", () => {
  assert.throws(() => createExaSearchClient({ apiKey: "  " }), /requires an apiKey/);
});
