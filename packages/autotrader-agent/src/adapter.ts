import {
  defineToolLoopSessionAdapter,
  tool,
  type NlaAdapterDefinition,
  type NlaSessionReplyData,
  type NlaSessionToolDefinition,
  type NlaToolLoopModel,
  type NlaToolLoopRequest,
  type NlaToolLoopRequestOptions,
  type NlaToolLoopResponse,
  type NlaToolLoopStreamEvent,
  type NlaToolLoopSessionMemoryStore
} from "@nla/sdk-core";
import {
  adapterTool,
  finalAssistantText,
  type NlaAdapterTarget,
  type NlaSessionLauncher
} from "@nla/delegation";
import type { StorageClient } from "@nla-adapters/contracts";
import {
  findStaleListings,
  getStoredListing,
  listStoredListings,
  saveListings,
  type ActionContext,
  type FindStaleListingsResult,
  type GetStoredListingResult,
  type ListStoredListingsResult,
  type SaveListingsResult
} from "./actions.js";
import {
  createAutotraderBrowserTools,
  createBrowserLoader,
  type AutotraderBrowserDependencies
} from "./browser.js";
import {
  requestAutotraderToolApproval,
  type AutotraderApprovalRejectedResult
} from "./approval.js";
import { extractListingsFromJsonLd } from "./extract.js";
import { DefaultListingsStorageKey } from "./storage.js";
import type { Listing, ListingCondition } from "./types.js";

export interface AutotraderAgentDependencies extends AutotraderBrowserDependencies {
  readonly createModel: () => NlaToolLoopModel;
  readonly storage: Pick<StorageClient, "getJson" | "putJson">;
  readonly storageKey?: string;
  readonly conversationMemory?: NlaToolLoopSessionMemoryStore<{}>;
  readonly researchLauncher?: NlaSessionLauncher;
  readonly now?: () => Date;
}

interface ResearchVehicleMarketInput {
  readonly query: string;
  readonly vehicleContext?: string;
  readonly listingContext?: string;
}

const ResearchAgentTarget = {
  id: "research.agent",
  metadata: {
    installId: "research.agent.process"
  }
} satisfies NlaAdapterTarget;

const INSTRUCTIONS = [
  "You are the Autotrader shopping agent. You help the user find and track car listings on autotrader.com.",
  "",
  "Built-in browser tools (navigate, snapshot, get_text, get_html, list_media_urls, click, fill, select_option, press_key, scroll, wait_for) are available to drive the site. Use them to search autotrader and pull listing data.",
  "Snapshot returns refs like `r12`; use them as selectors in the form `[data-mcp-ref=\"r12\"]` for click/fill/select_option/press_key/scroll.",
  "When approval mode is enabled by the host, any tool may return `{ status: \"rejected\", message: ... }` if the user denies it. If that happens, explain what was blocked and stop or ask whether to retry.",
  "",
  "SEARCH STRATEGY — prefer deep-links:",
  "Autotrader accepts URL query params directly. For a fresh search, navigate straight to:",
  "  https://www.autotrader.com/cars-for-sale/all-cars/{make-slug}/{model-slug}/{city-slug}-{state}?zip={zip}",
  "Additional params: startYear, endYear, startPrice, endPrice, startMileage, endMileage, sortBy (values: relevance, derivedpriceASC, derivedpriceDESC, distanceASC, mileageASC, yearDESC, datelistedDESC).",
  "Only click through the homepage form if the user explicitly asks you to use the UI or the slug is unknown.",
  "",
  "EXTRACTING LISTINGS — always via JSON-LD:",
  "Every SRP embeds a <script data-cmp=\"listingsCollectionSchema\" type=\"application/ld+json\"> containing every visible listing with full structured data.",
  "After navigating, call get_html with selector `script[data-cmp=\"listingsCollectionSchema\"]` and pass the result to the `save_listings` tool. Never ask the user for prices — read them from the JSON-LD.",
  "",
  "PDP MEDIA — use the deterministic media tool first:",
  "When the user asks for photos or image URLs from a vehicle detail page, call `list_media_urls` first. It scans `img/src`, `srcset`, social-image meta tags, and JSON-LD image fields, and returns absolute URLs.",
  "Never assume a CDN hostname such as `dealer.com`. If a narrow selector misses, broaden the read instead of ending the turn.",
  "",
  "READ HYGIENE:",
  "Use `get_html` for structured islands you already expect to exist, such as Autotrader's JSON-LD scripts. For exploratory reads, prefer `snapshot`, `list_media_urls`, or `get_html` with `all: true`.",
  "If `get_html` returns `{ found: false, ... }`, treat that as a selector miss and try a broader query.",
  "",
  "SESSION OPENING — check what we already know:",
  "Before a fresh search, call `list_stored_listings` and `find_stale_listings` to see what the user already has. If they ask about something you already have cached, summarize from cache first, then offer to refresh stale entries.",
  "",
  "MARKET RESEARCH — use `research_vehicle_market` when available for broader market context, common issues, price comps, model-year reliability, dealer/listing background, or questions that require sources beyond the current Autotrader page.",
  "",
  "REFRESHING — re-check a specific listing:",
  "To verify a stored listing is still available/priced correctly, navigate its pdpUrl, then pull and save the page's JSON-LD. `save_listings` upserts by VIN and updates lastSeenAt; stale data refreshes automatically.",
  "",
  "UI HYGIENE:",
  "If you open any modal or drawer (filters, dialogs), close it before handing back control. Synthetic events bypass overlays that block the user's mouse.",
  "",
  "Keep responses short. For up to 3 highlighted listings, use one short paragraph per listing separated by blank lines. Use compact tables only for larger comparisons or when the user explicitly asks for a table."
].join("\n");

