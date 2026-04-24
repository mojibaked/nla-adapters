import assert from "node:assert/strict";
import test from "node:test";

import { pruneCandidates } from "../dist/prune.js";

test("pruneCandidates is a no-op when candidates already fit", async () => {
  let called = false;
  const llm = { async complete() { called = true; return { text: "" }; } };
  const candidates = [
    { url: "https://a.test" },
    { url: "https://b.test" }
  ];
  const result = await pruneCandidates(llm, { query: "q", candidates, keep: 4 });
  assert.equal(called, false);
  assert.deepEqual(result, candidates);
});

test("pruneCandidates keeps the indices the LLM returns, in order", async () => {
  const llm = {
    async complete() {
      return { text: JSON.stringify({ keep: [4, 1] }) };
    }
  };
  const candidates = [
    { url: "https://one" },
    { url: "https://two" },
    { url: "https://three" },
    { url: "https://four" }
  ];
  const result = await pruneCandidates(llm, { query: "q", candidates, keep: 2 });
  assert.equal(result.length, 2);
  assert.equal(result[0].url, "https://four");
  assert.equal(result[1].url, "https://one");
});

test("pruneCandidates falls back to head slice if LLM returns garbage", async () => {
  const llm = {
    async complete() { return { text: "not json at all" }; }
  };
  const candidates = [
    { url: "https://1" },
    { url: "https://2" },
    { url: "https://3" }
  ];
  const result = await pruneCandidates(llm, { query: "q", candidates, keep: 2 });
  assert.equal(result.length, 2);
  assert.equal(result[0].url, "https://1");
  assert.equal(result[1].url, "https://2");
});

test("pruneCandidates filters out-of-range and duplicate indices", async () => {
  const llm = {
    async complete() {
      return { text: JSON.stringify({ keep: [1, 1, 99, 3] }) };
    }
  };
  const candidates = [
    { url: "https://a" },
    { url: "https://b" },
    { url: "https://c" },
    { url: "https://d" }
  ];
  const result = await pruneCandidates(llm, { query: "q", candidates, keep: 2 });
  assert.equal(result.length, 2);
  assert.equal(result[0].url, "https://a");
  assert.equal(result[1].url, "https://c");
});
