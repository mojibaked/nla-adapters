import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findStaleListings,
  getStoredListing,
  listStoredListings,
  saveListings
} from "../dist/index.js";

// In-memory fake of the StorageClient contract. Covers the `install` scope
// that the actions use.
const createFakeStorage = () => {
  const store = new Map();
  return {
    store,
    getJson: async ({ scope, key }) => store.get(`${scope}:${key}`),
    putJson: async ({ scope, key, value }) => {
      store.set(`${scope}:${key}`, value);
    }
  };
};

const jsonLdPayload = {
  about: {
    offers: {
      itemOffered: [
        {
          vehicleIdentificationNumber: "VIN00000000000001",
          name: "New 2026 BMW M4 Competition",
          image: "https://example/one.jpg",
          itemCondition: "http://schema.org/NewCondition",
          offers: {
            price: "91980.00",
            priceCurrency: "USD",
            url: "https://example/pdp/1",
            seller: {
              name: "BMW of San Francisco",
              address: { addressLocality: "San Francisco", addressRegion: "CA" }
            }
          },
          brand: { name: "BMW" },
          model: "M4",
          vehicleModelDate: 2026,
          mileageFromOdometer: { value: "16" },
          sku: 1
        },
        {
          vehicleIdentificationNumber: "VIN00000000000002",
          name: "Used 2023 BMW M4 Competition",
          image: "https://example/two.jpg",
          itemCondition: "http://schema.org/UsedCondition",
          offers: {
            price: "75995.00",
            priceCurrency: "USD",
            url: "https://example/pdp/2"
          },
          brand: { name: "BMW" },
          model: "M4",
          vehicleModelDate: 2023,
          mileageFromOdometer: { value: "17,922" },
          sku: 2
        }
      ]
    }
  }
};

test("saveListings → listStoredListings round-trips", async () => {
  const storage = createFakeStorage();
  const ctx = { storage };

  const saved = await saveListings(ctx, { source: jsonLdPayload });
  assert.equal(saved.savedCount, 2);
  assert.equal(saved.totalStored, 2);
  assert.deepEqual([...saved.vins].sort(), ["VIN00000000000001", "VIN00000000000002"]);

  const listed = await listStoredListings(ctx);
  assert.equal(listed.count, 2);
  assert.equal(listed.listings[0].make, "BMW");
});

test("saveListings is forgiving about HTML-wrapped JSON-LD", async () => {
  const storage = createFakeStorage();
  const ctx = { storage };

  const html = `<script data-cmp="listingsCollectionSchema" type="application/ld+json">${JSON.stringify(jsonLdPayload)}</script>`;
  const saved = await saveListings(ctx, { source: html });
  assert.equal(saved.savedCount, 2);
});

test("listStoredListings filters by condition and year", async () => {
  const storage = createFakeStorage();
  const ctx = { storage };
  await saveListings(ctx, { source: jsonLdPayload });

  const usedOnly = await listStoredListings(ctx, { condition: "used" });
  assert.equal(usedOnly.count, 1);
  assert.equal(usedOnly.listings[0].vin, "VIN00000000000002");

  const yr2026 = await listStoredListings(ctx, { year: 2026 });
  assert.equal(yr2026.count, 1);
  assert.equal(yr2026.listings[0].vin, "VIN00000000000001");
});

test("getStoredListing returns found / not_found", async () => {
  const storage = createFakeStorage();
  const ctx = { storage };
  await saveListings(ctx, { source: jsonLdPayload });

  const hit = await getStoredListing(ctx, { vin: "VIN00000000000001" });
  assert.equal(hit.status, "found");
  assert.equal(hit.listing?.price, 91980);

  const miss = await getStoredListing(ctx, { vin: "NOPE" });
  assert.equal(miss.status, "not_found");
});

test("findStaleListings uses the injected clock", async () => {
  const storage = createFakeStorage();
  let fakeNow = new Date("2026-04-20T12:00:00.000Z");
  const ctx = { storage, now: () => fakeNow };

  await saveListings(ctx, { source: jsonLdPayload });

  // No time has passed — nothing is stale.
  const fresh = await findStaleListings(ctx, { olderThanHours: 1 });
  assert.equal(fresh.count, 0);

  // Jump the clock forward 48 hours; both listings should now be stale
  // relative to a 24h threshold.
  fakeNow = new Date("2026-04-22T12:00:00.000Z");
  const stale = await findStaleListings(ctx, { olderThanHours: 24 });
  assert.equal(stale.count, 2);
});

test("saveListings preserves firstSeenAt on re-save", async () => {
  const storage = createFakeStorage();
  let fakeNow = new Date("2026-04-20T12:00:00.000Z");
  const ctx = { storage, now: () => fakeNow };

  await saveListings(ctx, { source: jsonLdPayload });
  const first = await getStoredListing(ctx, { vin: "VIN00000000000001" });
  const firstSeen = first.listing?.firstSeenAt;

  fakeNow = new Date("2026-04-22T12:00:00.000Z");
  await saveListings(ctx, { source: jsonLdPayload });
  const again = await getStoredListing(ctx, { vin: "VIN00000000000001" });
  assert.equal(again.listing?.firstSeenAt, firstSeen, "firstSeenAt must not move");
  assert.equal(again.listing?.lastSeenAt, "2026-04-22T12:00:00.000Z");
});