interface AutotraderPresentationState {
  previewListings: ReadonlyArray<Listing>;
}

interface AutotraderTurnContext {
  presentation: AutotraderPresentationState;
}

export const createAutotraderAgent = (
  dependencies: AutotraderAgentDependencies
): NlaAdapterDefinition => {
  const { getBrowser, closeBrowser } = createBrowserLoader(dependencies);
  const ctx: ActionContext = {
    storage: dependencies.storage,
    storageKey: dependencies.storageKey?.trim() || DefaultListingsStorageKey,
    now: dependencies.now
  };

  return defineToolLoopSessionAdapter<AutotraderTurnContext>({
    id: "autotrader.agent",
    name: "Autotrader Agent",
    description: "Browses autotrader.com, extracts listings from JSON-LD, and caches them for follow-up sessions.",
    instructions: INSTRUCTIONS,
    createContext: async () => ({
      presentation: {
        previewListings: []
      }
    }),
    onSessionStop: async () => {
      await closeBrowser().catch(() => undefined);
    },
    model: (context) =>
      createAutotraderPresentationModel(dependencies.createModel(), context.presentation),
    maxIterations: 20,
    memory: dependencies.conversationMemory,
    tools: [
      ...createAutotraderBrowserTools(getBrowser),
      ...createResearchTools(dependencies.researchLauncher),
      tool<AutotraderTurnContext, unknown, SaveListingsResult | AutotraderApprovalRejectedResult>({
        name: "save_listings",
        description:
          "Parse Autotrader JSON-LD and upsert the listings into local storage. Accepts either the raw outerHTML of the <script> tag, the inner JSON text, or the already-parsed object. Returns how many listings were saved. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["source"],
          properties: {
            source: {
              description:
                "The JSON-LD payload. Safe to pass the raw get_html output — HTML script wrapping is stripped automatically."
            }
          }
        },
        execute: async (context, input) => {
          const source = (input as { source?: unknown } | undefined)?.source;
          const approval = await requestAutotraderToolApproval(context, "save_listings", {
            sourceKind: describeUnknownValue(source)
          });
          if (approval.status === "rejected") {
            return approval;
          }

          context.presentation.previewListings = selectPresentationListings(
            extractListingsSafely(source)
          );
          return saveListings(ctx, { source });
        }
      }),
      tool<AutotraderTurnContext, unknown, ListStoredListingsResult | AutotraderApprovalRejectedResult>({
        name: "list_stored_listings",
        description:
          "List listings cached from prior searches. Optional filters narrow by make, model, year, or condition. Returns newest-seen first. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            make: { type: "string" },
            model: { type: "string" },
            year: { type: "number" },
            condition: { type: "string", enum: ["new", "used"] }
          }
        },
        execute: async (context, input) => {
          const filters = (input as
            | { make?: string; model?: string; year?: number; condition?: ListingCondition }
            | undefined) ?? {};
          const approval = await requestAutotraderToolApproval(context, "list_stored_listings", {
            ...filters
          });
          if (approval.status === "rejected") {
            return approval;
          }

          const result = await listStoredListings(ctx, filters);
          context.presentation.previewListings = selectPresentationListings(result.listings);
          return result;
        }
      }),
      tool<AutotraderTurnContext, unknown, GetStoredListingResult | AutotraderApprovalRejectedResult>({
        name: "get_stored_listing",
        description:
          "Fetch a single cached listing by VIN. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["vin"],
          properties: {
            vin: { type: "string", description: "17-character VIN" }
          }
        },
        execute: async (context, input) => {
          const vin = requireString(input, "vin", "get_stored_listing requires a `vin`");
          const approval = await requestAutotraderToolApproval(context, "get_stored_listing", {
            vin
          });
          if (approval.status === "rejected") {
            return approval;
          }

          const result = await getStoredListing(ctx, { vin });
          context.presentation.previewListings = result.listing
            ? selectPresentationListings([result.listing])
            : [];
          return result;
        }
      }),
      tool<AutotraderTurnContext, unknown, FindStaleListingsResult | AutotraderApprovalRejectedResult>({
        name: "find_stale_listings",
        description:
          "List cached listings last seen more than `olderThanHours` ago — the candidates to refresh when the user asks whether prices are still current. When approval mode is enabled, this may instead return `{ status: \"rejected\", message }`.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["olderThanHours"],
          properties: {
            olderThanHours: {
              type: "number",
              description: "Staleness threshold in hours. e.g. 24 = listings not seen in the last day."
            }
          }
        },
        execute: async (context, input) => {
          const olderThanHours = requireNumber(
            input,
            "olderThanHours",
            "find_stale_listings requires `olderThanHours`"
          );
          const approval = await requestAutotraderToolApproval(context, "find_stale_listings", {
            olderThanHours
          });
          if (approval.status === "rejected") {
            return approval;
          }

          const result = await findStaleListings(ctx, { olderThanHours });
          context.presentation.previewListings = selectPresentationListings(result.listings);
          return result;
        }
      })
    ]
  });
};

