export interface LlmMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface LlmResponse {
  readonly text: string;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export interface SearchCandidate {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly content?: string;
}

export interface SearchInput {
  readonly query: string;
  readonly maxResults?: number;
}

export interface SearchClient {
  search(input: SearchInput): Promise<ReadonlyArray<SearchCandidate>>;
}

export interface BrowserTab {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
}

export interface BrowserClient {
  openTab(url: string): Promise<BrowserTab>;
  getText(tabId: number): Promise<string>;
  closeTab(tabId: number): Promise<void>;
}

export interface PageClaim {
  readonly text: string;
  readonly quote?: string;
}

export interface PageFinding {
  readonly url: string;
  readonly title?: string;
  readonly claims: ReadonlyArray<PageClaim>;
  readonly error?: string;
}
