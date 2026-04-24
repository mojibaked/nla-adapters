import { createHash } from "node:crypto";
import {
  defineToolLoopSessionAdapter,
  tool as nlaTool,
  type NlaSessionToolContextBase,
  type NlaToolLoopModel,
  type NlaToolLoopSessionMemoryStore
} from "@nla/sdk-core";
import type { NlaActivityData } from "@nla/protocol";
import type {
  BinaryEncoding,
  EffectStorageClient,
  EvmTransactionSigningRequest,
  SignatureEncoding,
  SigningCapabilityClient,
  SigningRequest,
  SigningResolution,
  SolanaTransactionSigningRequest,
  WalletAccountCandidate,
  WalletCapabilityClient,
  WalletChainFamily
} from "@nla-adapters/contracts";
import { base64 } from "@scure/base";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  clusterApiUrl,
  Connection as SolanaConnection,
  PublicKey,
  SystemProgram,
  Transaction
} from "@solana/web3.js";
import {
  createPublicClient,
  hexToBytes,
  http,
  isHex,
  parseEther,
  type Chain,
  type Hex
} from "viem";
import {
  mainnet,
  polygon,
  sepolia
} from "viem/chains";

const TransferHistoryStorageKey = "wallet.transferHistory";
const TransactionLedgerStorageKey = "wallet.transactions";
const WalletContactsStorageKey = "wallet.contacts";
const EvmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const SolanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DefaultPublicAlchemyApiKey = "GwaWJvKszxLtb3Ay30znz";
const NativeTransferGas = 21_000n;
const SolanaLamportsPerSol = 1_000_000_000n;
const DefaultConfirmationWaitTimeoutMs = 15_000;
const DefaultConfirmationPollIntervalMs = 1_000;

interface TransferToolInput {
  readonly amount?: unknown;
  readonly assetSymbol?: unknown;
  readonly fromAddress?: unknown;
  readonly toAddress?: unknown;
  readonly recipient?: unknown;
  readonly chain?: unknown;
  readonly note?: unknown;
}

interface ParsedTransferToolInput {
  readonly chain: string;
  readonly chainFamily: WalletChainFamily;
  readonly assetSymbol: string;
  readonly amount: string;
  readonly fromAddress?: string;
  readonly toAddress?: string;
  readonly recipient?: string;
  readonly note?: string;
}

interface GenericSigningToolInput {
  readonly kind: SigningRequest["kind"];
  readonly chain?: string;
  readonly address?: string;
  readonly chainId?: number;
  readonly note?: string;
  readonly digest?: string;
  readonly digestEncoding?: string;
  readonly algorithm?: string;
  readonly message?: string;
  readonly messageEncoding?: string;
  readonly typedData?: Readonly<Record<string, unknown>>;
  readonly evmTransaction?: Readonly<Record<string, unknown>>;
  readonly solanaTransaction?: string;
  readonly solanaTransactionEncoding?: string;
  readonly solanaTransactionVersion?: string;
}

interface WalletAgentToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

interface WalletContactRecord {
  readonly name: string;
  readonly address: string;
  readonly chainFamily: WalletChainFamily;
  readonly chain?: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type ManageContactsInput =
  | {
      readonly operation: "add";
      readonly name: string;
      readonly address: string;
      readonly chainFamily?: WalletChainFamily;
      readonly chain?: string;
      readonly note?: string;
    }
  | {
      readonly operation: "update";
      readonly targetName: string;
      readonly targetChainFamily?: WalletChainFamily;
      readonly targetChain?: string;
      readonly name?: string;
      readonly address?: string;
      readonly chainFamily?: WalletChainFamily;
      readonly chain?: string;
      readonly note?: string;
    };

type GetContactsQuery =
  | {
      readonly kind: "list";
      readonly chainFamily?: WalletChainFamily;
      readonly chain?: string;
    }
  | {
      readonly kind: "lookup";
      readonly name: string;
      readonly chainFamily?: WalletChainFamily;
      readonly chain?: string;
    };

interface WalletTransferView {
  readonly transferId: string;
  readonly requestId: string;
  readonly chain: string;
  readonly chainFamily: WalletChainFamily;
  readonly assetSymbol: string;
  readonly amount: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly recipientName?: string;
  readonly note?: string;
  readonly requestedByClientId: string;
  readonly requestedAt: string;
  readonly eligibleDeviceIds: ReadonlyArray<string>;
  readonly status: WalletTransactionStatus;
  readonly signerDeviceId?: string;
  readonly txHash?: string;
  readonly submittedAt?: string;
  readonly confirmedAt?: string;
  readonly blockNumber?: string;
  readonly error?: WalletTransactionError;
}

interface WalletTransferResultOutput {
  readonly kind: "wallet.transfer_result";
  readonly transfer: WalletTransferView;
}

interface WalletSignatureRequestView {
  readonly requestId: string;
  readonly requestKind: SigningRequest["kind"];
  readonly chain: string;
  readonly chainFamily: WalletChainFamily;
  readonly address: string;
  readonly chainId?: number;
  readonly requestedAt: string;
  readonly requestedByClientId: string;
  readonly eligibleDeviceIds: ReadonlyArray<string>;
  readonly preview: Readonly<Record<string, unknown>>;
}

interface WalletSignatureResultOutput {
  readonly kind: "wallet.signature_result";
  readonly status: SigningResolution["status"];
  readonly request: WalletSignatureRequestView;
  readonly resolution: {
    readonly deviceId: string;
    readonly resolvedAt: string;
    readonly signature?: string;
    readonly signatureEncoding?: SignatureEncoding;
    readonly signedPayload?: string;
    readonly signedPayloadEncoding?: Exclude<BinaryEncoding, "utf8">;
  };
}

interface WalletTransferStatusResultOutput {
  readonly kind: "wallet.transfer_status_result";
  readonly query: TransferStatusQuery;
  readonly found: boolean;
  readonly transfer?: WalletTransferView;
  readonly transfers?: ReadonlyArray<WalletTransferView>;
  readonly totalTransfers: number;
}

interface WalletContactView {
  readonly name: string;
  readonly address: string;
  readonly chainFamily: WalletChainFamily;
  readonly chain?: string;
  readonly note?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface WalletContactsResultOutput {
  readonly kind: "wallet.contacts_result";
  readonly operation: "add" | "update" | "list" | "lookup";
  readonly status: "created" | "updated" | "unchanged" | "ok" | "not_found" | "ambiguous";
  readonly contact?: WalletContactView;
  readonly contacts?: ReadonlyArray<WalletContactView>;
  readonly name?: string;
  readonly chainFamily?: WalletChainFamily;
  readonly chain?: string;
}

interface WalletAccountView {
  readonly id: string;
  readonly chainFamily: WalletChainFamily;
  readonly curve: "secp256k1" | "ed25519";
  readonly address: string;
  readonly derivationPath?: string;
  readonly derivationProfile?: string;
  readonly label?: string;
  readonly isDefault?: boolean;
  readonly eligibleDeviceIds: ReadonlyArray<string>;
}

interface WalletAccountsResultOutput {
  readonly kind: "wallet.accounts_result";
  readonly query: WalletAccountQuery;
  readonly status: "ok" | "not_found" | "ambiguous";
  readonly accounts: ReadonlyArray<WalletAccountView>;
  readonly defaultAccount?: WalletAccountView;
}

type WalletAgentToolOutput =
  | WalletTransferResultOutput
  | WalletSignatureResultOutput
  | WalletTransferStatusResultOutput
  | WalletContactsResultOutput
  | WalletAccountsResultOutput;

type WalletAgentStorageClient = Pick<EffectStorageClient, "getJson" | "putJson">;

export interface WalletAgentDependencies {
  readonly createModel: () => NlaToolLoopModel;
  readonly storage: WalletAgentStorageClient;
  readonly signing: SigningCapabilityClient;
  readonly wallet: WalletCapabilityClient;
  readonly conversationMemory?: NlaToolLoopSessionMemoryStore<{}>;
}

interface PendingTransferRequest {
  readonly transactionId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly requestedByClientId: string;
  readonly chain: string;
  readonly assetSymbol: string;
  readonly amount: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly note?: string;
  readonly digest: string;
  readonly requestedAt: string;
  readonly eligibleDeviceIds: ReadonlyArray<string>;
  readonly preview: Readonly<Record<string, unknown>>;
  readonly signingRequest: SigningRequest;
}

interface TransferHistoryEntry extends PendingTransferRequest {
  readonly resolution: SigningResolution;
}

interface PendingSigningRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly requestedByClientId: string;
  readonly requestedAt: string;
  readonly eligibleDeviceIds: ReadonlyArray<string>;
  readonly summary: string;
  readonly signingRequest: SigningRequest;
}

type WalletTransactionStatus =
  | "awaiting_signature"
  | "signed"
  | "rejected"
  | "submitted"
  | "confirmed"
  | "failed";

interface WalletTransactionError {
  readonly code?: string;
  readonly message: string;
  readonly at: string;
}

interface WalletTransactionRecord extends PendingTransferRequest {
  readonly status: WalletTransactionStatus;
  readonly updatedAt: string;
  readonly resolution?: SigningResolution;
  readonly txHash?: string;
  readonly submittedAt?: string;
  readonly confirmedAt?: string;
  readonly blockNumber?: string;
  readonly error?: WalletTransactionError;
}

type TransferChainKey = "ethereum" | "sepolia" | "polygon" | "solana";

interface TransferChainConfigBase {
  readonly key: TransferChainKey;
  readonly chainFamily: WalletChainFamily;
  readonly nativeSymbol: string;
  readonly aliases: ReadonlyArray<string>;
  readonly rpcUrlEnv: string;
}

interface EvmChainConfig extends TransferChainConfigBase {
  readonly chainFamily: "evm";
  readonly chain: Chain;
  readonly url: (apiKey: string) => string;
}

interface SolanaChainConfig extends TransferChainConfigBase {
  readonly chainFamily: "solana";
  readonly cluster: "mainnet-beta";
  readonly url: (apiKey: string) => string;
}

type TransferChainConfig = EvmChainConfig | SolanaChainConfig;

const TransferChains: ReadonlyArray<TransferChainConfig> = [
  {
    key: "ethereum",
    chainFamily: "evm",
    chain: mainnet,
    nativeSymbol: "ETH",
    aliases: ["ethereum", "mainnet", "eth-mainnet", "eth"],
    rpcUrlEnv: "WALLET_AGENT_RPC_URL_ETHEREUM",
    url: (apiKey) => `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`
  },
  {
    key: "sepolia",
    chainFamily: "evm",
    chain: sepolia,
    nativeSymbol: "ETH",
    aliases: ["sepolia", "eth-sepolia", "ethereum-sepolia"],
    rpcUrlEnv: "WALLET_AGENT_RPC_URL_SEPOLIA",
    url: (apiKey) => `https://eth-sepolia.g.alchemy.com/v2/${apiKey}`
  },
  {
    key: "polygon",
    chainFamily: "evm",
    chain: polygon,
    nativeSymbol: "POL",
    aliases: ["polygon", "polygon-mainnet", "matic", "matic-mainnet", "pol"],
    rpcUrlEnv: "WALLET_AGENT_RPC_URL_POLYGON",
    url: (apiKey) => `https://polygon-mainnet.g.alchemy.com/v2/${apiKey}`
  },
  {
    key: "solana",
    chainFamily: "solana",
    cluster: "mainnet-beta",
    nativeSymbol: "SOL",
    aliases: ["solana", "sol", "solana-mainnet", "mainnet-beta", "solana-mainnet-beta"],
    rpcUrlEnv: "WALLET_AGENT_RPC_URL_SOLANA",
    url: (apiKey) => `https://solana-mainnet.g.alchemy.com/v2/${apiKey}`
  }
];

const TransferSignatureTool: WalletAgentToolSpec = {
  name: "request_transfer_signature",
  description: [
    "Prepare a native-token transfer signature request.",
    "Use this when the user wants to send crypto and the message includes amount plus either a recipient address or a saved contact name.",
    "If the sender address is omitted, resolve a default wallet account from the host when one is available.",
    "Saved contacts can be referenced through the recipient field.",
    "This prepares a locally tracked transfer request.",
    "When the signer returns a broadcastable transaction payload, the host submits it and tracks its status."
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["amount"],
    properties: {
      amount: {
        type: "string",
        description: "Decimal amount to transfer"
      },
      assetSymbol: {
        type: "string",
        description: "Ticker or symbol for the asset, for example ETH"
      },
      fromAddress: {
        type: "string",
        description: "Optional sender wallet address. Omit to use a resolved default wallet account."
      },
      toAddress: {
        type: "string",
        description: "Recipient wallet address"
      },
      recipient: {
        type: "string",
        description: "Saved contact name or recipient wallet address"
      },
      chain: {
        type: "string",
        description: "Chain name or identifier, for example sepolia"
      },
      note: {
        type: "string",
        description: "Optional memo to include in the transfer preview"
      }
    }
  }
};

const ManageContactsTool: WalletAgentToolSpec = {
  name: "manage_contacts",
  description: [
    "Add or update a saved wallet contact.",
    "Use operation=add when the user wants to save a new contact name and wallet address.",
    "Use operation=update when the user wants to change an existing contact's name, address, note, or chain metadata."
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["add", "update"]
      },
      targetName: {
        type: "string",
        description: "Existing contact name to update when operation=update."
      },
      targetChainFamily: {
        type: "string",
        enum: ["evm", "solana"],
        description: "Optional existing chain family filter when operation=update."
      },
      targetChain: {
        type: "string",
        description: "Optional existing chain filter when operation=update."
      },
      name: {
        type: "string",
        description: "Contact name. Required for operation=add. Optional replacement name for operation=update."
      },
      address: {
        type: "string",
        description: "Wallet address to save or replace."
      },
      chainFamily: {
        type: "string",
        enum: ["evm", "solana"],
        description: "Optional chain family for the saved contact."
      },
      chain: {
        type: "string",
        description: "Optional chain or network label such as ethereum, sepolia, polygon, or solana."
      },
      note: {
        type: "string",
        description: "Optional note to save with the contact."
      }
    }
  }
};