const createResearchTools = (
  launcher: NlaSessionLauncher | undefined
): ReadonlyArray<NlaSessionToolDefinition<AutotraderTurnContext, any, any>> =>
  launcher
    ? [
        adapterTool<AutotraderTurnContext, ResearchVehicleMarketInput, string>({
          name: "research_vehicle_market",
          description:
            "Delegate a focused vehicle-market research question to the research agent. Use this for market context, common issues, price comps, model-year reliability, dealer/listing background, or source-backed facts beyond the current Autotrader page.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: {
              query: {
                type: "string",
                description: "Focused research question to answer."
              },
              vehicleContext: {
                type: "string",
                description: "Optional make/model/year/trim or other vehicle context from the user's request or listing."
              },
              listingContext: {
                type: "string",
                description: "Optional listing/dealer/price/location context to ground the research request."
              }
            }
          },
          decode: decodeResearchVehicleMarketInput,
          target: ResearchAgentTarget,
          launcher,
          mapInput: ({ input }) => ({
            text: formatResearchVehicleMarketPrompt(input),
            metadata: {
              kind: "autotrader.research_vehicle_market",
              query: input.query
            }
          }),
          mapOutput: finalAssistantText
        })
      ]
    : [];

const decodeResearchVehicleMarketInput = (
  input: unknown
): ResearchVehicleMarketInput => ({
  query: requireString(input, "query", "research_vehicle_market requires `query`"),
  ...optionalStringProperty(input, "vehicleContext"),
  ...optionalStringProperty(input, "listingContext")
});

const formatResearchVehicleMarketPrompt = (
  input: ResearchVehicleMarketInput
): string => {
  const sections = [
    "Research this Autotrader vehicle-shopping question. Keep the answer concise and include source titles or URLs.",
    `Question: ${input.query}`
  ];

  if (input.vehicleContext) {
    sections.push(`Vehicle context:\n${input.vehicleContext}`);
  }

  if (input.listingContext) {
    sections.push(`Listing context:\n${input.listingContext}`);
  }

  return sections.join("\n\n");
};

