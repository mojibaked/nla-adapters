import assert from "node:assert/strict";
import test from "node:test";

import { createEnvelope } from "@nla/protocol";
import { createAdapterRuntime } from "@nla/sdk-core";
import * as Effect from "effect/Effect";
import { createWalletAgent } from "../dist/index.js";

const createFakeStorage = () => {
  const store = new Map();
  return {
    getJson: ({ scope, key }) => Effect.succeed(store.get(`${scope}:${key}`)),
    putJson: ({ scope, key, value }) => Effect.sync(() => {
      store.set(`${scope}:${key}`, value);
    })
  };
};

const createAccount = (name, address) => ({
  id: `account:${name}`,
  chainFamily: "evm",
  curve: "secp256k1",
  address,
  label: name,
  isDefault: true,
  eligibleDeviceIds: [`device:${name}`]
});

const createModel = () => ({
  async respond(request) {
    const toolResult = [...request.messages].reverse().find((message) =>
      message.role === "tool" && message.toolName === "get_wallet_accounts"
    );

    if (!toolResult) {
      return {
        type: "tool_calls",
        calls: [
          {
            callId: "call:get-wallet-accounts",
            toolName: "get_wallet_accounts",
            input: {
              kind: "list"
            }
          }
        ]
      };
    }

    const output = JSON.parse(toolResult.text);
    return {
      type: "assistant",
      text: output.accounts[0]?.address ?? "missing"
    };
  }
});

const createDependencies = (account) => ({
  createModel,
  storage: createFakeStorage(),
  signing: {
    requestSignature: (request) =>
      Effect.succeed({
        requestId: request.requestId,
        sessionId: request.sessionId,
        deviceId: account.eligibleDeviceIds[0],
        status: "approved",
        signature: "0x1",
        signatureEncoding: "hex",
        resolvedAt: new Date(0).toISOString()
      })
  },
  wallet: {
    listAccounts: () => Effect.succeed([account]),
    resolveAccount: () => Effect.succeed(account),
    ensureAccount: () => Effect.succeed(account)
  }
});

const runWalletAccountTurn = async (runtime, sessionId, turnId) => {
  await runtime.handle(createEnvelope("session.start", {
    sessionId
  }, {
    correlationId: `start:${sessionId}`
  }));

  const messages = [];
  await runtime.handleStream(createEnvelope("session.message", {
    sessionId,
    role: "user",
    text: "what wallet accounts are connected?",
    metadata: {
      turnId,
      clientId: `client:${sessionId}`
    }
  }, {
    correlationId: `turn:${sessionId}`
  }), (message) => {
    messages.push(message);
  });

  const failure = messages.find((message) => message.type === "session.failed");
  assert.equal(failure, undefined);

  const assistantMessage = messages.find((message) =>
    message.type === "session.message" && message.data.role === "assistant"
  );
  assert.ok(assistantMessage);
  return assistantMessage.data.text;
};

test("wallet agent scopes injected capabilities to each adapter instance", async () => {
  const accountA = createAccount("alpha", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const accountB = createAccount("beta", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

  const runtimeA = createAdapterRuntime(createWalletAgent(createDependencies(accountA)));
  const runtimeB = createAdapterRuntime(createWalletAgent(createDependencies(accountB)));

  assert.equal(
    await runWalletAccountTurn(runtimeA, "sess_wallet_deps_a", "turn_wallet_deps_a"),
    accountA.address
  );
  assert.equal(
    await runWalletAccountTurn(runtimeB, "sess_wallet_deps_b", "turn_wallet_deps_b"),
    accountB.address
  );
});
