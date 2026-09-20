/** A single turn supplied to an {@link LLMProvider}. */
export interface LLMMessage {
  role: 'user' | 'agent' | 'system';
  content: string;
}

/** Request payload for {@link LLMProvider.complete}. */
export interface CompletionRequest {
  system?: string;
  messages: LLMMessage[];
  temperature?: number;
}

/** Result of a completion call. */
export interface CompletionResult {
  content: string;
}

/** Pluggable LLM backend. Implementations must not require runtime deps. */
export interface LLMProvider {
  /** Produce a single completion for the given conversation. */
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