const GetContactsTool: WalletAgentToolSpec = {
  name: "get_contacts",
  description: [
    "List saved wallet contacts or look up a specific contact by name.",
    "Use this when the user asks for their contacts or wants to inspect which address is saved for a contact."
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: {
        type: "string",
        enum: ["list", "lookup"]
      },
      name: {
        type: "string",
        description: "Contact name to look up when kind=lookup."
      },
      chainFamily: {
        type: "string",
        enum: ["evm", "solana"]
      },
      chain: {
        type: "string",
        description: "Optional chain filter such as ethereum, sepolia, polygon, or solana."
      }
    }
  }
};

const GenericSignatureTool: WalletAgentToolSpec = {
  name: "request_signature_operation",
  description: [
    "Prepare a non-transfer wallet signing request.",
    "Use this when the user wants to sign a digest, message, typed data payload, or prebuilt transaction.",
    "Supported kinds are digest, evm.personal_message, evm.typed_data, evm.transaction, solana.message, and solana.transaction.",
    "If the signer address is omitted, resolve a default wallet account for the request chain family when one is available.",
    "Do not use this tool for simple native token sends; use request_transfer_signature instead."
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: {
        type: "string",
        enum: [
          "digest",
          "evm.personal_message",
          "evm.typed_data",
          "evm.transaction",
          "solana.message",
          "solana.transaction"
        ]
      },
      chain: {
        type: "string",
        description: "Chain or network name, for example ethereum, sepolia, polygon, or solana."
      },
      address: {
        type: "string",
        description: "Optional signer wallet address. Omit to resolve a default account."
      },
      chainId: {
        type: "integer",
        description: "Optional EVM chain id when the request is for an EVM message, typed data, or transaction."
      },
      note: {
        type: "string",
        description: "Optional note to include in the request preview."
      },
      digest: {
        type: "string",
        description: "Digest to sign for kind=digest."
      },
      digestEncoding: {
        type: "string",
        enum: ["hex", "base64"],
        description: "Digest encoding for kind=digest."
      },
      algorithm: {
        type: "string",
        enum: ["secp256k1", "ed25519"],
        description: "Optional signing algorithm hint for kind=digest."
      },
      message: {
        type: "string",
        description: "Message to sign for evm.personal_message or solana.message."
      },
      messageEncoding: {
        type: "string",
        enum: ["utf8", "hex", "base64"],
        description: "Encoding for the message field."
      },
      typedData: {
        type: "object",
        description: "EIP-712 typed data object for kind=evm.typed_data."
      },
      evmTransaction: {
        type: "object",
        description: "Unsigned EVM transaction object for kind=evm.transaction."
      },
      solanaTransaction: {
        type: "string",
        description: "Serialized base64 Solana transaction for kind=solana.transaction."
      },
      solanaTransactionEncoding: {
        type: "string",
        enum: ["base64"],
        description: "Encoding for the solanaTransaction field."
      },
      solanaTransactionVersion: {
        type: "string",
        enum: ["legacy", "v0"],
        description: "Solana transaction version."
      }
    }
  }
};

const TransferStatusTool: WalletAgentToolSpec = {
  name: "get_transfer_status",
  description: [
    "Look up the user's locally tracked wallet transfer status.",
    "Use this for questions about whether a recent transfer worked, failed, was submitted, was confirmed, or for listing recent transfers."
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: {
        type: "string",
        enum: ["latest", "recent", "lookup"]
      },
      id: {
        type: "string",
        description: "Optional transfer id, request id, transaction hash, or signature when kind=lookup."
      }
    }
  }
};

const WalletAccountTool: WalletAgentToolSpec = {
  name: "get_wallet_accounts",
  description: [
    "Look up connected wallet accounts published by paired signer devices.",
    "Use this for questions about wallet addresses, default wallet accounts, or which wallets are connected."
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: {
        type: "string",
        enum: ["default", "list"]
      },
      chainFamily: {
        type: "string",
        enum: ["evm", "solana"]
      },
      chain: {
        type: "string",
        description: "Optional specific chain scope such as ethereum, sepolia, polygon, or solana."
      }
    }
  }
};

type WalletAgentNlaToolContext = NlaSessionToolContextBase;

export const createWalletAgent = (
  dependencies: WalletAgentDependencies
) => {
  return defineToolLoopSessionAdapter<{}>({
    id: "wallet.agent",
    name: "Wallet Agent",
    description: "Portable wallet agent that uses injected wallet, signing, and storage capabilities.",
    instructions: [
      "You help the user manage wallet contacts and prepare wallet signing requests.",
      "Use the request_transfer_signature tool when the user clearly wants to send native tokens and provides enough detail to prepare the transfer.",
      "The transfer tool accepts either a direct recipient address or a saved contact name.",
      "Use the manage_contacts tool when the user wants to add or update a saved contact.",
      "Use the get_contacts tool when the user wants to list saved contacts or retrieve a saved contact by name.",
      "Use the request_signature_operation tool when the user wants to sign a digest, message, typed data payload, or a prebuilt transaction.",
      "Use the get_transfer_status tool for questions about whether a transfer worked, failed, was submitted, was confirmed, or for recent transfer history.",
      "Use the get_wallet_accounts tool for questions about wallet addresses, defaults, or connected accounts.",
      "Never invent tool names beyond the tools that were provided.",
      "Never invent contact names, saved addresses, wallet addresses, amounts, assets, or chains.",
      "Do not invent wallet addresses, amounts, assets, or chains.",
      "If the request is missing critical fields, respond directly and say what is missing.",
      "A sender address is not required if the host can resolve a default wallet account for the requested chain family.",
      "When possible, prepare a broadcastable native-token transaction for the signer so the host can submit it after approval.",
      "If the signer only returns a signature and not a signed payload, the host should keep the transfer tracked locally.",
      "Do not route transfers through the generic signing tool unless the user explicitly provides a raw transaction payload to sign."
    ].join(" "),
    model: () =>
      dependencies.createModel(),
    maxIterations: 6,
    memory: dependencies.conversationMemory,
    tools: [
      nlaTool<{}, ParsedTransferToolInput, WalletTransferResultOutput>({
        name: TransferSignatureTool.name,
        description: TransferSignatureTool.description,
        inputSchema: TransferSignatureTool.inputSchema,
        decode: decodeTransferToolInput,
        execute: async (context, input) =>
          Effect.runPromise(
            executeTransferSignatureTool(toWalletAgentExecutionContext(context, dependencies), input)
          )
      }),
      nlaTool<{}, ManageContactsInput, WalletContactsResultOutput>({
        name: ManageContactsTool.name,
        description: ManageContactsTool.description,
        inputSchema: ManageContactsTool.inputSchema,
        decode: decodeManageContactsToolInput,
        execute: async (context, input) =>
          Effect.runPromise(
            executeManageContactsTool(toWalletAgentExecutionContext(context, dependencies), input)
          )
      }),
      nlaTool<{}, GetContactsQuery, WalletContactsResultOutput>({
        name: GetContactsTool.name,
        description: GetContactsTool.description,
        inputSchema: GetContactsTool.inputSchema,
        decode: decodeGetContactsToolInput,
        execute: async (context, input) =>
          Effect.runPromise(
            executeGetContactsTool(toWalletAgentExecutionContext(context, dependencies), input)
          )
      }),
      nlaTool<{}, GenericSigningToolInput, WalletSignatureResultOutput>({
        name: GenericSignatureTool.name,
        description: GenericSignatureTool.description,
        inputSchema: GenericSignatureTool.inputSchema,
        decode: decodeGenericSigningToolInput,
        execute: async (context, input) =>
          Effect.runPromise(
            executeGenericSignatureTool(toWalletAgentExecutionContext(context, dependencies), input)
          )
      }),
      nlaTool<{}, TransferStatusQuery, WalletTransferStatusResultOutput>({
        name: TransferStatusTool.name,
        description: TransferStatusTool.description,
        inputSchema: TransferStatusTool.inputSchema,
        decode: decodeTransferStatusToolInput,
        execute: async (context, input) =>
          Effect.runPromise(
            executeTransferStatusTool(toWalletAgentExecutionContext(context, dependencies), input)
          )
      }),
      nlaTool<{}, WalletAccountQuery, WalletAccountsResultOutput>({
        name: WalletAccountTool.name,
        description: WalletAccountTool.description,
        inputSchema: WalletAccountTool.inputSchema,
        decode: decodeWalletAccountToolInput,
        execute: async (context, input) =>
          Effect.runPromise(
            executeWalletAccountTool(toWalletAgentExecutionContext(context, dependencies), input)
          )
      })
    ]
  });
};

const toWalletAgentExecutionContext = (
  context: WalletAgentNlaToolContext,
  dependencies: WalletAgentDependencies
): WalletAgentExecutionContext => ({
  sessionId: context.sessionId,
  turnId: requireWalletTurnId(context.turnId),
  clientId: context.clientId,
  storage: dependencies.storage,
  signing: dependencies.signing,
  wallet: dependencies.wallet,
  activity: (activity) =>
    Effect.sync(() => {
      context.activity(activity);
    })
});

const requireWalletTurnId = (turnId: string | undefined): string => {
  if (!turnId) {
    throw new Error("wallet.agent requires turnId metadata for NLA session.message requests");
  }

  return turnId;
};

interface WalletAgentExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly clientId: string;
  readonly storage: WalletAgentStorageClient;
  readonly signing: SigningCapabilityClient;
  readonly wallet: WalletCapabilityClient;
  readonly activity: (activity: NlaActivityData) => Effect.Effect<void>;
}

const executeTransferSignatureTool = (
  context: WalletAgentExecutionContext,
  input: ParsedTransferToolInput
): Effect.Effect<WalletTransferResultOutput, Error> =>
  Effect.gen(function* () {
    const pending = yield* createPendingTransfer(context, input);
    yield* upsertTransactionRecord(context, createInitialTransactionRecord(pending));
    yield* emitTransactionActivity(
      context,
      pending.transactionId,
      `Awaiting signature for ${transferSummary(pending)}`,
      "awaiting_input"
    );

    const resolution = yield* context.signing.requestSignature(pending.signingRequest);
    const transaction = yield* finalizeTransactionRecord(context, pending, resolution);
    yield* upsertTransactionRecord(context, transaction);
    yield* appendTransferHistory(context, {
      ...pending,
      resolution
    });
    yield* emitTransactionResolutionActivity(context, transaction);

    return createTransferResultOutput(transaction);
  });

const executeGenericSignatureTool = (
  context: WalletAgentExecutionContext,
  input: GenericSigningToolInput
): Effect.Effect<WalletSignatureResultOutput, Error> =>
  Effect.gen(function* () {
    const pending = yield* createPendingSigning(context, input);
    yield* emitSigningActivity(
      context,
      pending.requestId,
      `Awaiting signature for ${pending.summary}`,
      "awaiting_input"
    );

    const resolution = yield* context.signing.requestSignature(pending.signingRequest);
    yield* emitSigningActivity(
      context,
      pending.requestId,
      resolution.status === "approved"
        ? `Signature approved for ${pending.summary}`
        : `Signature rejected for ${pending.summary}`,
      resolution.status === "approved" ? "succeeded" : "failed"
    );

    return createSignatureResultOutput(pending, resolution);
  });

const executeTransferStatusTool = (
  context: WalletAgentExecutionContext,
  input: TransferStatusQuery
): Effect.Effect<WalletTransferStatusResultOutput, Error> =>
  Effect.map(
    refreshTrackedTransactions(context),
    (transactions) => createTransferStatusResultOutput(input, transactions)
  );

const executeManageContactsTool = (
  context: WalletAgentExecutionContext,
  input: ManageContactsInput
): Effect.Effect<WalletContactsResultOutput, Error> =>
  manageWalletContacts(context, input);

const executeGetContactsTool = (
  context: WalletAgentExecutionContext,
  input: GetContactsQuery
): Effect.Effect<WalletContactsResultOutput, Error> =>
  answerContactQuery(context, input);

const executeWalletAccountTool = (
  context: WalletAgentExecutionContext,
  input: WalletAccountQuery
): Effect.Effect<WalletAccountsResultOutput, Error> =>
  answerWalletAccountQuery(context, input);

const createPendingTransfer = (
  context: WalletAgentExecutionContext,
  input: ParsedTransferToolInput
): Effect.Effect<PendingTransferRequest, Error> =>
  Effect.gen(function* () {
    const destination = yield* resolveTransferDestination(context, input);
    const source = yield* resolveTransferSource(context, input);
    return yield* createPendingTransferFromParsedToolInput(context, input, source, destination);
  });

const createPendingTransferFromParsedToolInput = (
  context: Pick<WalletAgentExecutionContext, "sessionId" | "turnId" | "clientId">,
  toolInput: ParsedTransferToolInput,
  source: {
    readonly fromAddress: string;
    readonly eligibleDeviceIds: ReadonlyArray<string>;
  },
  destination: {
    readonly toAddress: string;
    readonly recipientName?: string;
  }
): Effect.Effect<PendingTransferRequest, Error> =>
  Effect.gen(function* () {
    const requestedAt = new Date().toISOString();
    const requestId = `sigreq:${context.turnId}`;
    const transactionId = `tx:${requestId}`;
    const preview = {
      type: "native-transfer",
      chain: toolInput.chain,
      assetSymbol: toolInput.assetSymbol,
      amount: toolInput.amount,
      fromAddress: source.fromAddress,
      toAddress: destination.toAddress,
      ...(destination.recipientName ? { recipientName: destination.recipientName } : {}),
      ...(toolInput.note ? { note: toolInput.note } : {}),
      requestedByClientId: context.clientId
    } satisfies Readonly<Record<string, unknown>>;

    const draft = {
      transactionId,
      requestId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      requestedByClientId: context.clientId,
      chain: toolInput.chain,
      assetSymbol: toolInput.assetSymbol,
      amount: toolInput.amount,
      fromAddress: source.fromAddress,
      toAddress: destination.toAddress,
      note: toolInput.note,
      digest: createDigest({
        requestId,
        ...preview
      }),
      requestedAt,
      eligibleDeviceIds: source.eligibleDeviceIds,
      preview
    } satisfies Omit<PendingTransferRequest, "signingRequest">;

    const signingRequest = yield* prepareSigningRequest(draft);
    return {
      ...draft,
      signingRequest
    } satisfies PendingTransferRequest;
  });

