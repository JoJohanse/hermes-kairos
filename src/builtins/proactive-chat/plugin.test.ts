import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../core/runtime.js';
import { HermesRuntime } from '../../core/runtime.js';
import { MockProvider } from '../../llm/mock.js';
import type { CompletionRequest, CompletionResult, LLMProvider } from '../../llm/types.js';
import { createProactiveChatPlugin } from './index.js';
import type {
  ProactiveHeldEvent,
  ProactiveSkippedEvent,
  ProactiveThoughtEvent,
} from './types.js';

/** Resolved plugin slice used by the integration tests, with low thresholds. */
function pluginSlice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    heartbeat: { intervalMs: 60_000 },
    decision: {
      sendThreshold: 0.05,
      holdThreshold: 0.01,
      maxPerHour: 2,
      maxPerDay: 8,
      cooldownMinutes: 30,
      noSendAfterActivityMinutes: 5,
      quietHours: { start: '23:30', end: '07:00' },
    },
    emotion: {
      decayRatePerHour: 0.1,
      socialNeedGrowthPerHour: 0.2,
      arousalFloor: 0.2,
      useLlmAssessment: false,
    },
    context: { historyTailMessages: 20 },
    delayedQueue: { maxSize: 10, maxAgeHours: 4 },
    persona: { systemPrompt: 'test persona' },
    ...overrides,
  };
}

/** Like {@link pluginSlice} but with default send/hold thresholds (HOLD band). */
function holdSlice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return pluginSlice({
    decision: {
      sendThreshold: 0.6,
      holdThreshold: 0.3,
      maxPerHour: 2,
      maxPerDay: 8,
      cooldownMinutes: 30,
      noSendAfterActivityMinutes: 5,
      quietHours: { start: '23:30', end: '07:00' },
    },
    ...overrides,
  });
}

function runtimeConfig(slice: Record<string, unknown>): RuntimeConfig {
  return {
    llm: { baseURL: 'http://localhost:0/v1', apiKey: '', model: 'mock' },
    plugins: { proactiveChat: slice },
  };
}

interface Outbound {
  sessionId: string;
  content: string;
  timestamp: number;
}

interface BootOptions {
  slice?: Record<string, unknown>;
  /** Provider override (e.g. a deferred provider). Defaults to a MockProvider. */
  provider?: LLMProvider;
  response?: string;
}

interface BootResult {
  runtime: HermesRuntime;
  llm: LLMProvider;
  outbound: Outbound[];
  skipped: ProactiveSkippedEvent[];
  held: ProactiveHeldEvent[];
  thought: ProactiveThoughtEvent[];
}

async function boot(options: BootOptions = {}): Promise<BootResult> {
  const llm: LLMProvider =
    options.provider ?? new MockProvider({ response: options.response ?? 'Hey, long time no chat!' });
  const runtime = new HermesRuntime({
    config: runtimeConfig(options.slice ?? pluginSlice()),
    llm,
  });
  runtime.register(createProactiveChatPlugin());
  const outbound: Outbound[] = [];
  const skipped: ProactiveSkippedEvent[] = [];
  const held: ProactiveHeldEvent[] = [];
  const thought: ProactiveThoughtEvent[] = [];
  runtime.eventBus.on('message:outbound', (payload) => outbound.push(payload));
  runtime.eventBus.on('proactive:skipped', (payload) => skipped.push(payload as ProactiveSkippedEvent));
  runtime.eventBus.on('proactive:held', (payload) => held.push(payload as ProactiveHeldEvent));
  runtime.eventBus.on('proactive:thought', (payload) => thought.push(payload as ProactiveThoughtEvent));
  await runtime.start();
  return { runtime, llm, outbound, skipped, held, thought };
}

/** Provider whose completion stays pending until the test resolves it. */
class DeferredProvider implements LLMProvider {
  readonly requests: CompletionRequest[] = [];
  #resolve: ((result: CompletionResult) => void) | undefined;
  readonly #pending: Promise<CompletionResult>;

  constructor() {
    this.#pending = new Promise<CompletionResult>((resolve) => {
      this.#resolve = resolve;
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    return this.#pending;
  }

  resolve(content: string): void {
    this.#resolve?.({ content });
  }
}

