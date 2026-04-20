import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseClaudeOutputLine } from "../dist/notifications.js";
import { getClaudeThreadHistory } from "../dist/threads.js";

test("parseClaudeOutputLine preserves text and image assistant parts", () => {
  const parsed = parseClaudeOutputLine(JSON.stringify({
    type: "assistant",
    session_id: "claude-thread-1",
    message: {
      id: "msg_123",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Gallery for the first listing."
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AAAA"
          }
        }
      ]
    }
  }));

  assert.equal(parsed.claudeSessionRef, "claude-thread-1");
  assert.equal(parsed.providerMessageId, "msg_123");
  assert.deepEqual(parsed.events, [
    {
      type: "assistant.final",
      text: "Gallery for the first listing.",
      parts: [
        {
          type: "text",
          text: "Gallery for the first listing."
        },
        {
          type: "image",
          data: "AAAA",
          mediaType: "image/png",
          sourceType: "base64"
        }
      ],
      providerMessageId: "msg_123"
    }
  ]);
});

test("getClaudeThreadHistory preserves image parts alongside tool records", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "nla-claude-rich-"));
  t.after(async () => {
    await rm(configDir, {
      recursive: true,
      force: true
    });
  });

  const transcriptDir = path.join(configDir, "projects", "workspace");
  await mkdir(transcriptDir, {
    recursive: true
  });

  await writeFile(path.join(transcriptDir, "thread-claude.jsonl"), [
    JSON.stringify({
      timestamp: "2026-04-20T12:00:00.000Z",
      type: "assistant",
      sessionId: "thread-claude",
      cwd: "/tmp/workspace",
      message: {
        id: "msg_456",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Photos for the listing."
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "BBBB"
            }
          },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Glob",
            input: {
              pattern: "**/*.jpg"
            }
          }
        ]
      }
    })
  ].join("\n"));

  const result = await getClaudeThreadHistory({
    configDir,
    threadRef: "thread-claude"
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    itemId: "msg_456",
    kind: "message",
    role: "assistant",
    text: "Photos for the listing.",
    parts: [
      {
        type: "text",
        text: "Photos for the listing."
      },
      {
        type: "image",
        data: "BBBB",
        mediaType: "image/png",
        sourceType: "base64"
      }
    ],
    createdAt: "2026-04-20T12:00:00.000Z",
    metadata: {
      claudeType: "assistant",
      claudeMessageId: "msg_456"
    }
  });
  assert.equal(result.items[1].kind, "tool_call");
  assert.equal(result.items[1].callId, "toolu_1");
  assert.equal(result.items[1].toolName, "Glob");
});