const resolveTransferDestination = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  toolInput: ParsedTransferToolInput
): Effect.Effect<{
  readonly toAddress: string;
  readonly recipientName?: string;
}, Error> => {
  if (toolInput.toAddress) {
    return Effect.succeed({
      toAddress: toolInput.toAddress
    });
  }

  if (!toolInput.recipient) {
    return Effect.fail(
      new Error("Recipient wallet address or saved contact name is required")
    );
  }

  return resolveSavedContactRecipient(context, toolInput.recipient, {
    chainFamily: toolInput.chainFamily,
    chain: toolInput.chain
  });
};

const createPendingSigning = (
  context: WalletAgentExecutionContext,
  input: GenericSigningToolInput
): Effect.Effect<PendingSigningRequest, Error> =>
  Effect.gen(function* () {
    const requestedAt = new Date().toISOString();
    const requestId = `sigreq:${context.turnId}`;
    const note = input.note;
    const kind = input.kind;

    switch (kind) {
      case "digest": {
        const rawChain = input.chain;
        const algorithm = optionalKeyAlgorithm(input.algorithm);
        const chainFamily = resolveRequestedChainFamily({
          chain: rawChain,
          fromAddress: input.address,
          algorithm
        });
        const chain = rawChain ?? defaultChainForFamily(chainFamily);
        const source = yield* resolveSigningSource(context, {
          chainFamily,
          chain,
          requestedAddress: input.address,
          title: "Wallet setup required",
          body: `Create a local ${describeChainFamily(chainFamily)} wallet on this device to continue signing.`
        });
        const digestEncoding = optionalBinaryEncoding(input.digestEncoding) ?? "hex";
        const digest = requireNonEmptyString(input.digest, "digest");
        const preview = {
          type: "digest-signature",
          digest,
          digestEncoding,
          ...(note ? { note } : {})
        } satisfies Readonly<Record<string, unknown>>;
        const signingRequest = {
          kind,
          requestId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          chain,
          address: source.address,
          digest,
          digestEncoding,
          algorithm,
          preview,
          custody: "client-only-local",
          requestedAt,
          eligibleDeviceIds: source.eligibleDeviceIds,
          signatureEncoding: chainFamily === "solana" ? "base58" : "hex"
        } satisfies SigningRequest;

        return createPendingSigningRequest(context, requestedAt, source.eligibleDeviceIds, signingRequest);
      }
      case "evm.personal_message": {
        const chain = resolveEvmSigningChain(
          input.chain,
          input.chainId
        );
        const source = yield* resolveSigningSource(context, {
          chainFamily: "evm",
          chain: chain.name,
          requestedAddress: input.address,
          title: "Wallet setup required",
          body: "Create a local EVM wallet on this device to continue signing."
        });
        const messageEncoding = requireEvmMessageEncoding(input.messageEncoding, "messageEncoding");
        const message = requireNonEmptyString(input.message, "message");
        const preview = {
          type: "evm-personal-message",
          message: previewMessage(message, messageEncoding),
          messageEncoding,
          ...(note ? { note } : {})
        } satisfies Readonly<Record<string, unknown>>;
        const signingRequest = {
          kind,
          requestId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          chain: chain.name,
          address: source.address,
          chainId: chain.chainId,
          message,
          messageEncoding,
          preview,
          custody: "client-only-local",
          requestedAt,
          eligibleDeviceIds: source.eligibleDeviceIds,
          signatureEncoding: "hex"
        } satisfies SigningRequest;

        return createPendingSigningRequest(context, requestedAt, source.eligibleDeviceIds, signingRequest);
      }
      case "evm.typed_data": {
        const typedData = requireRecord(input.typedData, "typedData");
        const chain = resolveEvmSigningChain(
          input.chain,
          input.chainId ?? typedDataChainId(typedData)
        );
        const source = yield* resolveSigningSource(context, {
          chainFamily: "evm",
          chain: chain.name,
          requestedAddress: input.address,
          title: "Wallet setup required",
          body: "Create a local EVM wallet on this device to continue signing."
        });
        const preview = {
          type: "evm-typed-data",
          primaryType: optionalTrimmedString(typedData.primaryType),
          domainName: optionalRecordString(typedData.domain, "name"),
          chainId: chain.chainId.toString(),
          ...(note ? { note } : {})
        } satisfies Readonly<Record<string, unknown>>;
        const signingRequest = {
          kind,
          requestId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          chain: chain.name,
          address: source.address,
          chainId: chain.chainId,
          typedData,
          preview,
          custody: "client-only-local",
          requestedAt,
          eligibleDeviceIds: source.eligibleDeviceIds,
          signatureEncoding: "hex"
        } satisfies SigningRequest;

        return createPendingSigningRequest(context, requestedAt, source.eligibleDeviceIds, signingRequest);
      }
      case "evm.transaction": {
        const evmTransaction = requireRecord(input.evmTransaction, "evmTransaction");
        const chain = resolveEvmSigningChain(
          input.chain,
          input.chainId ?? optionalPositiveInteger(evmTransaction.chainId)
        );
        const source = yield* resolveSigningSource(context, {
          chainFamily: "evm",
          chain: chain.name,
          requestedAddress: input.address,
          title: "Wallet setup required",
          body: "Create a local EVM wallet on this device to continue signing."
        });
        const transaction: Record<string, unknown> = {
          ...evmTransaction,
          chainId: optionalPositiveInteger(evmTransaction.chainId) ?? chain.chainId
        };
        const preview = {
          type: "evm-transaction",
          toAddress: optionalTrimmedString(transaction.to),
          value: bigintishPreview(transaction.value),
          transactionType: optionalTrimmedString(transaction.type),
          chainId: String(chain.chainId),
          ...(note ? { note } : {})
        } satisfies Readonly<Record<string, unknown>>;
        const signingRequest = {
          kind,
          requestId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          chain: chain.name,
          address: source.address,
          chainId: chain.chainId,
          transaction,
          preview,
          custody: "client-only-local",
          requestedAt,
          eligibleDeviceIds: source.eligibleDeviceIds,
          signatureEncoding: "hex"
        } satisfies SigningRequest;

        return createPendingSigningRequest(context, requestedAt, source.eligibleDeviceIds, signingRequest);
      }
      case "solana.message": {
        const chain = input.chain ?? "solana";
        const source = yield* resolveSigningSource(context, {
          chainFamily: "solana",
          chain,
          requestedAddress: input.address,
          title: "Wallet setup required",
          body: "Create a local Solana wallet on this device to continue signing."
        });
        const messageEncoding = requireMessageEncoding(input.messageEncoding, "messageEncoding");
        const message = requireNonEmptyString(input.message, "message");
        const preview = {
          type: "solana-message",
          message: previewMessage(message, messageEncoding),
          messageEncoding,
          ...(note ? { note } : {})
        } satisfies Readonly<Record<string, unknown>>;
        const signingRequest = {
          kind,
          requestId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          chain,
          address: source.address,
          message,
          messageEncoding,
          preview,
          custody: "client-only-local",
          requestedAt,
          eligibleDeviceIds: source.eligibleDeviceIds,
          signatureEncoding: "base58"
        } satisfies SigningRequest;

        return createPendingSigningRequest(context, requestedAt, source.eligibleDeviceIds, signingRequest);
      }
      case "solana.transaction": {
        const chain = input.chain ?? "solana";
        const source = yield* resolveSigningSource(context, {
          chainFamily: "solana",
          chain,
          requestedAddress: input.address,
          title: "Wallet setup required",
          body: "Create a local Solana wallet on this device to continue signing."
        });
        const version = requireSolanaTransactionVersion(
          input.solanaTransactionVersion ?? "legacy",
          "solanaTransactionVersion"
        );
        const preview = {
          type: "solana-transaction",
          version,
          ...(note ? { note } : {})
        } satisfies Readonly<Record<string, unknown>>;
        const signingRequest = {
          kind,
          requestId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          chain,
          address: source.address,
          version,
          transaction: requireNonEmptyString(input.solanaTransaction, "solanaTransaction"),
          transactionEncoding: requireSolanaTransactionEncoding(
            input.solanaTransactionEncoding ?? "base64",
            "solanaTransactionEncoding"
          ),
          preview,
          custody: "client-only-local",
          requestedAt,
          eligibleDeviceIds: source.eligibleDeviceIds,
          signatureEncoding: "base58"
        } satisfies SigningRequest;

        return createPendingSigningRequest(context, requestedAt, source.eligibleDeviceIds, signingRequest);
      }
    }
  });

const createPendingSigningRequest = (
  context: Pick<WalletAgentExecutionContext, "sessionId" | "turnId" | "clientId">,
  requestedAt: string,
  eligibleDeviceIds: ReadonlyArray<string>,
  signingRequest: SigningRequest
): PendingSigningRequest => ({
  requestId: signingRequest.requestId,
  sessionId: context.sessionId,
  turnId: context.turnId,
  requestedByClientId: context.clientId,
  requestedAt,
  eligibleDeviceIds,
  summary: summarizeSigningRequest(signingRequest),
  signingRequest
});

const prepareSigningRequest = (
  pending: Omit<PendingTransferRequest, "signingRequest">
): Effect.Effect<SigningRequest, Error> => {
  if (broadcastDisabled()) {
    return Effect.succeed(createLegacyDigestSigningRequest(pending));
  }

  const chain = resolveTransferChain(pending.chain);
  if (!chain) {
    return Effect.succeed(createLegacyDigestSigningRequest(pending));
  }

  if (pending.assetSymbol !== chain.nativeSymbol) {
    return Effect.fail(
      new Error(`Host-side broadcast currently supports only ${chain.nativeSymbol} on ${pending.chain}`)
    );
  }

  switch (chain.chainFamily) {
    case "evm":
      return prepareEvmTransactionSigningRequest(pending, chain);
    case "solana":
      return prepareSolanaTransactionSigningRequest(pending, chain);
  }
};

const createLegacyDigestSigningRequest = (
  pending: Omit<PendingTransferRequest, "signingRequest">
): SigningRequest => ({
  kind: "digest",
  requestId: pending.requestId,
  sessionId: pending.sessionId,
  turnId: pending.turnId,
  chain: pending.chain,
  address: pending.fromAddress,
  digest: pending.digest,
  digestEncoding: "hex",
  algorithm: inferChainFamilyFromName(pending.chain) === "solana" ? "ed25519" : "secp256k1",
  preview: pending.preview,
  custody: "client-only-local",
  requestedAt: pending.requestedAt,
  eligibleDeviceIds: pending.eligibleDeviceIds,
  signatureEncoding: inferChainFamilyFromName(pending.chain) === "solana" ? "base58" : "hex"
});

const prepareEvmTransactionSigningRequest = (
  pending: Omit<PendingTransferRequest, "signingRequest">,
  chain: EvmChainConfig
): Effect.Effect<EvmTransactionSigningRequest, Error> =>
  Effect.tryPromise({
    try: async () => {
      const client = createEvmClient(chain);
      const nonce = await client.getTransactionCount({
        address: normalizeHex(pending.fromAddress, "pending.fromAddress"),
        blockTag: "pending"
      });
      const gasPrice = await client.getGasPrice();
      const value = parseEther(pending.amount);

      return {
        kind: "evm.transaction",
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        turnId: pending.turnId,
        chain: pending.chain,
        address: pending.fromAddress,
        chainId: chain.chain.id,
        transaction: {
          to: pending.toAddress,
          nonce,
          gas: NativeTransferGas.toString(),
          gasPrice: gasPrice.toString(),
          value: value.toString(),
          chainId: chain.chain.id,
          type: "legacy"
        },
        preview: pending.preview,
        custody: "client-only-local",
        requestedAt: pending.requestedAt,
        eligibleDeviceIds: pending.eligibleDeviceIds,
        signatureEncoding: "hex"
      } satisfies EvmTransactionSigningRequest;
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error))
  });

const prepareSolanaTransactionSigningRequest = (
  pending: Omit<PendingTransferRequest, "signingRequest">,
  chain: SolanaChainConfig
): Effect.Effect<SolanaTransactionSigningRequest, Error> =>
  Effect.tryPromise({
    try: async () => {
      const connection = createSolanaConnection(chain);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const lamports = parseSolToLamports(pending.amount, "pending.amount");
      const transaction = new Transaction({
        feePayer: new PublicKey(pending.fromAddress),
        recentBlockhash: blockhash
      }).add(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(pending.fromAddress),
          toPubkey: new PublicKey(pending.toAddress),
          lamports: bigIntToNumber(lamports, "pending.amount")
        })
      );
      const serialized = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });

      return {
        kind: "solana.transaction",
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        turnId: pending.turnId,
        chain: pending.chain,
        address: pending.fromAddress,
        version: "legacy",
        transaction: base64.encode(serialized),
        transactionEncoding: "base64",
        preview: pending.preview,
        custody: "client-only-local",
        requestedAt: pending.requestedAt,
        eligibleDeviceIds: pending.eligibleDeviceIds,
        signatureEncoding: "base58"
      } satisfies SolanaTransactionSigningRequest;
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error))
  });

function decodeTransferToolInput(input: unknown): ParsedTransferToolInput {
  const record = asRecord(input);
  const rawChain = optionalTrimmedString(record.chain);
  const rawAssetSymbol = optionalTrimmedString(record.assetSymbol)?.toUpperCase();
  const rawFromAddress = optionalTrimmedString(record.fromAddress);
  const rawToAddress = optionalTrimmedString(record.toAddress);
  const rawRecipient = optionalTrimmedString(record.recipient);
  const inferredRecipientAddress = rawRecipient && inferChainFamilyFromAddress(rawRecipient)
    ? rawRecipient
    : undefined;
  const candidateToAddress = rawToAddress ?? inferredRecipientAddress;
  const chainFamily = resolveRequestedChainFamily({
    chain: rawChain,
    assetSymbol: rawAssetSymbol,
    fromAddress: rawFromAddress,
    toAddress: candidateToAddress
  });
  const chain = rawChain ?? defaultChainForFamily(chainFamily);
  const resolvedChain = resolveTransferChain(chain);
  const amount = requirePositiveDecimal(record.amount, "amount");
  const fromAddress = record.fromAddress === undefined
    ? undefined
    : requireWalletAddress(record.fromAddress, "fromAddress", chainFamily);
  const toAddress = candidateToAddress
    ? requireWalletAddress(
        candidateToAddress,
        rawToAddress ? "toAddress" : "recipient",
        chainFamily
      )
    : undefined;
  const assetSymbol =
    rawAssetSymbol
    ?? resolvedChain?.nativeSymbol
    ?? defaultAssetSymbolForFamily(chainFamily);
  const note = optionalTrimmedString(record.note);
  const recipient = toAddress ? undefined : rawRecipient;

  if (!toAddress && !recipient) {
    throw new Error("recipient or toAddress is required");
  }

  return {
    chain,
    chainFamily,
    assetSymbol,
    amount,
    fromAddress,
    toAddress,
    recipient,
    note
  };
}

