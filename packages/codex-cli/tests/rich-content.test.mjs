import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assistantContentFromItem } from "../dist/notifications.js";
import { getCodexThreadHistory } from "../dist/threads.js";

test("assistantContentFromItem normalizes text and image blocks", () => {
  const content = assistantContentFromItem({
    type: "agentMessage",
    id: "codex-msg-1",
    phase: "completed",
    content: [
      {
        type: "output_text",
        text: "Five matching listings"
      },
      {
        type: "output_image",
        image_url: "https://example.test/listing-1.jpg"
      }
    ]
  });

  assert.deepEqual(content, {
    text: "Five matching listings",
    parts: [
      {
        type: "text",
        text: "Five matching listings"
      },
      {
        type: "image",
        url: "https://example.test/listing-1.jpg",
        providerType: "output_image"
      }
    ],
    metadata: {
      phase: "completed"
    }
  });
});

test("getCodexThreadHistory preserves image parts in transcript messages", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "nla-codex-rich-"));
  t.after(async () => {
    await rm(configDir, {
      recursive: true,
      force: true
    });
  });

  const transcriptDir = path.join(configDir, "sessions", "2026", "04", "20");
  await mkdir(transcriptDir, {
    recursive: true
  });

  await writeFile(path.join(transcriptDir, "rollout-thread-codex.jsonl"), [
    JSON.stringify({
      timestamp: "2026-04-20T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "thread-codex",
        cwd: "/tmp/workspace"
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "msg-user-1",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Show me the damage from this angle."
          },
          {
            type: "input_image",
            image_url: "data:image/png;base64,AAAA"
          }
        ]
      }
    }),
    JSON.stringify({
      timestamp: "2026-04-20T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "msg-assistant-1",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "The dent is visible on the rear door."
          }
        ]
      }
    })
  ].join("\n"));

  const result = await getCodexThreadHistory({
    configDir,
    threadRef: "thread-codex"
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0].parts, [
    {
      type: "text",
      text: "Show me the damage from this angle."
    },
    {
      type: "image",
      url: "data:image/png;base64,AAAA",
      mediaType: "image/png",
      providerType: "input_image"
    }
  ]);
  assert.equal(result.items[0].text, "Show me the damage from this angle.");
  assert.equal(result.items[1].text, "The dent is visible on the rear door.");
});