describe('ProactiveChatPlugin (integration)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends exactly one message, then respects the cooldown', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    const llm = new MockProvider({ response: 'Hey, long time no chat!' });
    const { runtime, outbound } = await boot({ slice: pluginSlice(), provider: llm });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hi there');

    // Five vetoed ticks (recent activity), then a send at the 5-minute mark.
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.sessionId).toBe(session.id);
    expect(outbound[0]?.content).toBe('Hey, long time no chat!');
    expect(session.messages.filter((message) => message.role === 'agent')).toHaveLength(1);

    // Inside the 30-minute cooldown nothing else goes out.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(outbound).toHaveLength(1);

    await runtime.stop();
    expect(runtime.scheduler.list()).toEqual([]);
  });

  it('does nothing when the plugin is disabled', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    const llm = new MockProvider();
    const { runtime, outbound } = await boot({ slice: pluginSlice({ enabled: false }), provider: llm });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hi there');

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(outbound).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);

    await runtime.stop();
  });

  it('does not initiate during quiet hours', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 0, 0));
    const llm = new MockProvider();
    const { runtime, outbound, skipped } = await boot({ slice: pluginSlice(), provider: llm });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'goodnight');

    // Jump to 23:45; the session has been silent for 45 minutes.
    vi.setSystemTime(new Date(2026, 0, 15, 23, 45, 0));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(outbound).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);
    expect(skipped.some((event) => event.reason === 'quiet_hours')).toBe(true);

    await runtime.stop();
  });

  it('ignores sessions without any user message', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
    const llm = new MockProvider();
    const { runtime, outbound } = await boot({ slice: pluginSlice(), provider: llm });

    runtime.sessions.create();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(outbound).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);

    await runtime.stop();
  });

  it('generates once for a 48h-idle session on defaults (F3b)', async () => {
    vi.setSystemTime(new Date(2026, 0, 13, 18, 30, 0));
    const llm = new MockProvider({ response: 'still here?' });
    // Empty slice → fully default config (sendThreshold 0.6).
    const { runtime, outbound } = await boot({ slice: {}, provider: llm });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hello');

    // Seed the in-memory emotion state with one tick shortly after the message.
    vi.setSystemTime(new Date(2026, 0, 13, 18, 31, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outbound).toHaveLength(0);

    // 48h later, same evening window: socialNeed has saturated → GENERATE.
    vi.setSystemTime(new Date(2026, 0, 15, 18, 30, 0));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(outbound).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
    expect(session.messages.filter((message) => message.role === 'agent')).toHaveLength(1);

    await runtime.stop();
  });

  it('queues a contentless stub on HOLD and generates only on promotion (F3a)', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
    const llm = new MockProvider({ response: 'promoted thought' });
    const { runtime, outbound, held } = await boot({
      slice: holdSlice({ delayedQueue: { maxSize: 10, maxAgeHours: 24 } }),
      provider: llm,
    });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hi');

    // 10:00 → score bands to HOLD; no LLM call, a stub is queued.
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(held).toHaveLength(1);
    expect(held[0]?.sessionId).toBe(session.id);
    expect(held[0]?.accepted).toBe(true);
    expect(llm.requests).toHaveLength(0);
    expect(outbound).toHaveLength(0);

    // A later below-threshold tick is blocked by the non-empty queue.
    vi.setSystemTime(new Date(2026, 0, 15, 12, 1, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(held).toHaveLength(1);
    expect(llm.requests).toHaveLength(0);
    expect(outbound).toHaveLength(0);

    // 18:00 evening window → fresh score crosses the threshold → generate + deliver.
    vi.setSystemTime(new Date(2026, 0, 15, 18, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(llm.requests).toHaveLength(1);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.content).toBe('promoted thought');

    await runtime.stop();
  });

  it('expires a stale stub and re-holds on a later tick (F3a)', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
    const llm = new MockProvider();
    const { runtime, held } = await boot({
      slice: holdSlice({ delayedQueue: { maxSize: 10, maxAgeHours: 1 } }),
      provider: llm,
    });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hi');

    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(held).toHaveLength(1);

    // Past maxAgeHours the stub is dropped; the still-below-threshold score HOLDs again.
    vi.setSystemTime(new Date(2026, 0, 15, 11, 2, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(held).toHaveLength(2);
    expect(llm.requests).toHaveLength(0);

    await runtime.stop();
  });

  it('surfaces the hourly cap as proactive:skipped (F5)', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
    const llm = new MockProvider();
    const { runtime, outbound, skipped } = await boot({
      slice: pluginSlice({
        decision: {
          sendThreshold: 0.05,
          holdThreshold: 0.01,
          maxPerHour: 1,
          maxPerDay: 8,
          cooldownMinutes: 30,
          noSendAfterActivityMinutes: 5,
          quietHours: { start: '23:30', end: '07:00' },
        },
      }),
      provider: llm,
    });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hi');

    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outbound).toHaveLength(1);

    // 40 minutes later the cooldown has elapsed but the hourly cap has not.
    vi.setSystemTime(new Date(2026, 0, 15, 10, 40, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outbound).toHaveLength(1);
    expect(skipped.some((event) => event.reason === 'hourly_cap')).toBe(true);

    await runtime.stop();
  });

  it('makes zero LLM calls for emotion assessment when guardrails veto (F1)', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 0, 0));
    const llm = new MockProvider();
    const { runtime } = await boot({
      slice: pluginSlice({
        emotion: {
          decayRatePerHour: 0.1,
          socialNeedGrowthPerHour: 0.2,
          arousalFloor: 0.2,
          useLlmAssessment: true,
        },
      }),
      provider: llm,
    });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'goodnight');

    // 23:01 is quiet hours: the assessment must never run.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(llm.requests).toHaveLength(0);

    await runtime.stop();
  });

  it('aborts an in-flight delivery after teardown (F2)', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
    const provider = new DeferredProvider();
    const { runtime, outbound } = await boot({ slice: pluginSlice(), provider });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hello');

    // Start a heartbeat whose LLM call stays pending.
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.requests).toHaveLength(1);
    expect(outbound).toHaveLength(0);

    await runtime.stop();
    provider.resolve('too late');
    await vi.advanceTimersByTimeAsync(0);

    expect(outbound).toHaveLength(0);
    expect(session.messages.filter((message) => message.role === 'agent')).toHaveLength(0);
  });
});