function decodeGenericSigningToolInput(input: unknown): GenericSigningToolInput {
  const record = asRecord(input);
  return {
    kind: requireSigningRequestKind(record.kind, "kind"),
    chain: optionalTrimmedString(record.chain),
    address: optionalTrimmedString(record.address),
    chainId: record.chainId === undefined ? undefined : requirePositiveInteger(record.chainId, "chainId"),
    note: optionalTrimmedString(record.note),
    digest: optionalTrimmedString(record.digest),
    digestEncoding: optionalTrimmedString(record.digestEncoding),
    algorithm: optionalTrimmedString(record.algorithm),
    message: optionalTrimmedString(record.message),
    messageEncoding: optionalTrimmedString(record.messageEncoding),
    typedData: optionalRecord(record.typedData, "typedData"),
    evmTransaction: optionalRecord(record.evmTransaction, "evmTransaction"),
    solanaTransaction: optionalTrimmedString(record.solanaTransaction),
    solanaTransactionEncoding: optionalTrimmedString(record.solanaTransactionEncoding),
    solanaTransactionVersion: optionalTrimmedString(record.solanaTransactionVersion)
  };
}

function decodeManageContactsToolInput(input: unknown): ManageContactsInput {
  const record = asRecord(input);
  const operation = requireManageContactsOperation(record.operation);

  if (operation === "add") {
    return {
      operation,
      name: requireNonEmptyString(record.name, "name"),
      address: requireNonEmptyString(record.address, "address"),
      chainFamily: optionalWalletChainFamily(record.chainFamily),
      chain: optionalTrimmedString(record.chain),
      note: optionalTrimmedString(record.note)
    };
  }

  return {
    operation,
    targetName: requireNonEmptyString(record.targetName, "targetName"),
    targetChainFamily: optionalWalletChainFamily(record.targetChainFamily),
    targetChain: optionalTrimmedString(record.targetChain),
    name: optionalTrimmedString(record.name),
    address: optionalTrimmedString(record.address),
    chainFamily: optionalWalletChainFamily(record.chainFamily),
    chain: optionalTrimmedString(record.chain),
    note: optionalTrimmedString(record.note)
  };
}

function decodeGetContactsToolInput(input: unknown): GetContactsQuery {
  const record = asRecord(input);
  const kind = requireGetContactsQueryKind(record.kind);

  if (kind === "lookup") {
    return {
      kind,
      name: requireNonEmptyString(record.name, "name"),
      chainFamily: optionalWalletChainFamily(record.chainFamily),
      chain: optionalTrimmedString(record.chain)
    };
  }

  return {
    kind,
    chainFamily: optionalWalletChainFamily(record.chainFamily),
    chain: optionalTrimmedString(record.chain)
  };
}

const resolveTransferSource = (
  context: Pick<WalletAgentExecutionContext, "sessionId" | "turnId" | "clientId" | "wallet">,
  toolInput: ParsedTransferToolInput
): Effect.Effect<{
  readonly fromAddress: string;
  readonly eligibleDeviceIds: ReadonlyArray<string>;
}, Error> => {
  const explicitFromAddress = toolInput.fromAddress;

  if (explicitFromAddress) {
    return context.wallet.resolveAccount({
      chainFamily: toolInput.chainFamily,
      chain: toolInput.chain,
      requestedAddress: explicitFromAddress
    }).pipe(
      Effect.map((account) => ({
        fromAddress: account.address,
        eligibleDeviceIds: account.eligibleDeviceIds
      })),
      Effect.catchAll(() =>
        Effect.succeed({
          fromAddress: explicitFromAddress,
          eligibleDeviceIds: [context.clientId]
        })
      )
    );
  }

  return context.wallet.ensureAccount({
    sessionId: context.sessionId,
    turnId: context.turnId,
    requestedByClientId: context.clientId,
    chainFamily: toolInput.chainFamily,
    chain: toolInput.chain,
    title: "Wallet setup required",
    body: `Create a local ${describeChainFamily(toolInput.chainFamily)} wallet on this device to continue this transfer.`
  }).pipe(
    Effect.map((account) => ({
      fromAddress: account.address,
      eligibleDeviceIds: account.eligibleDeviceIds
    })),
    Effect.catchAll((error) =>
      Effect.fail(
        new Error(
          `Sender wallet address is missing and no default ${describeChainFamily(toolInput.chainFamily)} wallet account is available: ${error.message}`
        )
      )
    )
  );
};

const resolveSigningSource = (
  context: Pick<WalletAgentExecutionContext, "sessionId" | "turnId" | "clientId" | "wallet">,
  input: {
    readonly chainFamily: WalletChainFamily;
    readonly chain: string;
    readonly requestedAddress?: string;
    readonly title: string;
    readonly body: string;
  }
): Effect.Effect<{
  readonly address: string;
  readonly eligibleDeviceIds: ReadonlyArray<string>;
}, Error> => {
  if (input.requestedAddress) {
    const requestedAddress = input.requestedAddress;
    return context.wallet.resolveAccount({
      chainFamily: input.chainFamily,
      chain: input.chain,
      requestedAddress
    }).pipe(
      Effect.map((account) => ({
        address: account.address,
        eligibleDeviceIds: account.eligibleDeviceIds
      })),
      Effect.catchAll(() =>
        Effect.succeed({
          address: requestedAddress,
          eligibleDeviceIds: [context.clientId]
        })
      )
    );
  }

  return context.wallet.ensureAccount({
    sessionId: context.sessionId,
    turnId: context.turnId,
    requestedByClientId: context.clientId,
    chainFamily: input.chainFamily,
    chain: input.chain,
    title: input.title,
    body: input.body
  }).pipe(
    Effect.map((account) => ({
      address: account.address,
      eligibleDeviceIds: account.eligibleDeviceIds
    })),
    Effect.catchAll((error) =>
      Effect.fail(
        new Error(
          `Signer wallet address is missing and no default ${describeChainFamily(input.chainFamily)} wallet account is available: ${error.message}`
        )
      )
    )
  );
};

const createTransferResultOutput = (
  transaction: WalletTransactionRecord
): WalletTransferResultOutput => ({
  kind: "wallet.transfer_result",
  transfer: toWalletTransferView(transaction)
});

const createSignatureResultOutput = (
  pending: PendingSigningRequest,
  resolution: SigningResolution
): WalletSignatureResultOutput => ({
  kind: "wallet.signature_result",
  status: resolution.status,
  request: toWalletSignatureRequestView(pending),
  resolution: {
    deviceId: resolution.deviceId,
    resolvedAt: resolution.resolvedAt,
    signature: resolution.signature,
    signatureEncoding: resolution.signatureEncoding,
    signedPayload: resolution.signedPayload,
    signedPayloadEncoding: resolution.signedPayloadEncoding
  }
});

const toWalletTransferView = (
  transaction: WalletTransactionRecord
): WalletTransferView => ({
  transferId: transaction.transactionId,
  requestId: transaction.requestId,
  chain: transaction.chain,
  chainFamily: inferChainFamilyFromName(transaction.chain),
  assetSymbol: transaction.assetSymbol,
  amount: transaction.amount,
  fromAddress: transaction.fromAddress,
  toAddress: transaction.toAddress,
  recipientName:
    typeof transaction.preview.recipientName === "string" && transaction.preview.recipientName.trim()
      ? transaction.preview.recipientName.trim()
      : undefined,
  note: transaction.note,
  requestedByClientId: transaction.requestedByClientId,
  requestedAt: transaction.requestedAt,
  eligibleDeviceIds: transaction.eligibleDeviceIds,
  status: transaction.status,
  signerDeviceId: transaction.resolution?.deviceId,
  txHash: transaction.txHash,
  submittedAt: transaction.submittedAt,
  confirmedAt: transaction.confirmedAt,
  blockNumber: transaction.blockNumber,
  error: transaction.error
});

const toWalletSignatureRequestView = (
  pending: PendingSigningRequest
): WalletSignatureRequestView => ({
  requestId: pending.requestId,
  requestKind: pending.signingRequest.kind,
  chain: pending.signingRequest.chain,
  chainFamily: inferChainFamilyFromSigningRequest(pending.signingRequest),
  address: pending.signingRequest.address,
  chainId: "chainId" in pending.signingRequest ? pending.signingRequest.chainId : undefined,
  requestedAt: pending.requestedAt,
  requestedByClientId: pending.requestedByClientId,
  eligibleDeviceIds: pending.eligibleDeviceIds,
  preview: pending.signingRequest.preview
});

const toWalletContactView = (
  contact: WalletContactRecord
): WalletContactView => ({
  name: contact.name,
  address: contact.address,
  chainFamily: contact.chainFamily,
  chain: contact.chain,
  note: contact.note,
  createdAt: contact.createdAt,
  updatedAt: contact.updatedAt
});

const toWalletAccountView = (
  account: WalletAccountCandidate
): WalletAccountView => ({
  id: account.id,
  chainFamily: account.chainFamily,
  curve: account.curve,
  address: account.address,
  derivationPath: account.derivationPath,
  derivationProfile: account.derivationProfile,
  label: account.label,
  isDefault: account.isDefault,
  eligibleDeviceIds: account.eligibleDeviceIds
});

const transferSummary = (
  transfer: Pick<PendingTransferRequest, "amount" | "assetSymbol" | "chain" | "fromAddress" | "toAddress">
): string =>
  [
    `${transfer.amount} ${transfer.assetSymbol}`,
    `on ${transfer.chain}`,
    `from ${shortAddress(transfer.fromAddress)}`,
    `to ${shortAddress(transfer.toAddress)}`
  ].join(" ");

const shortAddress = (value: string): string =>
  value.length <= 12
    ? value
    : `${value.slice(0, 6)}...${value.slice(-4)}`;

const summarizeSigningRequest = (request: SigningRequest): string => {
  switch (request.kind) {
    case "digest":
      return `digest on ${request.chain} with ${shortAddress(request.address)}`;
    case "evm.personal_message":
      return `EVM personal message on ${request.chain} with ${shortAddress(request.address)}`;
    case "evm.typed_data":
      return `EVM typed data on ${request.chain} with ${shortAddress(request.address)}`;
    case "evm.transaction":
      return `EVM transaction on ${request.chain} with ${shortAddress(request.address)}`;
    case "solana.message":
      return `Solana message on ${request.chain} with ${shortAddress(request.address)}`;
    case "solana.transaction":
      return `Solana transaction on ${request.chain} with ${shortAddress(request.address)}`;
  }
};

const inferChainFamilyFromSigningRequest = (
  request: SigningRequest
): WalletChainFamily => {
  switch (request.kind) {
    case "solana.message":
    case "solana.transaction":
      return "solana";
    case "digest":
      return resolveRequestedChainFamily({
        chain: request.chain,
        fromAddress: request.address,
        algorithm: request.algorithm
      });
    default:
      return "evm";
  }
};

