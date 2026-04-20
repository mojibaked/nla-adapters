import { test } from "node:test";
import assert from "node:assert/strict";

import { extractListingsFromJsonLd } from "../dist/index.js";

// Minimal-but-representative fixture modeled on the real
// `listingsCollectionSchema` payload Autotrader embeds on an SRP. Each
// listing exercises a different extractor concern:
//   1. Full New car with nested dealer + address.
//   2. Used car with blank seller fields (NielloGO-style private-party).
//   3. Garbage entry that should be dropped.
const fixture = {
  "@context": "http://schema.org/",
  "@type": "CollectionPage",
  about: {
    "@type": "WebPage",
    offers: {
      "@type": "Offer",
      itemOffered: [
        {
          "@type": ["Product", "Car"],
          vehicleIdentificationNumber: "WBS23HK09TCW47889",
          name: "New 2026 BMW M4 Competition w/ Parking Assistance Package",
          image: "https://images.autotrader.com/hn/c/f7dc1775.jpg",
          itemCondition: "http://schema.org/NewCondition",
          offers: {
            "@type": "Offer",
            priceCurrency: "USD",
            price: "91980.00",
            url: "https://www.autotrader.com/cars-for-sale/vehicle/765561608",
            seller: {
              "@type": "AutoDealer",
              name: "BMW of San Francisco",
              telephone: "7027671741",
              address: {
                "@type": "PostalAddress",
                addressLocality: "San Francisco",
                addressRegion: "CA",
                postalCode: "94103",
                streetAddress: "1675 Howard St"
              }
            }
          },
          brand: { "@type": "Brand", name: "BMW" },
          model: "M4",
          vehicleModelDate: 2026,
          driveWheelConfiguration: "2 Wheel Drive - Rear",
          vehicleEngine: "6-Cylinder Turbo",
          vehicleTransmission: "8-Speed Automatic",
          color: "Green",
          vehicleInteriorColor: "Black",
          mileageFromOdometer: {
            "@type": "QuantitativeValue",
            value: "16",
            unitCode: "SMI"
          },
          fuelEfficiency: "16 City / 23 Highway",
          sku: 765561608,
          url: "https://www.autotrader.com/cars-for-sale/vehicle/765561608"
        },
        {
          "@type": ["Product", "Car"],
          vehicleIdentificationNumber: "WBS13HK06TCU91192",
          name: "Used 2026 BMW M4 Coupe",
          image: "https://images.autotrader.com/hn/c/c5da0188.jpg",
          itemCondition: "http://schema.org/UsedCondition",
          offers: {
            "@type": "Offer",
            priceCurrency: "USD",
            price: "77494.00",
            url: "https://www.autotrader.com/cars-for-sale/vehicle/776915347",
            seller: {
              "@type": "AutoDealer",
              name: "NielloGO",
              telephone: "",
              address: {
                "@type": "PostalAddress",
                addressLocality: "",
                addressRegion: "",
                postalCode: "",
                streetAddress: ""
              }
            }
          },
          brand: { "@type": "Brand", name: "BMW" },
          model: "M4",
          vehicleModelDate: 2026,
          color: "Gray",
          mileageFromOdometer: {
            "@type": "QuantitativeValue",
            value: "17,922",
            unitCode: "SMI"
          },
          sku: 776915347,
          url: "https://www.autotrader.com/cars-for-sale/vehicle/776915347"
        },
        {
          // Missing VIN → must be dropped entirely.
          "@type": ["Product", "Car"],
          name: "Mystery 2024 BMW M4",
          brand: { "@type": "Brand", name: "BMW" },
          model: "M4",
          vehicleModelDate: 2024,
          itemCondition: "http://schema.org/UsedCondition",
          offers: { "@type": "Offer", url: "https://example/pdp" }
        }
      ]
    }
  }
};

test("extracts full listing with dealer address", () => {
  const listings = extractListingsFromJsonLd(fixture);
  assert.equal(listings.length, 2, "junk entry should be dropped");

  const [first] = listings;
  assert.equal(first.vin, "WBS23HK09TCW47889");
  assert.equal(first.condition, "new");
  assert.equal(first.year, 2026);
  assert.equal(first.make, "BMW");
  assert.equal(first.model, "M4");
  assert.equal(first.price, 91980);
  assert.equal(first.priceCurrency, "USD");
  assert.equal(first.mileage, 16);
  assert.equal(first.atcListingId, "765561608");
  assert.equal(first.pdpUrl, "https://www.autotrader.com/cars-for-sale/vehicle/765561608");
  assert.equal(first.imageUrl, "https://images.autotrader.com/hn/c/f7dc1775.jpg");
  assert.equal(first.exteriorColor, "Green");
  assert.equal(first.interiorColor, "Black");
  assert.equal(first.transmission, "8-Speed Automatic");
  assert.equal(first.engine, "6-Cylinder Turbo");
  assert.equal(first.drivetrain, "2 Wheel Drive - Rear");
  assert.equal(first.fuelEfficiency, "16 City / 23 Highway");
  assert.equal(first.dealer?.name, "BMW of San Francisco");
  assert.equal(first.dealer?.phone, "7027671741");
  assert.deepEqual(first.dealer?.address, {
    streetAddress: "1675 Howard St",
    locality: "San Francisco",
    region: "CA",
    postalCode: "94103"
  });
});

test("parses comma-separated mileage and drops blank dealer address", () => {
  const listings = extractListingsFromJsonLd(fixture);
  const second = listings[1];
  assert.equal(second.vin, "WBS13HK06TCU91192");
  assert.equal(second.condition, "used");
  assert.equal(second.mileage, 17922, "mileage with thousands separator should parse");
  assert.equal(second.dealer?.name, "NielloGO");
  assert.equal(second.dealer?.phone, undefined, "blank phone should be undefined");
  assert.equal(second.dealer?.address, undefined, "all-blank address should be omitted");
});

test("accepts raw JSON string input", () => {
  const listings = extractListingsFromJsonLd(JSON.stringify(fixture));
  assert.equal(listings.length, 2);
});

test("returns empty for garbage input", () => {
  assert.deepEqual(extractListingsFromJsonLd("not json"), []);
  assert.deepEqual(extractListingsFromJsonLd(null), []);
  assert.deepEqual(extractListingsFromJsonLd({}), []);
  assert.deepEqual(extractListingsFromJsonLd({ about: { offers: {} } }), []);
});