const createAutotraderPresentationModel = (
  inner: NlaToolLoopModel,
  presentation: AutotraderPresentationState
): NlaToolLoopModel => ({
  respond: async (
    request: NlaToolLoopRequest,
    options?: NlaToolLoopRequestOptions
  ): Promise<NlaToolLoopResponse> => {
    const result = await inner.respond(request, options);
    return result.type === "assistant"
      ? attachInlineListingImages(result, presentation)
      : result;
  },
  streamRespond: inner.streamRespond
    ? async function* (
      request: NlaToolLoopRequest,
      options?: NlaToolLoopRequestOptions
    ): AsyncIterable<NlaToolLoopStreamEvent> {
      const stream = await inner.streamRespond?.(request, options);
      if (!stream) {
        return;
      }

      for await (const event of stream) {
        yield event.type === "assistant.completed"
          ? attachInlineListingImages(event, presentation)
          : event;
      }
    }
    : undefined
});

const attachInlineListingImages = <T extends NlaSessionReplyData>(
  reply: T,
  presentation: AutotraderPresentationState
): T => {
  if (hasImagePart(reply.parts)) {
    return reply;
  }

  const listings = selectPresentationListings(presentation.previewListings);
  if (listings.length === 0) {
    return reply;
  }

  const text = textFromReply(reply);
  if (!text || looksLikeMarkdownTable(text)) {
    return reply;
  }

  const parts = interleaveListingImageParts(text, listings);
  if (!parts) {
    return reply;
  }

  return {
    ...reply,
    parts
  };
};

const interleaveListingImageParts = (
  text: string,
  listings: ReadonlyArray<Listing>
): ReadonlyArray<{ type: string; text?: string; imageUrl?: string }> | undefined => {
  const blocks = splitReplyBlocks(text);
  if (blocks.length === 0) {
    return undefined;
  }

  const usedVins = new Set<string>();
  const parts: Array<{ type: string; text?: string; imageUrl?: string }> = [];
  let matchedCount = 0;

  blocks.forEach((block, index) => {
    const trimmed = block.trim();
    if (!trimmed) {
      return;
    }

    parts.push({
      type: "text",
      text: trimmed
    });

    const match = bestListingMatch(trimmed, listings, usedVins);
    if (match?.imageUrl) {
      matchedCount += 1;
      usedVins.add(match.vin);
      parts.push({
        type: "image",
        imageUrl: match.imageUrl
      });
    }

    if (index < blocks.length - 1) {
      parts.push({
        type: "text",
        text: "\n\n"
      });
    }
  });

  return matchedCount > 0 ? parts : undefined;
};

const splitReplyBlocks = (text: string): string[] => {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  if (/\n\s*\n/.test(normalized)) {
    return normalized
      .split(/\n\s*\n+/)
      .map((block) => block.trim())
      .filter(Boolean);
  }

  const listStarts = [...normalized.matchAll(/(?:^|\n)(?=(?:\d+\.\s+|[-*]\s+))/g)]
    .map((match) => match.index ?? 0)
    .map((index) => (normalized[index] === "\n" ? index + 1 : index));
  if (listStarts.length >= 2) {
    return listStarts.map((start, index) =>
      normalized.slice(start, listStarts[index + 1] ?? normalized.length).trim()
    );
  }

  return [normalized];
};