const createDigest = (value: unknown): string =>
  `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    ).join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
};

const appendTransferHistory = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  entry: TransferHistoryEntry
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const existing = yield* context.storage.getJson({
      scope: "install",
      key: TransferHistoryStorageKey
    });
    const history = decodeTransferHistory(existing);
    yield* context.storage.putJson({
      scope: "install",
      key: TransferHistoryStorageKey,
      value: [...history, entry]
    });
  });

const readTransactionLedger = (
  context: Pick<WalletAgentExecutionContext, "storage">
): Effect.Effect<ReadonlyArray<WalletTransactionRecord>, Error> =>
  context.storage.getJson({
    scope: "install",
    key: TransactionLedgerStorageKey
  }).pipe(
    Effect.map((value) => decodeTransactionLedger(value))
  );

const upsertTransactionRecord = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  record: WalletTransactionRecord
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const transactions = yield* readTransactionLedger(context);
    yield* context.storage.putJson({
      scope: "install",
      key: TransactionLedgerStorageKey,
      value: [
        ...transactions.filter((entry) => entry.transactionId !== record.transactionId),
        record
      ]
    });
  });

const createInitialTransactionRecord = (
  pending: PendingTransferRequest
): WalletTransactionRecord => ({
  ...pending,
  status: "awaiting_signature",
  updatedAt: pending.requestedAt
});

const transitionTransactionRecord = (
  pending: PendingTransferRequest,
  resolution: SigningResolution
): WalletTransactionRecord => ({
  ...pending,
  status: resolution.status === "approved" ? "signed" : "rejected",
  updatedAt: resolution.resolvedAt,
  resolution
});

const finalizeTransactionRecord = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  pending: PendingTransferRequest,
  resolution: SigningResolution
): Effect.Effect<WalletTransactionRecord, Error> => {
  if (resolution.status !== "approved") {
    return Effect.succeed(transitionTransactionRecord(pending, resolution));
  }

  if (
    pending.signingRequest.kind !== "evm.transaction" &&
    pending.signingRequest.kind !== "solana.transaction"
  ) {
    return Effect.succeed(transitionTransactionRecord(pending, resolution));
  }

  if (!resolution.signedPayload) {
    return Effect.succeed(transitionTransactionRecord(pending, resolution));
  }

  return broadcastSignedTransaction(pending, resolution).pipe(
    Effect.flatMap((transaction) => waitForTransactionConfirmation(context, transaction))
  );
};

const broadcastSignedTransaction = (
  pending: PendingTransferRequest,
  resolution: SigningResolution,
): Effect.Effect<WalletTransactionRecord, Error> =>
  Effect.gen(function* () {
    const chain = resolveTransferChain(pending.chain);
    if (!chain) {
      return transitionTransactionRecord(pending, resolution);
    }

    switch (pending.signingRequest.kind) {
      case "evm.transaction": {
        const signedPayload = normalizeSignedPayloadHex(
          resolution.signedPayload,
          resolution.signedPayloadEncoding
        );
        if (!signedPayload) {
          return transitionTransactionRecord(pending, resolution);
        }

        return yield* Effect.tryPromise({
          try: async () => {
            if (chain.chainFamily !== "evm") {
              throw new Error(`Cannot broadcast EVM transaction on ${chain.key}`);
            }

            const client = createEvmClient(chain);
            const txHash = await client.sendRawTransaction({
              serializedTransaction: signedPayload
            });
            const submittedAt = new Date().toISOString();

            return {
              ...pending,
              status: "submitted" as const,
              updatedAt: submittedAt,
              resolution,
              txHash,
              submittedAt
            } satisfies WalletTransactionRecord;
          },
          catch: (error) => error instanceof Error ? error : new Error(String(error))
        });
      }
      case "solana.transaction": {
        const signedPayload = normalizeSignedPayloadBytes(
          resolution.signedPayload,
          resolution.signedPayloadEncoding
        );
        if (!signedPayload) {
          return transitionTransactionRecord(pending, resolution);
        }

        return yield* Effect.tryPromise({
          try: async () => {
            if (chain.chainFamily !== "solana") {
              throw new Error(`Cannot broadcast Solana transaction on ${chain.key}`);
            }

            const connection = createSolanaConnection(chain);
            const txHash = await connection.sendRawTransaction(signedPayload);
            const submittedAt = new Date().toISOString();

            return {
              ...pending,
              status: "submitted" as const,
              updatedAt: submittedAt,
              resolution,
              txHash,
              submittedAt
            } satisfies WalletTransactionRecord;
          },
          catch: (error) => error instanceof Error ? error : new Error(String(error))
        });
      }
      default:
        return transitionTransactionRecord(pending, resolution);
    }
  }).pipe(
    Effect.catchAll((error) => {
      const at = new Date().toISOString();
      return Effect.succeed({
        ...pending,
        status: "failed",
        updatedAt: at,
        resolution,
        error: {
          message: error.message,
          at
        }
      } satisfies WalletTransactionRecord);
    })
  );

const refreshTrackedTransactions = (
  context: Pick<WalletAgentExecutionContext, "storage">
): Effect.Effect<ReadonlyArray<WalletTransactionRecord>, Error> =>
  Effect.gen(function* () {
    const transactions = yield* readTransactionLedger(context);
    const refreshed = yield* Effect.forEach(
      transactions,
      (transaction) => refreshTransactionRecord(context, transaction),
      {
        concurrency: 1
      }
    );

    return refreshed;
  });

const waitForTransactionConfirmation = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  transaction: WalletTransactionRecord
): Effect.Effect<WalletTransactionRecord, Error> => {
  if (transaction.status !== "submitted" || !transaction.txHash) {
    return Effect.succeed(transaction);
  }

  const timeoutMs = confirmationWaitTimeoutMs();
  if (timeoutMs <= 0) {
    return Effect.succeed(transaction);
  }

  const pollMs = confirmationPollIntervalMs();
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollMs));

  const poll = (
    current: WalletTransactionRecord,
    attemptsRemaining: number,
  ): Effect.Effect<WalletTransactionRecord, Error> => {
    if (current.status !== "submitted" || !current.txHash) {
      return Effect.succeed(current);
    }

    if (attemptsRemaining <= 0) {
      return Effect.succeed(current);
    }

    return refreshTransactionRecord(context, current).pipe(
      Effect.flatMap((next) => {
        if (next.status !== "submitted") {
          return Effect.succeed(next);
        }

        if (attemptsRemaining === 1) {
          return Effect.succeed(next);
        }

        return Effect.sleep(pollMs).pipe(
          Effect.flatMap(() => poll(next, attemptsRemaining - 1))
        );
      })
    );
  };

  return poll(transaction, maxAttempts);
};

const refreshTransactionRecord = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  transaction: WalletTransactionRecord
): Effect.Effect<WalletTransactionRecord, Error> => {
  if (transaction.status !== "submitted" || !transaction.txHash) {
    return Effect.succeed(transaction);
  }

  const txHash = transaction.txHash;
  const chain = resolveTransferChain(transaction.chain);
  if (!chain) {
    return Effect.succeed(transaction);
  }

  return Effect.gen(function* () {
    const next = yield* refreshSubmittedTransactionRecord(transaction, chain);

    yield* upsertTransactionRecord(context, next);
    return next;
  }).pipe(
    Effect.catchAll((error) =>
      /not found|receipt/i.test(error.message)
        ? Effect.succeed(transaction)
        : Effect.fail(error)
    )
  );
};

const emitTransactionActivity = (
  context: Pick<WalletAgentExecutionContext, "activity">,
  activityId: string,
  title: string,
  status: "running" | "succeeded" | "failed" | "awaiting_input"
): Effect.Effect<void> =>
  context.activity({
    activityId,
    title,
    status
  });

const emitSigningActivity = (
  context: Pick<WalletAgentExecutionContext, "activity">,
  activityId: string,
  title: string,
  status: "running" | "succeeded" | "failed" | "awaiting_input"
): Effect.Effect<void> =>
  emitTransactionActivity(context, activityId, title, status);

const emitTransactionResolutionActivity = (
  context: Pick<WalletAgentExecutionContext, "activity">,
  transaction: WalletTransactionRecord
): Effect.Effect<void> => {
  switch (transaction.status) {
    case "signed":
      return emitTransactionActivity(
        context,
        transaction.transactionId,
        `Transfer signed; awaiting broadcast for ${transferSummary(transaction)}`,
        "running"
      );
    case "rejected":
      return emitTransactionActivity(
        context,
        transaction.transactionId,
        `Transfer rejected for ${transferSummary(transaction)}`,
        "failed"
      );
    case "submitted":
      return emitTransactionActivity(
        context,
        transaction.transactionId,
        `Transaction submitted${transaction.txHash ? `: ${transaction.txHash}` : ""}`,
        "succeeded"
      );
    case "confirmed":
      return emitTransactionActivity(
        context,
        transaction.transactionId,
        `Transaction confirmed${transaction.txHash ? `: ${transaction.txHash}` : ""}`,
        "succeeded"
      );
    case "failed":
      return emitTransactionActivity(
        context,
        transaction.transactionId,
        `Transaction failed${transaction.error ? `: ${transaction.error.message}` : ""}`,
        "failed"
      );
    case "awaiting_signature":
      return emitTransactionActivity(
        context,
        transaction.transactionId,
        `Awaiting signature for ${transferSummary(transaction)}`,
        "awaiting_input"
      );
  }
};

const decodePendingTransfer = (value: unknown): PendingTransferRequest => {
  const record = asRecord(value);
  const chain = requireNonEmptyString(record.chain, "pending.chain");
  const assetSymbol = requireNonEmptyString(record.assetSymbol, "pending.assetSymbol");
  const chainFamily = resolveRequestedChainFamily({
    chain,
    assetSymbol,
    fromAddress: optionalTrimmedString(record.fromAddress),
    toAddress: optionalTrimmedString(record.toAddress)
  });
  const base = {
    transactionId: requireNonEmptyString(record.transactionId, "pending.transactionId"),
    requestId: requireNonEmptyString(record.requestId, "pending.requestId"),
    sessionId: requireNonEmptyString(record.sessionId, "pending.sessionId"),
    turnId: requireNonEmptyString(record.turnId, "pending.turnId"),
    requestedByClientId: requireNonEmptyString(record.requestedByClientId, "pending.requestedByClientId"),
    chain,
    assetSymbol,
    amount: requirePositiveDecimal(record.amount, "pending.amount"),
    fromAddress: requireWalletAddress(record.fromAddress, "pending.fromAddress", chainFamily),
    toAddress: requireWalletAddress(record.toAddress, "pending.toAddress", chainFamily),
    note: optionalTrimmedString(record.note),
    digest: requireNonEmptyString(record.digest, "pending.digest"),
    requestedAt: requireNonEmptyString(record.requestedAt, "pending.requestedAt"),
    eligibleDeviceIds: requireStringArray(record.eligibleDeviceIds, "pending.eligibleDeviceIds"),
    preview: asRecord(record.preview)
  } satisfies Omit<PendingTransferRequest, "signingRequest">;

  return {
    ...base,
    signingRequest:
      record.signingRequest === undefined
        ? createLegacyDigestSigningRequest(base)
        : decodeSigningRequest(record.signingRequest)
  };
};

const decodeTransactionLedger = (value: unknown): ReadonlyArray<WalletTransactionRecord> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    try {
      return [decodeTransactionRecord(entry)];
    } catch {
      return [];
    }
  });
};

const decodeTransactionRecord = (value: unknown): WalletTransactionRecord => {
  const record = asRecord(value);
  const status = requireTransactionStatus(record.status, "transaction.status");

  return {
    ...decodePendingTransfer(record),
    status,
    updatedAt: requireNonEmptyString(record.updatedAt, "transaction.updatedAt"),
    resolution: record.resolution === undefined ? undefined : decodeSigningResolution(record.resolution),
    txHash: optionalTrimmedString(record.txHash),
    submittedAt: optionalTrimmedString(record.submittedAt),
    confirmedAt: optionalTrimmedString(record.confirmedAt),
    blockNumber: optionalTrimmedString(record.blockNumber),
    error: record.error === undefined ? undefined : decodeTransactionError(record.error)
  };
};

const decodeTransferHistory = (value: unknown): ReadonlyArray<TransferHistoryEntry> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    try {
      return [decodeTransferHistoryEntry(entry)];
    } catch {
      return [];
    }
  });
};

const decodeTransferHistoryEntry = (value: unknown): TransferHistoryEntry => {
  const record = asRecord(value);
  return {
    ...decodePendingTransfer(record),
    resolution: decodeSigningResolution(record.resolution)
  };
};

const decodeTransactionError = (value: unknown): WalletTransactionError => {
  const record = asRecord(value);
  return {
    code: optionalTrimmedString(record.code),
    message: requireNonEmptyString(record.message, "transaction.error.message"),
    at: requireNonEmptyString(record.at, "transaction.error.at")
  };
};

const decodeSigningResolution = (value: unknown): SigningResolution => {
  const record = asRecord(value);
  const status = requireNonEmptyString(record.status, "resolution.status");

  if (status !== "approved" && status !== "rejected") {
    throw new Error(`Unsupported signing resolution status: ${status}`);
  }

  return {
    requestId: requireNonEmptyString(record.requestId, "resolution.requestId"),
    sessionId: requireNonEmptyString(record.sessionId, "resolution.sessionId"),
    deviceId: requireNonEmptyString(record.deviceId, "resolution.deviceId"),
    status,
    signature: optionalTrimmedString(record.signature),
    signatureEncoding: optionalSignatureEncoding(record.signatureEncoding),
    signedPayload: optionalTrimmedString(record.signedPayload),
    signedPayloadEncoding: optionalBinaryEncoding(record.signedPayloadEncoding),
    resolvedAt: requireNonEmptyString(record.resolvedAt, "resolution.resolvedAt")
  };
};

const decodeSigningRequest = (value: unknown): SigningRequest => {
  const record = asRecord(value);
  const kind = requireNonEmptyString(record.kind, "signingRequest.kind");
  const chain = requireNonEmptyString(record.chain, "signingRequest.chain");

  switch (kind) {
    case "digest":
      return {
        kind,
        requestId: requireNonEmptyString(record.requestId, "signingRequest.requestId"),
        sessionId: requireNonEmptyString(record.sessionId, "signingRequest.sessionId"),
        turnId: requireNonEmptyString(record.turnId, "signingRequest.turnId"),
        chain,
        address: requireWalletAddress(
          record.address,
          "signingRequest.address",
          resolveRequestedChainFamily({
            chain,
            assetSymbol: undefined,
            fromAddress: optionalTrimmedString(record.address),
            toAddress: undefined,
            algorithm: optionalTrimmedString(record.algorithm)
          })
        ),
        digest: requireNonEmptyString(record.digest, "signingRequest.digest"),
        digestEncoding: optionalBinaryEncoding(record.digestEncoding),
        algorithm: optionalTrimmedString(record.algorithm),
        preview: asRecord(record.preview),
        custody: "client-only-local",
        requestedAt: requireNonEmptyString(record.requestedAt, "signingRequest.requestedAt"),
        eligibleDeviceIds: requireStringArray(record.eligibleDeviceIds, "signingRequest.eligibleDeviceIds"),
        signatureEncoding: optionalSignatureEncoding(record.signatureEncoding)
      };
    case "evm.personal_message":
      return {
        kind,
        requestId: requireNonEmptyString(record.requestId, "signingRequest.requestId"),
        sessionId: requireNonEmptyString(record.sessionId, "signingRequest.sessionId"),
        turnId: requireNonEmptyString(record.turnId, "signingRequest.turnId"),
        chain,
        address: requireWalletAddress(record.address, "signingRequest.address", "evm"),
        chainId: requirePositiveInteger(record.chainId, "signingRequest.chainId"),
        message: requireNonEmptyString(record.message, "signingRequest.message"),
        messageEncoding: requireEvmMessageEncoding(record.messageEncoding, "signingRequest.messageEncoding"),
        preview: asRecord(record.preview),
        custody: "client-only-local",
        requestedAt: requireNonEmptyString(record.requestedAt, "signingRequest.requestedAt"),
        eligibleDeviceIds: requireStringArray(record.eligibleDeviceIds, "signingRequest.eligibleDeviceIds"),
        signatureEncoding: optionalSignatureEncoding(record.signatureEncoding)
      };
    case "evm.typed_data":
      return {
        kind,
        requestId: requireNonEmptyString(record.requestId, "signingRequest.requestId"),
        sessionId: requireNonEmptyString(record.sessionId, "signingRequest.sessionId"),
        turnId: requireNonEmptyString(record.turnId, "signingRequest.turnId"),
        chain,
        address: requireWalletAddress(record.address, "signingRequest.address", "evm"),
        chainId: requirePositiveInteger(record.chainId, "signingRequest.chainId"),
        typedData: asRecord(record.typedData),
        preview: asRecord(record.preview),
        custody: "client-only-local",
        requestedAt: requireNonEmptyString(record.requestedAt, "signingRequest.requestedAt"),
        eligibleDeviceIds: requireStringArray(record.eligibleDeviceIds, "signingRequest.eligibleDeviceIds"),
        signatureEncoding: optionalSignatureEncoding(record.signatureEncoding)
      };
    case "evm.transaction":
      return {
        kind,
        requestId: requireNonEmptyString(record.requestId, "signingRequest.requestId"),
        sessionId: requireNonEmptyString(record.sessionId, "signingRequest.sessionId"),
        turnId: requireNonEmptyString(record.turnId, "signingRequest.turnId"),
        chain,
        address: requireWalletAddress(record.address, "signingRequest.address", "evm"),
        chainId: requirePositiveInteger(record.chainId, "signingRequest.chainId"),
        transaction: asRecord(record.transaction),
        preview: asRecord(record.preview),
        custody: "client-only-local",
        requestedAt: requireNonEmptyString(record.requestedAt, "signingRequest.requestedAt"),
        eligibleDeviceIds: requireStringArray(record.eligibleDeviceIds, "signingRequest.eligibleDeviceIds"),
        signatureEncoding: optionalSignatureEncoding(record.signatureEncoding)
      };
    case "solana.message":
      return {
        kind,
        requestId: requireNonEmptyString(record.requestId, "signingRequest.requestId"),
        sessionId: requireNonEmptyString(record.sessionId, "signingRequest.sessionId"),
        turnId: requireNonEmptyString(record.turnId, "signingRequest.turnId"),
        chain,
        address: requireWalletAddress(record.address, "signingRequest.address", "solana"),
        message: requireNonEmptyString(record.message, "signingRequest.message"),
        messageEncoding: requireMessageEncoding(record.messageEncoding, "signingRequest.messageEncoding"),
        preview: asRecord(record.preview),
        custody: "client-only-local",
        requestedAt: requireNonEmptyString(record.requestedAt, "signingRequest.requestedAt"),
        eligibleDeviceIds: requireStringArray(record.eligibleDeviceIds, "signingRequest.eligibleDeviceIds"),
        signatureEncoding: optionalSignatureEncoding(record.signatureEncoding)
      };
    case "solana.transaction":
      return {
        kind,
        requestId: requireNonEmptyString(record.requestId, "signingRequest.requestId"),
        sessionId: requireNonEmptyString(record.sessionId, "signingRequest.sessionId"),
        turnId: requireNonEmptyString(record.turnId, "signingRequest.turnId"),
        chain,
        address: requireWalletAddress(record.address, "signingRequest.address", "solana"),
        version: requireSolanaTransactionVersion(record.version, "signingRequest.version"),
        transaction: requireNonEmptyString(record.transaction, "signingRequest.transaction"),
        transactionEncoding: requireSolanaTransactionEncoding(
          record.transactionEncoding,
          "signingRequest.transactionEncoding"
        ),
        preview: asRecord(record.preview),
        custody: "client-only-local",
        requestedAt: requireNonEmptyString(record.requestedAt, "signingRequest.requestedAt"),
        eligibleDeviceIds: requireStringArray(record.eligibleDeviceIds, "signingRequest.eligibleDeviceIds"),
        signatureEncoding: optionalSignatureEncoding(record.signatureEncoding)
      };
    default:
      throw new Error(`Unsupported signing request kind: ${kind}`);
  }
};

type TransferStatusQuery =
  | { readonly kind: "latest" }
  | { readonly kind: "recent" }
  | { readonly kind: "lookup"; readonly id: string };

type WalletAccountQuery =
  | {
      readonly kind: "default";
      readonly chainFamily?: WalletChainFamily;
      readonly chain?: string;
    }
  | {
      readonly kind: "list";
      readonly chainFamily?: WalletChainFamily;
      readonly chain?: string;
    };

function decodeTransferStatusToolInput(input: unknown): TransferStatusQuery {
  const record = asRecord(input);
  const kind = requireTransferStatusKind(record.kind);

  if (kind === "lookup") {
    return {
      kind,
      id: requireNonEmptyString(record.id, "id")
    };
  }

  return { kind };
}

function decodeWalletAccountToolInput(input: unknown): WalletAccountQuery {
  const record = asRecord(input);
  return {
    kind: requireWalletAccountQueryKind(record.kind),
    chainFamily: optionalWalletChainFamily(record.chainFamily),
    chain: optionalTrimmedString(record.chain)
  };
}

const answerWalletAccountQuery = (
  context: Pick<WalletAgentExecutionContext, "wallet">,
  query: WalletAccountQuery
): Effect.Effect<WalletAccountsResultOutput, Error> =>
  Effect.gen(function* () {
    const accounts = yield* context.wallet.listAccounts({
      chainFamily: query.chainFamily,
      chain: query.chain
    });
    const accountViews = accounts.map(toWalletAccountView);

    if (accounts.length === 0) {
      return {
        kind: "wallet.accounts_result",
        query,
        status: "not_found",
        accounts: []
      };
    }

    if (query.kind === "list") {
      return {
        kind: "wallet.accounts_result",
        query,
        status: "ok",
        accounts: accountViews
      };
    }

    if (query.chainFamily) {
      const resolved = yield* Effect.either(context.wallet.resolveAccount({
        chainFamily: query.chainFamily,
        chain: query.chain
      }));

      if (resolved._tag === "Right") {
        return {
          kind: "wallet.accounts_result",
          query,
          status: "ok",
          accounts: accountViews,
          defaultAccount: toWalletAccountView(resolved.right)
        };
      }

      return {
        kind: "wallet.accounts_result",
        query,
        status: "ambiguous",
        accounts: accountViews
      };
    }

    const representatives = representativeWalletAccounts(accounts);
    if (representatives) {
      if (representatives.length === 1) {
        return {
          kind: "wallet.accounts_result",
          query,
          status: "ok",
          accounts: accountViews,
          defaultAccount: toWalletAccountView(representatives[0])
        };
      }

      return {
        kind: "wallet.accounts_result",
        query,
        status: "ambiguous",
        accounts: representatives.map(toWalletAccountView)
      };
    }

    return {
      kind: "wallet.accounts_result",
      query,
      status: "ambiguous",
      accounts: accountViews
    };
  });

const renderNoWalletAccountMessage = (query: WalletAccountQuery): string =>
  query.chainFamily
    ? `No ${describeChainFamily(query.chainFamily)} wallet is connected yet. Create or import a wallet on this device, or connect another wallet-capable client, and I'll be able to resolve it automatically.`
    : "No wallet is connected yet. Create or import a wallet on this device, or connect another wallet-capable client, and I'll be able to resolve it automatically.";

