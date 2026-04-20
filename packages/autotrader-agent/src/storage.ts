import type { StorageClient } from "@nla-adapters/contracts";
import type { Listing, StoredListing } from "./types.js";

export const DefaultListingsStorageKey = "autotrader.listings";

export const readStoredListings = async (
  storage: Pick<StorageClient, "getJson">,
  storageKey: string = DefaultListingsStorageKey
): Promise<ReadonlyArray<StoredListing>> =>
  decodeStoredListings(await storage.getJson({ scope: "install", key: storageKey }));

export const writeStoredListings = async (
  storage: Pick<StorageClient, "putJson">,
  listings: ReadonlyArray<StoredListing>,
  storageKey: string = DefaultListingsStorageKey
): Promise<void> => {
  await storage.putJson({ scope: "install", key: storageKey, value: listings });
};

export const upsertListings = (
  existing: ReadonlyArray<StoredListing>,
  freshly: ReadonlyArray<Listing>,
  seenAt: string
): ReadonlyArray<StoredListing> => {
  const byVin = new Map<string, StoredListing>();
  for (const stored of existing) byVin.set(stored.vin, stored);

  for (const listing of freshly) {
    const prior = byVin.get(listing.vin);
    byVin.set(listing.vin, {
      ...listing,
      firstSeenAt: prior?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt
    });
  }

  return Array.from(byVin.values());
};

const decodeStoredListings = (value: unknown): ReadonlyArray<StoredListing> => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (isStoredListing(entry) ? [entry] : []));
};

const isStoredListing = (value: unknown): value is StoredListing => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.vin === "string" &&
    typeof record.atcListingId === "string" &&
    typeof record.pdpUrl === "string" &&
    typeof record.fullName === "string" &&
    (record.condition === "new" || record.condition === "used") &&
    typeof record.year === "number" &&
    typeof record.make === "string" &&
    typeof record.model === "string" &&
    typeof record.firstSeenAt === "string" &&
    typeof record.lastSeenAt === "string"
  );
};
