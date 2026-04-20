import type { StorageClient } from "@nla-adapters/contracts";
import { extractListingsFromJsonLd } from "./extract.js";
import {
  DefaultListingsStorageKey,
  readStoredListings,
  upsertListings,
  writeStoredListings
} from "./storage.js";
import type { Listing, ListingCondition, StoredListing } from "./types.js";

export interface ActionContext {
  readonly storage: Pick<StorageClient, "getJson" | "putJson">;
  readonly storageKey?: string;
  readonly now?: () => Date;
}

export interface SaveListingsInput {
  readonly source: unknown;
}

export interface SaveListingsResult {
  readonly kind: "autotrader.save";
  readonly savedCount: number;
  readonly skippedCount: number;
  readonly totalStored: number;
  readonly vins: ReadonlyArray<string>;
}

export interface ListStoredListingsInput {
  readonly make?: string;
  readonly model?: string;
  readonly year?: number;
  readonly condition?: ListingCondition;
}

export interface ListStoredListingsResult {
  readonly kind: "autotrader.list";
  readonly count: number;
  readonly listings: ReadonlyArray<StoredListing>;
}

export interface GetStoredListingInput {
  readonly vin: string;
}

export interface GetStoredListingResult {
  readonly kind: "autotrader.get";
  readonly status: "found" | "not_found";
  readonly vin: string;
  readonly listing?: StoredListing;
}

export interface FindStaleListingsInput {
  readonly olderThanHours: number;
}

export interface FindStaleListingsResult {
  readonly kind: "autotrader.stale";
  readonly olderThanHours: number;
  readonly cutoffIso: string;
  readonly count: number;
  readonly listings: ReadonlyArray<StoredListing>;
}

export const saveListings = async (
  ctx: ActionContext,
  input: SaveListingsInput
): Promise<SaveListingsResult> => {
  const fresh = extractListingsFromJsonLd(unwrapJsonLdSource(input.source));
  const storageKey = ctx.storageKey ?? DefaultListingsStorageKey;
  const now = ctx.now ?? (() => new Date());

  if (fresh.length === 0) {
    const existing = await readStoredListings(ctx.storage, storageKey);
    return {
      kind: "autotrader.save",
      savedCount: 0,
      skippedCount: 0,
      totalStored: existing.length,
      vins: []
    };
  }

  const seenAt = now().toISOString();
  const existing = await readStoredListings(ctx.storage, storageKey);
  const merged = upsertListings(existing, fresh, seenAt);
  await writeStoredListings(ctx.storage, merged, storageKey);

  return {
    kind: "autotrader.save",
    savedCount: fresh.length,
    skippedCount: 0,
    totalStored: merged.length,
    vins: fresh.map((listing: Listing) => listing.vin)
  };
};

export const listStoredListings = async (
  ctx: ActionContext,
  input: ListStoredListingsInput = {}
): Promise<ListStoredListingsResult> => {
  const storageKey = ctx.storageKey ?? DefaultListingsStorageKey;
  const listings = await readStoredListings(ctx.storage, storageKey);
  const matched = listings
    .filter((listing) => matchesFilters(listing, input))
    .slice()
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return {
    kind: "autotrader.list",
    count: matched.length,
    listings: matched
  };
};

export const getStoredListing = async (
  ctx: ActionContext,
  input: GetStoredListingInput
): Promise<GetStoredListingResult> => {
  const storageKey = ctx.storageKey ?? DefaultListingsStorageKey;
  const listings = await readStoredListings(ctx.storage, storageKey);
  const match = listings.find((listing) => listing.vin === input.vin);
  return match
    ? { kind: "autotrader.get", status: "found", vin: input.vin, listing: match }
    : { kind: "autotrader.get", status: "not_found", vin: input.vin };
};

export const findStaleListings = async (
  ctx: ActionContext,
  input: FindStaleListingsInput
): Promise<FindStaleListingsResult> => {
  const storageKey = ctx.storageKey ?? DefaultListingsStorageKey;
  const now = ctx.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - input.olderThanHours * 3_600_000);
  const cutoffIso = cutoff.toISOString();
  const listings = await readStoredListings(ctx.storage, storageKey);
  const stale = listings.filter((listing) => listing.lastSeenAt < cutoffIso);
  return {
    kind: "autotrader.stale",
    olderThanHours: input.olderThanHours,
    cutoffIso,
    count: stale.length,
    listings: stale
  };
};

// Autotrader's JSON-LD is embedded inside a <script> tag. Accept either the
// full outerHTML (as returned by browser-mcp's get_html), the inner JSON
// text, or the already-parsed object. Normalizing here keeps the tool
// schema forgiving.
const unwrapJsonLdSource = (source: unknown): unknown => {
  if (typeof source !== "string") return source;
  const match = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
  return match ? match[1] : source;
};

const matchesFilters = (
  listing: StoredListing,
  filters: ListStoredListingsInput
): boolean => {
  if (filters.make && !equalsIgnoreCase(listing.make, filters.make)) return false;
  if (filters.model && !equalsIgnoreCase(listing.model, filters.model)) return false;
  if (typeof filters.year === "number" && listing.year !== filters.year) return false;
  if (filters.condition && listing.condition !== filters.condition) return false;
  return true;
};

const equalsIgnoreCase = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