const renderDefaultWalletAccountMessage = (
  account: WalletAccountCandidate,
  query: WalletAccountQuery
): string => {
  if (query.chainFamily) {
    return `Your ${describeWalletAccountScope(query)} address is ${account.address}.`;
  }

  return `Your wallet address is ${account.address}.`;
};

const renderWalletAccountList = (
  accounts: ReadonlyArray<WalletAccountCandidate>,
  options: {
    readonly intro: string;
  }
): string =>
  [
    options.intro,
    ...accounts.map((account, index) => `${index + 1}. ${describeWalletAccount(account)}`)
  ].join("\n");

const walletAccountListIntro = (query: WalletAccountQuery): string =>
  query.chainFamily
    ? `${describeWalletAccountScope(query)} accounts:`
    : "Connected wallet accounts:";

const describeWalletAccountScope = (
  query: Pick<WalletAccountQuery, "chainFamily" | "chain">
): string => {
  if (query.chain) {
    return query.chain;
  }

  if (query.chainFamily) {
    return describeChainFamily(query.chainFamily);
  }

  return "wallet";
};

const describeWalletAccount = (account: WalletAccountCandidate): string => {
  const parts = [
    describeChainFamily(account.chainFamily),
    account.isDefault === true ? "default" : undefined,
    account.label ? `(${account.label})` : undefined,
    account.address
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  return parts.join(" ");
};

const representativeWalletAccounts = (
  accounts: ReadonlyArray<WalletAccountCandidate>
): ReadonlyArray<WalletAccountCandidate> | undefined => {
  const families = new Map<WalletChainFamily, ReadonlyArray<WalletAccountCandidate>>();

  for (const account of accounts) {
    const current = families.get(account.chainFamily) ?? [];
    families.set(account.chainFamily, [...current, account]);
  }

  const representatives: WalletAccountCandidate[] = [];
  for (const familyAccounts of families.values()) {
    const defaults = familyAccounts.filter((account) => account.isDefault === true);
    if (defaults.length === 1) {
      representatives.push(defaults[0]);
      continue;
    }

    if (familyAccounts.length === 1) {
      representatives.push(familyAccounts[0]);
      continue;
    }

    return undefined;
  }

  return representatives;
};

const manageWalletContacts = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  input: ManageContactsInput
): Effect.Effect<WalletContactsResultOutput, Error> =>
  input.operation === "add"
    ? addWalletContact(context, input)
    : updateWalletContact(context, input);

const addWalletContact = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  input: Extract<ManageContactsInput, { readonly operation: "add" }>
): Effect.Effect<WalletContactsResultOutput, Error> =>
  Effect.gen(function* () {
    const contacts = yield* readWalletContacts(context);
    const resolvedScope = resolveWalletContactScope({
      address: input.address,
      chainFamily: input.chainFamily,
      chain: input.chain
    });
    const contact: WalletContactRecord = {
      name: input.name,
      address: requireWalletAddress(input.address, "address", resolvedScope.chainFamily),
      chainFamily: resolvedScope.chainFamily,
      chain: resolvedScope.chain,
      note: input.note,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const duplicate = contacts.find((candidate) =>
      walletContactIdentity(candidate) === walletContactIdentity(contact)
    );
    if (duplicate) {
      return yield* Effect.fail(
        new Error(
          `A saved contact named ${JSON.stringify(input.name)} already exists for ${describeWalletContactScope(duplicate)}. Use update instead.`
        )
      );
    }

    yield* writeWalletContacts(context, [...contacts, contact]);
    return {
      kind: "wallet.contacts_result",
      operation: "add",
      status: "created",
      contact: toWalletContactView(contact)
    };
  });

const updateWalletContact = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  input: Extract<ManageContactsInput, { readonly operation: "update" }>
): Effect.Effect<WalletContactsResultOutput, Error> =>
  Effect.gen(function* () {
    const contacts = yield* readWalletContacts(context);
    const matches = findWalletContactsByName(contacts, input.targetName, {
      chainFamily: input.targetChainFamily,
      chain: input.targetChain
    });

    if (matches.length === 0) {
      return yield* Effect.fail(
        new Error(renderMissingWalletContactMessage(input.targetName, {
          chainFamily: input.targetChainFamily,
          chain: input.targetChain
        }))
      );
    }

    if (matches.length > 1) {
      return yield* Effect.fail(
        new Error(renderAmbiguousWalletContactMessage(input.targetName, matches.map(({ contact }) => contact)))
      );
    }

    const match = matches[0];
    const current = match.contact;
    const nextScope = resolveWalletContactScope({
      address: input.address ?? current.address,
      chainFamily: input.chainFamily ?? current.chainFamily,
      chain: input.chain ?? current.chain
    });
    const next: WalletContactRecord = {
      name: input.name ?? current.name,
      address: input.address
        ? requireWalletAddress(input.address, "address", nextScope.chainFamily)
        : current.address,
      chainFamily: nextScope.chainFamily,
      chain: nextScope.chain,
      note: input.note ?? current.note,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    };

    const duplicate = contacts.find((candidate, index) =>
      index !== match.index && walletContactIdentity(candidate) === walletContactIdentity(next)
    );
    if (duplicate) {
      return yield* Effect.fail(
        new Error(
          `Updating ${JSON.stringify(current.name)} would collide with existing contact ${describeWalletContactEntry(duplicate)}.`
        )
      );
    }

    if (stableJson(current) === stableJson(next)) {
      return {
        kind: "wallet.contacts_result",
        operation: "update",
        status: "unchanged",
        contact: toWalletContactView(current)
      };
    }

    const updated = contacts.map((candidate, index) =>
      index === match.index ? next : candidate
    );
    yield* writeWalletContacts(context, updated);
    return {
      kind: "wallet.contacts_result",
      operation: "update",
      status: "updated",
      contact: toWalletContactView(next)
    };
  });

const answerContactQuery = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  query: GetContactsQuery
): Effect.Effect<WalletContactsResultOutput, Error> =>
  Effect.gen(function* () {
    const contacts = sortWalletContacts(
      filterWalletContactsByScope(
        yield* readWalletContacts(context),
        {
          chainFamily: query.chainFamily,
          chain: query.chain
        }
      )
    );

    if (query.kind === "list") {
      return {
        kind: "wallet.contacts_result",
        operation: "list",
        status: "ok",
        contacts: contacts.map(toWalletContactView),
        chainFamily: query.chainFamily,
        chain: query.chain
      };
    }

    const matches = contacts.filter((contact) => walletContactNameMatches(contact, query.name));
    if (matches.length === 0) {
      return {
        kind: "wallet.contacts_result",
        operation: "lookup",
        status: "not_found",
        contacts: [],
        name: query.name,
        chainFamily: query.chainFamily,
        chain: query.chain
      };
    }

    if (matches.length === 1) {
      return {
        kind: "wallet.contacts_result",
        operation: "lookup",
        status: "ok",
        contact: toWalletContactView(matches[0]),
        contacts: matches.map(toWalletContactView),
        name: query.name,
        chainFamily: query.chainFamily,
        chain: query.chain
      };
    }

    return {
      kind: "wallet.contacts_result",
      operation: "lookup",
      status: "ambiguous",
      contacts: matches.map(toWalletContactView),
      name: query.name,
      chainFamily: query.chainFamily,
      chain: query.chain
    };
  });

const resolveSavedContactRecipient = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  recipientName: string,
  scope: {
    readonly chainFamily: WalletChainFamily;
    readonly chain: string;
  }
): Effect.Effect<{
  readonly toAddress: string;
  readonly recipientName: string;
}, Error> =>
  Effect.gen(function* () {
    const contacts = yield* readWalletContacts(context);
    const byName = contacts.filter((contact) => walletContactNameMatches(contact, recipientName));
    if (byName.length === 0) {
      return yield* Effect.fail(
        new Error(renderMissingWalletContactMessage(recipientName, scope))
      );
    }

    const normalizedChain = normalizeWalletContactChain(scope.chain);
    const exactChainMatches = byName.filter((contact) =>
      contact.chainFamily === scope.chainFamily
      && contact.chain !== undefined
      && normalizeWalletContactChain(contact.chain) === normalizedChain
    );
    if (exactChainMatches.length === 1) {
      const contact = exactChainMatches[0];
      return {
        toAddress: contact.address,
        recipientName: contact.name
      };
    }

    if (exactChainMatches.length > 1) {
      return yield* Effect.fail(
        new Error(renderAmbiguousWalletContactMessage(recipientName, exactChainMatches))
      );
    }

    const familyMatches = byName.filter((contact) =>
      contact.chainFamily === scope.chainFamily && contact.chain === undefined
    );
    if (familyMatches.length === 1) {
      const contact = familyMatches[0];
      return {
        toAddress: contact.address,
        recipientName: contact.name
      };
    }

    if (familyMatches.length > 1) {
      return yield* Effect.fail(
        new Error(renderAmbiguousWalletContactMessage(recipientName, familyMatches))
      );
    }

    const compatible = byName.filter((contact) => contact.chainFamily === scope.chainFamily);
    if (compatible.length > 0) {
      return yield* Effect.fail(
        new Error(
          `I found saved contact ${JSON.stringify(recipientName)}, but not for ${scope.chain}. Matching contacts:\n${renderWalletContactItems(compatible)}`
        )
      );
    }

    return yield* Effect.fail(
      new Error(renderMissingWalletContactMessage(recipientName, scope))
    );
  });

