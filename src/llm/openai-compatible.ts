import type { CompletionRequest, CompletionResult } from './types.js';

/** Options for {@link OpenAICompatibleProvider}. */
export interface OpenAICompatibleOptions {
  /** API root, e.g. `https://api.openai.com/v1`. Trailing slash is tolerated. */
  baseURL: string;
  apiKey: string;
  model: string;
  /** Injectable fetch implementation (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
  error?: { message?: string } | null;
}

/**
 * LLM provider for any OpenAI-compatible `/chat/completions` endpoint.
 * Uses the global `fetch`; no SDK dependency.
 */
export class OpenAICompatibleProvider {
  readonly #baseURL: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.#baseURL = options.baseURL.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new Error(
        'OpenAICompatibleProvider: global fetch is unavailable; pass fetchImpl or run Node >= 18',
      );
    }
    this.#fetch = impl;
  }

  /** Call `/chat/completions` and return the first choice's text content. */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system !== undefined && req.system !== '') {
      messages.push({ role: 'system', content: req.system });
    }
    for (const message of req.messages) {
      // The kernel models the assistant as "agent"; map to the wire format.
      const role = message.role === 'agent' ? 'assistant' : message.role;
      messages.push({ role, content: message.content });
    }

    const body: Record<string, unknown> = {
      model: this.#model,
      messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const response = await this.#fetch(`${this.#baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.#apiKey === '' ? {} : { authorization: `Bearer ${this.#apiKey}` }),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `OpenAICompatibleProvider: HTTP ${response.status} ${response.statusText}${
          detail === '' ? '' : ` — ${detail}`
        }`,
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    if (data.error?.message) {
      throw new Error(`OpenAICompatibleProvider: ${data.error.message}`);
    }
    const content = data.choices?.[0]?.message?.content;
    return { content: content ?? '' };
  }
}
