import type { CompletionRequest, CompletionResult } from './types.js';

/** Options for {@link MockProvider}. */
export interface MockProviderOptions {
  /** Canned response text. */
  response?: string;
  /** Optional hook to observe requests in tests. */
  onComplete?: (req: CompletionRequest) => void;
}

/**
 * Deterministic provider returning a fixed response. Used by tests and local
 * development without network access.
 */
export class MockProvider {
  readonly #response: string;
  readonly #onComplete: ((req: CompletionRequest) => void) | undefined;
  /** Every request received, in order. */
  readonly requests: CompletionRequest[] = [];

  constructor(options: MockProviderOptions = {}) {
    this.#response = options.response ?? 'mock response';
    this.#onComplete = options.onComplete;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    this.#onComplete?.(req);
    return { content: this.#response };
  }
}