const readWalletContacts = (
  context: Pick<WalletAgentExecutionContext, "storage">
): Effect.Effect<ReadonlyArray<WalletContactRecord>, Error> =>
  context.storage.getJson({
    scope: "install",
    key: WalletContactsStorageKey
  }).pipe(
    Effect.map((value) => decodeWalletContacts(value))
  );

const writeWalletContacts = (
  context: Pick<WalletAgentExecutionContext, "storage">,
  contacts: ReadonlyArray<WalletContactRecord>
): Effect.Effect<void, Error> =>
  context.storage.putJson({
    scope: "install",
    key: WalletContactsStorageKey,
    value: sortWalletContacts(contacts)
  });

const decodeWalletContacts = (value: unknown): ReadonlyArray<WalletContactRecord> => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    try {
      return [decodeWalletContact(entry)];
    } catch {
      return [];
    }
  });
};

const decodeWalletContact = (value: unknown): WalletContactRecord => {
  const record = asRecord(value);
  const name = requireNonEmptyString(record.name, "contact.name");
  const chainFamily = optionalWalletChainFamily(record.chainFamily)
    ?? resolveWalletContactScope({
      address: optionalTrimmedString(record.address),
      chain: optionalTrimmedString(record.chain)
    }).chainFamily;
  return {
    name,
    address: requireWalletAddress(record.address, "contact.address", chainFamily),
    chainFamily,
    chain: optionalTrimmedString(record.chain),
    note: optionalTrimmedString(record.note),
    createdAt: requireNonEmptyString(record.createdAt, "contact.createdAt"),
    updatedAt: requireNonEmptyString(record.updatedAt, "contact.updatedAt")
  };
};

const findWalletContactsByName = (
  contacts: ReadonlyArray<WalletContactRecord>,
  name: string,
  scope: {
    readonly chainFamily?: WalletChainFamily;
    readonly chain?: string;
  } = {}
): ReadonlyArray<{
  readonly contact: WalletContactRecord;
  readonly index: number;
}> => {
  const normalizedChain = scope.chain ? normalizeWalletContactChain(scope.chain) : undefined;

  return contacts.flatMap((contact, index) => {
    if (!walletContactNameMatches(contact, name)) {
      return [];
    }

    if (scope.chainFamily && contact.chainFamily !== scope.chainFamily) {
      return [];
    }

    if (normalizedChain && normalizeWalletContactChain(contact.chain) !== normalizedChain) {
      return [];
    }

    return [{
      contact,
      index
    }];
  });
};

const filterWalletContactsByScope = (
  contacts: ReadonlyArray<WalletContactRecord>,
  scope: {
    readonly chainFamily?: WalletChainFamily;
    readonly chain?: string;
  }
): ReadonlyArray<WalletContactRecord> => {
  const normalizedChain = scope.chain ? normalizeWalletContactChain(scope.chain) : undefined;
  return contacts.filter((contact) => {
    if (scope.chainFamily && contact.chainFamily !== scope.chainFamily) {
      return false;
    }

    if (normalizedChain && normalizeWalletContactChain(contact.chain) !== normalizedChain) {
      return false;
    }

    return true;
  });
};

const sortWalletContacts = (
  contacts: ReadonlyArray<WalletContactRecord>
): ReadonlyArray<WalletContactRecord> =>
  [...contacts].sort((left, right) =>
    walletContactSortKey(left).localeCompare(walletContactSortKey(right))
  );

const renderNoWalletContactsMessage = (
  scope: {
    readonly chainFamily?: WalletChainFamily;
    readonly chain?: string;
  }
): string => {
  if (scope.chain) {
    return `No saved contacts found for ${scope.chain}.`;
  }

  if (scope.chainFamily) {
    return `No saved ${describeChainFamily(scope.chainFamily)} contacts found.`;
  }

  return "No saved contacts yet.";
};

const renderMissingWalletContactMessage = (
  name: string,
  scope: {
    readonly chainFamily?: WalletChainFamily;
    readonly chain?: string;
  }
): string => {
  if (scope.chain) {
    return `No saved contact named ${JSON.stringify(name)} matched ${scope.chain}.`;
  }

  if (scope.chainFamily) {
    return `No saved ${describeChainFamily(scope.chainFamily)} contact named ${JSON.stringify(name)} was found.`;
  }

  return `No saved contact named ${JSON.stringify(name)} was found.`;
};

const renderAmbiguousWalletContactMessage = (
  name: string,
  contacts: ReadonlyArray<WalletContactRecord>
): string =>
  [
    `Saved contact name ${JSON.stringify(name)} is ambiguous.`,
    renderWalletContactItems(sortWalletContacts(contacts))
  ].join("\n");

const renderWalletContactList = (
  contacts: ReadonlyArray<WalletContactRecord>,
  intro: string
): string =>
  [
    intro,
    renderWalletContactItems(contacts)
  ].join("\n");

const renderWalletContactItems = (
  contacts: ReadonlyArray<WalletContactRecord>
): string =>
  contacts.map((contact, index) => `${index + 1}. ${describeWalletContactEntry(contact)}`).join("\n");

const describeWalletContactEntry = (contact: WalletContactRecord): string => {
  const detail = [
    contact.name,
    `on ${describeWalletContactScope(contact)}:`,
    contact.address,
    contact.note ? `(${contact.note})` : undefined
  ].filter((part): part is string => typeof part === "string");

  return detail.join(" ");
};

const describeWalletContactScope = (
  contact: Pick<WalletContactRecord, "chainFamily" | "chain">
): string =>
  contact.chain ?? describeChainFamily(contact.chainFamily);

const walletContactIdentity = (
  contact: Pick<WalletContactRecord, "name" | "chainFamily" | "chain">
): string =>
  `${normalizeWalletContactName(contact.name)}|${contact.chain ? `chain:${normalizeWalletContactChain(contact.chain)}` : `family:${contact.chainFamily}`}`;

const walletContactSortKey = (
  contact: Pick<WalletContactRecord, "name" | "chainFamily" | "chain" | "address">
): string =>
  [
    normalizeWalletContactName(contact.name),
    contact.chain ? normalizeWalletContactChain(contact.chain) : contact.chainFamily,
    contact.address.toLowerCase()
  ].join("|");

const walletContactNameMatches = (
  contact: Pick<WalletContactRecord, "name">,
  name: string
): boolean =>
  normalizeWalletContactName(contact.name) === normalizeWalletContactName(name);

const normalizeWalletContactName = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

const normalizeWalletContactChain = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const resolved = resolveTransferChain(normalized);
  return resolved?.key ?? normalized;
};

const resolveWalletContactScope = (input: {
  readonly address?: string;
  readonly chainFamily?: WalletChainFamily;
  readonly chain?: string;
}): {
  readonly chainFamily: WalletChainFamily;
  readonly chain?: string;
} => {
  const addressFamily = input.address ? inferChainFamilyFromAddress(input.address) : undefined;
  const chainFamily =
    input.chainFamily
    ?? addressFamily
    ?? (input.chain ? inferChainFamilyFromName(input.chain) : undefined);

  if (!chainFamily) {
    throw new Error("Contact chainFamily could not be inferred from the address or chain");
  }

  if (input.chainFamily && addressFamily && input.chainFamily !== addressFamily) {
    throw new Error(`Contact chainFamily ${input.chainFamily} does not match address ${input.address}`);
  }

  if (input.chain && inferChainFamilyFromName(input.chain) !== chainFamily) {
    throw new Error(`Contact chain ${input.chain} does not match chain family ${chainFamily}`);
  }

  return {
    chainFamily,
    chain: normalizeWalletContactChain(input.chain)
  };
};

const createTransferStatusResultOutput = (
  query: TransferStatusQuery,
  transactions: ReadonlyArray<WalletTransactionRecord>
): WalletTransferStatusResultOutput => {
  const ordered = [...transactions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );

  switch (query.kind) {
    case "latest": {
      const latest = ordered[0];
      return {
        kind: "wallet.transfer_status_result",
        query,
        found: latest !== undefined,
        transfer: latest ? toWalletTransferView(latest) : undefined,
        totalTransfers: ordered.length
      };
    }
    case "recent":
      return {
        kind: "wallet.transfer_status_result",
        query,
        found: ordered.length > 0,
        transfers: ordered.slice(0, 5).map(toWalletTransferView),
        totalTransfers: ordered.length
      };
    case "lookup": {
      const match = ordered.find((transaction) =>
        transaction.transactionId === query.id ||
        transaction.requestId === query.id ||
        transaction.txHash === query.id
      );
      return {
        kind: "wallet.transfer_status_result",
        query,
        found: match !== undefined,
        transfer: match ? toWalletTransferView(match) : undefined,
        totalTransfers: ordered.length
      };
    }
  }
};

const describeTransactionStatus = (
  transaction: WalletTransactionRecord
): string => {
  switch (transaction.status) {
    case "awaiting_signature":
      return `awaiting signature approval for ${transferSummary(transaction)}`;
    case "signed":
      return [
        `signed for ${transferSummary(transaction)}`,
        transaction.resolution ? `by ${transaction.resolution.deviceId}` : undefined,
        "and awaiting host-side broadcast"
      ].filter((part): part is string => typeof part === "string").join(" ");
    case "rejected":
      return [
        `rejected for ${transferSummary(transaction)}`,
        transaction.resolution ? `by ${transaction.resolution.deviceId}` : undefined
      ].filter((part): part is string => typeof part === "string").join(" ");
    case "submitted":
      return [
        `submitted for ${transferSummary(transaction)}`,
        transaction.txHash ? `with ${transactionReferenceNoun(transaction.chain)} ${transaction.txHash}` : undefined,
        "and awaiting on-chain confirmation"
      ].filter((part): part is string => typeof part === "string").join(" ");
    case "confirmed":
      return [
        `confirmed for ${transferSummary(transaction)}`,
        transaction.txHash ? `with ${transactionReferenceNoun(transaction.chain)} ${transaction.txHash}` : undefined,
        transaction.blockNumber ? ledgerPositionDescription(transaction) : undefined
      ].filter((part): part is string => typeof part === "string").join(" ");
    case "failed":
      return [
        `failed for ${transferSummary(transaction)}`,
        transaction.error ? `because ${transaction.error.message}` : undefined
      ].filter((part): part is string => typeof part === "string").join(" ");
  }
};

const resolveEvmSigningChain = (
  chain: string | undefined,
  chainId: number | undefined
): {
  readonly name: string;
  readonly chainId: number;
} => {
  if (chain) {
    const resolved = resolveTransferChain(chain);
    if (resolved?.chainFamily === "evm") {
      return {
        name: resolved.key,
        chainId: resolved.chain.id
      };
    }

    if (!resolved) {
      return {
        name: chain,
        chainId: chainId ?? defaultChainIdForChainName(chain)
      };
    }
  }

  if (chainId !== undefined) {
    return {
      name: defaultChainNameForChainId(chainId),
      chainId
    };
  }

  return {
    name: "ethereum",
    chainId: 1
  };
};

const defaultChainNameForChainId = (chainId: number): string => {
  switch (chainId) {
    case 1:
      return "ethereum";
    case 11155111:
      return "sepolia";
    case 137:
      return "polygon";
    default:
      return `eip155:${chainId}`;
  }
};

const defaultChainIdForChainName = (chain: string): number => {
  switch (chain.trim().toLowerCase()) {
    case "ethereum":
    case "mainnet":
    case "eth":
      return 1;
    case "sepolia":
      return 11155111;
    case "polygon":
    case "matic":
    case "pol":
      return 137;
    default:
      throw new Error(`EVM chain ${chain} requires an explicit chainId`);
  }
};

const broadcastDisabled = (): boolean =>
  process.env.WALLET_AGENT_DISABLE_BROADCAST?.trim() === "1";

const resolveTransferChain = (chain: string): TransferChainConfig | undefined => {
  const normalized = chain.trim().toLowerCase();
  return TransferChains.find((candidate) => candidate.aliases.includes(normalized));
};

const createEvmClient = (chain: EvmChainConfig) =>
  createPublicClient({
    chain: chain.chain,
    transport: http(resolveTransferRpcUrl(chain))
  });

const createSolanaConnection = (chain: SolanaChainConfig): SolanaConnection =>
  new SolanaConnection(resolveTransferRpcUrl(chain), "confirmed");

const confirmationWaitTimeoutMs = (): number =>
  parseOptionalNonNegativeIntegerEnv(
    process.env.WALLET_AGENT_CONFIRMATION_WAIT_TIMEOUT_MS,
    DefaultConfirmationWaitTimeoutMs
  );

const confirmationPollIntervalMs = (): number =>
  Math.max(1, parseOptionalNonNegativeIntegerEnv(
    process.env.WALLET_AGENT_CONFIRMATION_POLL_INTERVAL_MS,
    DefaultConfirmationPollIntervalMs
  ));

const parseOptionalNonNegativeIntegerEnv = (
  value: string | undefined,
  fallback: number
): number => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }

  if (!/^\d+$/.test(trimmed)) {
    return fallback;
  }

  return Number.parseInt(trimmed, 10);
};

const resolveTransferRpcUrl = (chain: TransferChainConfig): string => {
  const override = process.env[chain.rpcUrlEnv]?.trim();
  if (override) {
    return override;
  }

  if (chain.chainFamily === "solana" && !process.env.WALLET_AGENT_ALCHEMY_API_KEY?.trim() && !DefaultPublicAlchemyApiKey) {
    return clusterApiUrl(chain.cluster);
  }

  const apiKey = process.env.WALLET_AGENT_ALCHEMY_API_KEY?.trim() || DefaultPublicAlchemyApiKey;
  return chain.url(apiKey);
};

