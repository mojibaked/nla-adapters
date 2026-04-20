export type ListingCondition = "new" | "used";

export interface DealerAddress {
  readonly streetAddress?: string;
  readonly locality?: string;
  readonly region?: string;
  readonly postalCode?: string;
}

export interface Dealer {
  readonly name: string;
  readonly phone?: string;
  readonly address?: DealerAddress;
}

export interface Listing {
  readonly vin: string;
  readonly atcListingId: string;
  readonly pdpUrl: string;
  readonly fullName: string;
  readonly condition: ListingCondition;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly price?: number;
  readonly priceCurrency?: string;
  readonly mileage?: number;
  readonly imageUrl?: string;
  readonly exteriorColor?: string;
  readonly interiorColor?: string;
  readonly drivetrain?: string;
  readonly engine?: string;
  readonly transmission?: string;
  readonly fuelEfficiency?: string;
  readonly dealer?: Dealer;
}

export interface StoredListing extends Listing {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}
