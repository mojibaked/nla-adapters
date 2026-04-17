import type * as Effect from "effect/Effect";

export type CapabilityScope = "install" | "session";

export interface StorageRequest {
  readonly scope: CapabilityScope;
  readonly key: string;
}

export interface StorageGetJsonRequest extends StorageRequest {}

export interface StoragePutJsonRequest extends StorageRequest {
  readonly value: unknown;
}

export interface StorageDeleteRequest extends StorageRequest {}

export interface StorageClient {
  readonly getJson: (request: StorageGetJsonRequest) => Promise<unknown | undefined>;
  readonly putJson: (request: StoragePutJsonRequest) => Promise<void>;
  readonly delete?: (request: StorageDeleteRequest) => Promise<void>;
}

export interface EffectStorageClient {
  readonly getJson: (
    request: StorageGetJsonRequest
  ) => Effect.Effect<unknown | undefined, Error>;
  readonly putJson: (
    request: StoragePutJsonRequest
  ) => Effect.Effect<void, Error>;
  readonly delete?: (
    request: StorageDeleteRequest
  ) => Effect.Effect<void, Error>;
}

export type AssetMaterializationLocation = "session-cwd" | "temp";

export interface AssetMaterializeRequest {
  readonly assetId: string;
  readonly filename?: string;
  readonly location?: AssetMaterializationLocation;
  readonly cwd?: string;
}

export interface AssetCapabilityClient {
  readonly materialize: (
    request: AssetMaterializeRequest
  ) => Effect.Effect<string, Error>;
}

export type KeyAlgorithm = "ed25519" | "secp256k1" | string;
export type SignatureEncoding = "hex" | "base64" | "base58";
export type BinaryEncoding = "hex" | "base64" | "utf8";
export type PrivateKeyCustody = "client-only-local";

export interface SigningRequestBase {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly chain: string;
  readonly address: string;
  readonly preview: Readonly<Record<string, unknown>>;
  readonly custody: PrivateKeyCustody;
  readonly requestedAt: string;
  readonly eligibleDeviceIds: ReadonlyArray<string>;
  readonly signatureEncoding?: SignatureEncoding;
}

export interface DigestSigningRequest extends SigningRequestBase {
  readonly kind: "digest";
  readonly digest: string;
  readonly digestEncoding?: Exclude<BinaryEncoding, "utf8">;
  readonly algorithm?: KeyAlgorithm;
}

export interface EvmPersonalMessageSigningRequest extends SigningRequestBase {
  readonly kind: "evm.personal_message";
  readonly chainId: number;
  readonly message: string;
  readonly messageEncoding: "hex" | "utf8";
}

export interface EvmTypedDataSigningRequest extends SigningRequestBase {
  readonly kind: "evm.typed_data";
  readonly chainId: number;
  readonly typedData: Readonly<Record<string, unknown>>;
}

export interface EvmTransactionSigningRequest extends SigningRequestBase {
  readonly kind: "evm.transaction";
  readonly chainId: number;
  readonly transaction: Readonly<Record<string, unknown>>;
}

export interface SolanaMessageSigningRequest extends SigningRequestBase {
  readonly kind: "solana.message";
  readonly message: string;
  readonly messageEncoding: BinaryEncoding;
}

export interface SolanaTransactionSigningRequest extends SigningRequestBase {
  readonly kind: "solana.transaction";
  readonly version: "legacy" | "v0";
  readonly transaction: string;
  readonly transactionEncoding: "base64";
}

export type SigningRequest =
  | DigestSigningRequest
  | EvmPersonalMessageSigningRequest
  | EvmTypedDataSigningRequest
  | EvmTransactionSigningRequest
  | SolanaMessageSigningRequest
  | SolanaTransactionSigningRequest;

export interface SigningResolution {
  readonly requestId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly status: "approved" | "rejected";
  readonly signature?: string;
  readonly signatureEncoding?: SignatureEncoding;
  readonly signedPayload?: string;
  readonly signedPayloadEncoding?: Exclude<BinaryEncoding, "utf8">;
  readonly resolvedAt: string;
}

export interface SigningCapabilityClient {
  readonly requestSignature: (
    request: SigningRequest
  ) => Effect.Effect<SigningResolution, Error>;
}

export type WalletChainFamily = "evm" | "solana";

export interface WalletAccountDescriptor {
  readonly id: string;
  readonly chainFamily: WalletChainFamily;
  readonly curve: "secp256k1" | "ed25519";
  readonly address: string;
  readonly derivationPath?: string;
  readonly derivationProfile?: string;
  readonly label?: string;
  readonly isDefault?: boolean;
}

export interface WalletAccountCandidate extends WalletAccountDescriptor {
  readonly eligibleDeviceIds: ReadonlyArray<string>;
}

export interface WalletAccountListRequest {
  readonly chainFamily?: WalletChainFamily;
  readonly chain?: string;
  readonly eligibleDeviceIds?: ReadonlyArray<string>;
}

export interface WalletAccountResolveRequest extends WalletAccountListRequest {
  readonly chainFamily: WalletChainFamily;
  readonly requestedAddress?: string;
}

export interface WalletAccountEnsureRequest extends WalletAccountResolveRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly requestedByClientId: string;
  readonly title?: string;
  readonly body?: string;
}

export interface WalletCapabilityClient {
  readonly listAccounts: (
    request?: WalletAccountListRequest
  ) => Effect.Effect<ReadonlyArray<WalletAccountCandidate>, Error>;
  readonly resolveAccount: (
    request: WalletAccountResolveRequest
  ) => Effect.Effect<WalletAccountCandidate, Error>;
  readonly ensureAccount: (
    request: WalletAccountEnsureRequest
  ) => Effect.Effect<WalletAccountCandidate, Error>;
}