const refreshSubmittedTransactionRecord = (
  transaction: WalletTransactionRecord,
  chain: TransferChainConfig
): Effect.Effect<WalletTransactionRecord, Error> =>
  chain.chainFamily === "evm"
    ? refreshSubmittedEvmTransactionRecord(transaction, chain)
    : refreshSubmittedSolanaTransactionRecord(transaction, chain);

const refreshSubmittedEvmTransactionRecord = (
  transaction: WalletTransactionRecord,
  chain: EvmChainConfig
): Effect.Effect<WalletTransactionRecord, Error> =>
  Effect.tryPromise({
    try: async () => {
      const client = createEvmClient(chain);
      const receipt = await client.getTransactionReceipt({
        hash: normalizeHex(transaction.txHash ?? "", "transaction.txHash")
      });
      const updatedAt = new Date().toISOString();

      return receipt.status === "success"
        ? {
            ...transaction,
            status: "confirmed" as const,
            updatedAt,
            confirmedAt: updatedAt,
            blockNumber: receipt.blockNumber.toString()
          }
        : {
            ...transaction,
            status: "failed" as const,
            updatedAt,
            blockNumber: receipt.blockNumber.toString(),
            error: {
              message: "Transaction reverted on-chain",
              at: updatedAt
            }
          };
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error))
  });

const refreshSubmittedSolanaTransactionRecord = (
  transaction: WalletTransactionRecord,
  chain: SolanaChainConfig
): Effect.Effect<WalletTransactionRecord, Error> =>
  Effect.tryPromise({
    try: async () => {
      const connection = createSolanaConnection(chain);
      const response = await connection.getSignatureStatuses(
        [transaction.txHash ?? ""],
        { searchTransactionHistory: true }
      );
      const status = response.value[0];
      if (!status) {
        return transaction;
      }

      const updatedAt = new Date().toISOString();
      if (status.err) {
        return {
          ...transaction,
          status: "failed" as const,
          updatedAt,
          blockNumber: status.slot.toString(),
          error: {
            message: `Transaction failed on-chain: ${JSON.stringify(status.err)}`,
            at: updatedAt
          }
        };
      }

      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized" ||
        status.confirmations === null
      ) {
        return {
          ...transaction,
          status: "confirmed" as const,
          updatedAt,
          confirmedAt: updatedAt,
          blockNumber: status.slot.toString()
        };
      }

      return transaction;
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error))
  });

const normalizeSignedPayloadHex = (
  payload: string | undefined,
  encoding: "hex" | "base64" | undefined
): Hex | undefined => {
  if (!payload) {
    return undefined;
  }

  if (encoding === undefined || encoding === "hex") {
    return normalizeHex(payload, "signedPayload");
  }

  return `0x${Buffer.from(payload, "base64").toString("hex")}`;
};

const normalizeSignedPayloadBytes = (
  payload: string | undefined,
  encoding: "hex" | "base64" | undefined
): Uint8Array | undefined => {
  if (!payload) {
    return undefined;
  }

  switch (encoding ?? "base64") {
    case "base64":
      return base64.decode(payload);
    case "hex":
      return hexToBytes(normalizeHex(payload, "signedPayload"));
  }
};

const inferChainFamilyFromName = (chain: string): WalletChainFamily =>
  resolveTransferChain(chain)?.chainFamily ?? (
    chain.trim().toLowerCase().includes("sol")
      ? "solana"
      : "evm"
  );

const inferChainFamilyFromAddress = (address: string): WalletChainFamily | undefined => {
  if (EvmAddressPattern.test(address)) {
    return "evm";
  }

  if (SolanaAddressPattern.test(address)) {
    try {
      new PublicKey(address);
      return "solana";
    } catch {
      return undefined;
    }
  }

  return undefined;
};

const typedDataChainId = (typedData: Readonly<Record<string, unknown>>): number | undefined => {
  const domain = typedData.domain;
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
    return undefined;
  }

  return optionalPositiveInteger((domain as Record<string, unknown>).chainId);
};

const optionalRecordString = (value: unknown, field: string): string | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return optionalTrimmedString((value as Record<string, unknown>)[field]);
};

const previewMessage = (
  message: string,
  encoding: "utf8" | "hex" | "base64"
): string =>
  encoding === "utf8"
    ? ellipsize(message, 120)
    : ellipsize(message, 96);

const bigintishPreview = (value: unknown): string | undefined => {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }

  return optionalTrimmedString(value);
};

const ellipsize = (value: string, maxLength: number): string =>
  value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;

const resolveRequestedChainFamily = (input: {
  readonly chain?: string;
  readonly assetSymbol?: string;
  readonly fromAddress?: string;
  readonly toAddress?: string;
  readonly algorithm?: string;
}): WalletChainFamily => {
  if (input.algorithm === "ed25519") {
    return "solana";
  }

  if (input.algorithm === "secp256k1") {
    return "evm";
  }

  const fromAddressFamily = input.fromAddress ? inferChainFamilyFromAddress(input.fromAddress) : undefined;
  const toAddressFamily = input.toAddress ? inferChainFamilyFromAddress(input.toAddress) : undefined;
  const assetFamily = input.assetSymbol?.trim().toUpperCase() === "SOL"
    ? "solana"
    : undefined;

  return (
    (input.chain ? inferChainFamilyFromName(input.chain) : undefined)
    ?? assetFamily
    ?? fromAddressFamily
    ?? toAddressFamily
    ?? "evm"
  );
};

const defaultChainForFamily = (chainFamily: WalletChainFamily): string =>
  chainFamily === "solana"
    ? "solana"
    : "ethereum";

const defaultAssetSymbolForFamily = (chainFamily: WalletChainFamily): string =>
  chainFamily === "solana"
    ? "SOL"
    : "ETH";

const describeChainFamily = (chainFamily: WalletChainFamily): string =>
  chainFamily === "solana"
    ? "Solana"
    : "EVM";

const transactionReferenceNoun = (chain: string): string =>
  inferChainFamilyFromName(chain) === "solana"
    ? "signature"
    : "hash";

const ledgerPositionDescription = (
  transaction: Pick<WalletTransactionRecord, "chain" | "blockNumber">
): string | undefined => {
  if (!transaction.blockNumber) {
    return undefined;
  }

  return inferChainFamilyFromName(transaction.chain) === "solana"
    ? `in slot ${transaction.blockNumber}`
    : `in block ${transaction.blockNumber}`;
};

const ledgerPositionSummary = (
  transaction: Pick<WalletTransactionRecord, "chain" | "blockNumber">
): string | undefined => {
  if (!transaction.blockNumber) {
    return undefined;
  }

  return inferChainFamilyFromName(transaction.chain) === "solana"
    ? `Slot ${transaction.blockNumber}.`
    : `Block ${transaction.blockNumber}.`;
};

const parseSolToLamports = (value: string, field: string): bigint => {
  const normalized = requirePositiveDecimal(value, field);
  const [wholePart, fractionalPart = ""] = normalized.split(".");
  if (fractionalPart.length > 9) {
    throw new Error(`${field} cannot use more than 9 decimal places for SOL`);
  }

  return (
    BigInt(wholePart) * SolanaLamportsPerSol
    + BigInt(fractionalPart.padEnd(9, "0"))
  );
};

const bigIntToNumber = (value: bigint, field: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds the maximum safe integer`);
  }

  return Number(value);
};

const normalizeHex = (
  value: string,
  field: string
): Hex => {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!isHex(normalized)) {
    throw new Error(`${field} must be a hex string`);
  }

  return normalized;
};

const optionalSignatureEncoding = (value: unknown): SignatureEncoding | undefined => {
  const normalized = optionalTrimmedString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === "hex" || normalized === "base64" || normalized === "base58") {
    return normalized;
  }

  throw new Error(`Unsupported signature encoding: ${normalized}`);
};

const requireSigningRequestKind = (
  value: unknown,
  field: string
): SigningRequest["kind"] => {
  const normalized = requireNonEmptyString(value, field);
  switch (normalized) {
    case "digest":
    case "evm.personal_message":
    case "evm.typed_data":
    case "evm.transaction":
    case "solana.message":
    case "solana.transaction":
      return normalized;
    default:
      throw new Error(`Unsupported signing request kind: ${normalized}`);
  }
};

const requireTransferStatusKind = (
  value: unknown
): TransferStatusQuery["kind"] => {
  const normalized = requireNonEmptyString(value, "kind");
  switch (normalized) {
    case "latest":
    case "recent":
    case "lookup":
      return normalized;
    default:
      throw new Error(`Unsupported transfer status query kind: ${normalized}`);
  }
};

const requireWalletAccountQueryKind = (
  value: unknown
): WalletAccountQuery["kind"] => {
  const normalized = requireNonEmptyString(value, "kind");
  switch (normalized) {
    case "default":
    case "list":
      return normalized;
    default:
      throw new Error(`Unsupported wallet account query kind: ${normalized}`);
  }
};

const requireManageContactsOperation = (
  value: unknown
): ManageContactsInput["operation"] => {
  const normalized = requireNonEmptyString(value, "operation");
  switch (normalized) {
    case "add":
    case "update":
      return normalized;
    default:
      throw new Error(`Unsupported contact operation: ${normalized}`);
  }
};

const requireGetContactsQueryKind = (
  value: unknown
): GetContactsQuery["kind"] => {
  const normalized = requireNonEmptyString(value, "kind");
  switch (normalized) {
    case "list":
    case "lookup":
      return normalized;
    default:
      throw new Error(`Unsupported contact query kind: ${normalized}`);
  }
};

const optionalWalletChainFamily = (
  value: unknown
): WalletChainFamily | undefined => {
  const normalized = optionalTrimmedString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === "evm" || normalized === "solana") {
    return normalized;
  }

  throw new Error(`Unsupported wallet chain family: ${normalized}`);
};

const optionalBinaryEncoding = (
  value: unknown
): "hex" | "base64" | undefined => {
  const normalized = optionalTrimmedString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === "hex" || normalized === "base64") {
    return normalized;
  }

  throw new Error(`Unsupported binary encoding: ${normalized}`);
};

const requireMessageEncoding = (
  value: unknown,
  field: string
): "utf8" | "hex" | "base64" => {
  const normalized = optionalTrimmedString(value) ?? "utf8";
  if (normalized === "utf8" || normalized === "hex" || normalized === "base64") {
    return normalized;
  }

  throw new Error(`${field} must be utf8, hex, or base64`);
};

const requireEvmMessageEncoding = (
  value: unknown,
  field: string
): "utf8" | "hex" => {
  const normalized = optionalTrimmedString(value) ?? "utf8";
  if (normalized === "utf8" || normalized === "hex") {
    return normalized;
  }

  throw new Error(`${field} must be utf8 or hex`);
};

const optionalPositiveInteger = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return requirePositiveInteger(value, "value");
};

const optionalKeyAlgorithm = (value: unknown): "secp256k1" | "ed25519" | undefined => {
  const normalized = optionalTrimmedString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === "secp256k1" || normalized === "ed25519") {
    return normalized;
  }

  throw new Error(`Unsupported algorithm: ${normalized}`);
};

const requireTransactionStatus = (
  value: unknown,
  field: string
): WalletTransactionStatus => {
  const normalized = requireNonEmptyString(value, field);
  switch (normalized) {
    case "awaiting_signature":
    case "signed":
    case "rejected":
    case "submitted":
    case "confirmed":
    case "failed":
      return normalized;
    default:
      throw new Error(`Unsupported transaction status: ${normalized}`);
  }
};

const requirePositiveDecimal = (value: unknown, field: string): string => {
  const normalized = requireNonEmptyString(value, field);
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${field} must be a positive decimal string`);
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be greater than zero`);
  }

  return normalized;
};

const requirePositiveInteger = (value: unknown, field: string): number => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  throw new Error(`${field} must be a non-negative integer`);
};

const requireSolanaAddress = (value: unknown, field: string): string => {
  const normalized = requireNonEmptyString(value, field);
  if (!SolanaAddressPattern.test(normalized)) {
    throw new Error(`${field} must be a base58 Solana address`);
  }

  try {
    return new PublicKey(normalized).toBase58();
  } catch {
    throw new Error(`${field} must be a valid Solana public key`);
  }
};

const requireWalletAddress = (
  value: unknown,
  field: string,
  chainFamily: WalletChainFamily
): string =>
  chainFamily === "solana"
    ? requireSolanaAddress(value, field)
    : requireEvmAddress(value, field);

const requireEvmAddress = (value: unknown, field: string): string => {
  const normalized = requireNonEmptyString(value, field);
  if (!EvmAddressPattern.test(normalized)) {
    throw new Error(`${field} must be a 0x-prefixed 20-byte address`);
  }

  return normalized;
};

const requireSolanaTransactionVersion = (
  value: unknown,
  field: string
): "legacy" | "v0" => {
  const normalized = requireNonEmptyString(value, field);
  if (normalized === "legacy" || normalized === "v0") {
    return normalized;
  }

  throw new Error(`${field} must be legacy or v0`);
};

const requireSolanaTransactionEncoding = (
  value: unknown,
  field: string
): "base64" => {
  const normalized = requireNonEmptyString(value, field);
  if (normalized === "base64") {
    return "base64";
  }

  throw new Error(`${field} must be base64`);
};

const requireStringArray = (value: unknown, field: string): ReadonlyArray<string> => {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a string array`);
  }

  return value.map((entry, index) => requireNonEmptyString(entry, `${field}[${index}]`));
};

const requireNonEmptyString = (value: unknown, field: string): string => {
  const normalized = optionalTrimmedString(value);
  if (!normalized) {
    throw new Error(`${field} must be a non-empty string`);
  }

  return normalized;
};

const optionalTrimmedString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;

const requireRecord = (value: unknown, field: string): Readonly<Record<string, unknown>> => {
  try {
    return asRecord(value);
  } catch {
    throw new Error(`${field} must be a JSON object`);
  }
};

const optionalRecord = (
  value: unknown,
  field: string
): Readonly<Record<string, unknown>> | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireRecord(value, field);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }

  return value as Record<string, unknown>;
};