const bestListingMatch = (
  block: string,
  listings: ReadonlyArray<Listing>,
  usedVins: ReadonlySet<string>
): Listing | undefined => {
  const scored = listings
    .filter((listing) => !usedVins.has(listing.vin) && typeof listing.imageUrl === "string" && listing.imageUrl.trim())
    .map((listing) => ({
      listing,
      score: scoreListingBlockMatch(block, listing)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < 30) {
    return undefined;
  }

  if (runnerUp && best.score - runnerUp.score < 8) {
    return undefined;
  }

  return best.listing;
};

const scoreListingBlockMatch = (block: string, listing: Listing): number => {
  const normalizedBlock = normalizeSearchText(block);
  const normalizedDealer = normalizeSearchText(listing.dealer?.name);
  const normalizedName = normalizeSearchText(listing.fullName);
  const normalizedCore = normalizeSearchText(`${listing.year} ${listing.make} ${listing.model}`);
  let score = 0;

  if (includesSearchPhrase(normalizedBlock, listing.vin)) score += 100;
  if (includesSearchPhrase(normalizedBlock, normalizedCore)) {
    score += 40;
  } else {
    if (includesSearchPhrase(normalizedBlock, String(listing.year))) score += 10;
    if (includesSearchPhrase(normalizedBlock, listing.make)) score += 10;
    if (includesSearchPhrase(normalizedBlock, listing.model)) score += 10;
  }

  if (includesPrice(block, listing.price)) score += 20;
  if (normalizedDealer && includesSearchPhrase(normalizedBlock, normalizedDealer)) score += 15;

  for (const token of listingNameHintTokens(normalizedName, listing)) {
    if (includesSearchPhrase(normalizedBlock, token)) {
      score += 4;
    }
  }

  if (listing.condition === "new" && includesSearchPhrase(normalizedBlock, "new")) score += 3;
  if (listing.condition === "used" && includesSearchPhrase(normalizedBlock, "used")) score += 3;

  return score;
};

const listingNameHintTokens = (
  normalizedName: string,
  listing: Listing
): string[] => {
  const ignored = new Set([
    normalizeSearchText(String(listing.year)),
    normalizeSearchText(listing.make),
    normalizeSearchText(listing.model),
    "new",
    "used"
  ]);

  return normalizedName
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !ignored.has(token));
};

const includesPrice = (text: string, price: number | undefined): boolean => {
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return false;
  }

  const integer = Math.round(price);
  const formatted = integer.toLocaleString("en-US");
  return text.includes(`$${formatted}`)
    || text.includes(formatted)
    || text.includes(String(integer));
};

const selectPresentationListings = (
  listings: ReadonlyArray<Listing>
): ReadonlyArray<Listing> =>
  listings
    .filter((listing) => typeof listing.imageUrl === "string" && listing.imageUrl.trim())
    .slice(0, 3);

const extractListingsSafely = (source: unknown): ReadonlyArray<Listing> => {
  try {
    return extractListingsFromJsonLd(unwrapJsonLdSource(source));
  } catch {
    return [];
  }
};

const unwrapJsonLdSource = (source: unknown): unknown => {
  if (typeof source !== "string") return source;
  const match = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
  return match ? match[1] : source;
};

const hasImagePart = (parts: ReadonlyArray<{ type?: string }> | undefined): boolean =>
  Array.isArray(parts) && parts.some((part) => part?.type === "image");

const textFromReply = (reply: NlaSessionReplyData): string | undefined => {
  if (typeof reply.text === "string" && reply.text.trim()) {
    return reply.text;
  }

  if (!Array.isArray(reply.parts)) {
    return undefined;
  }

  const text = reply.parts
    .map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
    .join("");
  return text.trim() ? text : undefined;
};

const looksLikeMarkdownTable = (text: string): boolean =>
  /\|.+\|/.test(text) && /\|[\s:-]+\|/.test(text);

const normalizeSearchText = (value: string | undefined): string =>
  (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const includesSearchPhrase = (haystack: string, needle: string): boolean => {
  const normalizedNeedle = normalizeSearchText(needle);
  if (!haystack || !normalizedNeedle) {
    return false;
  }

  return haystack.includes(normalizedNeedle);
};

const requireString = (input: unknown, key: string, message: string): string => {
  const record = isRecord(input) ? input : undefined;
  const raw = record?.[key];
  if (typeof raw !== "string") throw new Error(message);
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(message);
  return trimmed;
};

const requireNumber = (input: unknown, key: string, message: string): number => {
  const record = isRecord(input) ? input : undefined;
  const raw = record?.[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const optionalStringProperty = (
  input: unknown,
  key: "vehicleContext" | "listingContext"
): Partial<Pick<ResearchVehicleMarketInput, "vehicleContext" | "listingContext">> => {
  const value = isRecord(input) ? input[key] : undefined;
  return typeof value === "string" && value.trim()
    ? { [key]: value.trim() }
    : {};
};

const describeUnknownValue = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};
