import type { Dealer, DealerAddress, Listing, ListingCondition } from "./types.js";

// Parses Autotrader's `listingsCollectionSchema` JSON-LD payload into a flat
// array of Listings. Accepts either the already-parsed object or the raw
// JSON text. Returns [] on any parse failure — callers are expected to treat
// missing data as "couldn't extract", not as "no listings".
export const extractListingsFromJsonLd = (input: unknown): ReadonlyArray<Listing> => {
  const parsed = typeof input === "string" ? safeParseJson(input) : input;
  if (!parsed) return [];

  const items = navigateToItemOffered(parsed);
  if (!items) return [];

  return items.flatMap((item) => {
    const listing = normalizeItemOffer(item);
    return listing ? [listing] : [];
  });
};

const safeParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// Walks `CollectionPage.about.offers.itemOffered[]`, which is where the SRP
// puts every listing on the page. Returns undefined if the shape isn't what
// we expect, so the caller can degrade gracefully.
const navigateToItemOffered = (root: unknown): ReadonlyArray<unknown> | undefined => {
  const about = readObjectField(root, "about");
  const offers = readObjectField(about, "offers");
  const itemOffered = readField(offers, "itemOffered");
  return Array.isArray(itemOffered) ? itemOffered : undefined;
};

const normalizeItemOffer = (item: unknown): Listing | null => {
  if (!isRecord(item)) return null;

  const vin = readString(item, "vehicleIdentificationNumber");
  const condition = parseCondition(readString(item, "itemCondition"));
  const year = readNumber(item, "vehicleModelDate");
  const fullName = readString(item, "name");
  const make = readString(readObjectField(item, "brand"), "name");
  const model = readString(item, "model");

  const offer = readObjectField(item, "offers");
  const pdpUrl = readString(offer, "url") ?? readString(item, "url");
  const atcListingId = stringifyScalar(readField(item, "sku"));

  if (!vin || !condition || year === undefined || !fullName || !make || !model || !pdpUrl || !atcListingId) {
    return null;
  }

  return {
    vin,
    atcListingId,
    pdpUrl,
    fullName,
    condition,
    year,
    make,
    model,
    price: parsePrice(readField(offer, "price")),
    priceCurrency: readString(offer, "priceCurrency"),
    mileage: parseMileage(readField(readObjectField(item, "mileageFromOdometer"), "value")),
    imageUrl: readString(item, "image"),
    exteriorColor: readString(item, "color"),
    interiorColor: readString(item, "vehicleInteriorColor"),
    drivetrain: readString(item, "driveWheelConfiguration"),
    engine: readString(item, "vehicleEngine"),
    transmission: readString(item, "vehicleTransmission"),
    fuelEfficiency: readString(item, "fuelEfficiency"),
    dealer: normalizeDealer(readObjectField(offer, "seller"))
  };
};

const normalizeDealer = (seller: unknown): Dealer | undefined => {
  if (!isRecord(seller)) return undefined;
  const name = readString(seller, "name");
  if (!name) return undefined;
  return {
    name,
    phone: readString(seller, "telephone"),
    address: normalizeAddress(readObjectField(seller, "address"))
  };
};

const normalizeAddress = (address: unknown): DealerAddress | undefined => {
  if (!isRecord(address)) return undefined;
  const streetAddress = readString(address, "streetAddress");
  const locality = readString(address, "addressLocality");
  const region = readString(address, "addressRegion");
  const postalCode = readString(address, "postalCode");
  if (!streetAddress && !locality && !region && !postalCode) return undefined;
  return { streetAddress, locality, region, postalCode };
};

// Autotrader uses `http://schema.org/NewCondition` and `.../UsedCondition`.
// Anything else is treated as unknown and the listing is dropped.
const parseCondition = (raw: string | undefined): ListingCondition | undefined => {
  if (!raw) return undefined;
  if (raw.endsWith("NewCondition")) return "new";
  if (raw.endsWith("UsedCondition")) return "used";
  return undefined;
};

// Price comes as a string like "92150.00". Return dollars as a Number, or
// undefined if it doesn't parse.
const parsePrice = (raw: unknown): number | undefined => {
  const text = stringifyScalar(raw);
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

// Mileage comes as a string with thousands separators (e.g. "17,922") or
// tiny numbers for new cars ("15"). Strip commas, parse, or undefined.
const parseMileage = (raw: unknown): number | undefined => {
  const text = stringifyScalar(raw);
  if (!text) return undefined;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const readField = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

const readObjectField = (value: unknown, key: string): unknown => {
  const field = readField(value, key);
  return isRecord(field) ? field : undefined;
};

const readString = (value: unknown, key: string): string | undefined => {
  const field = readField(value, key);
  if (typeof field !== "string") return undefined;
  const trimmed = field.trim();
  return trimmed ? trimmed : undefined;
};

const readNumber = (value: unknown, key: string): number | undefined => {
  const field = readField(value, key);
  if (typeof field === "number" && Number.isFinite(field)) return field;
  if (typeof field === "string") {
    const parsed = Number(field);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const stringifyScalar = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};
