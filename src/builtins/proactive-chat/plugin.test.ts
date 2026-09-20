import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../core/runtime.js';
import { HermesRuntime } from '../../core/runtime.js';
import { MockProvider } from '../../llm/mock.js';
import { createProactiveChatPlugin } from './index.js';
import type { ProactiveSkippedEvent } from './types.js';

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
    emotion: { decayRatePerHour: 0.1, socialNeedGrowthPerHour: 0.2, useLlmAssessment: false },
    context: { historyTailMessages: 20 },
    delayedQueue: { maxSize: 10, maxAgeHours: 4 },
    persona: { systemPrompt: 'test persona' },
    ...overrides,
  };
}

function runtimeConfig(
  slice: Record<string, unknown>,
): RuntimeConfig {
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

async function boot(
  slice: Record<string, unknown>,
  response = 'Hey, long time no chat!',
): Promise<{ runtime: HermesRuntime; llm: MockProvider; outbound: Outbound[]; skipped: ProactiveSkippedEvent[] }> {
  const llm = new MockProvider({ response });
  const runtime = new HermesRuntime({ config: runtimeConfig(slice), llm });
  runtime.register(createProactiveChatPlugin());
  const outbound: Outbound[] = [];
  const skipped: ProactiveSkippedEvent[] = [];
  runtime.eventBus.on('message:outbound', (payload) => outbound.push(payload));
  runtime.eventBus.on('proactive:skipped', (payload) => {
    skipped.push(payload as ProactiveSkippedEvent);
  });
  await runtime.start();
  return { runtime, llm, outbound, skipped };
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
    const { runtime, outbound } = await boot(pluginSlice());

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
    const { runtime, llm, outbound } = await boot(pluginSlice({ enabled: false }));

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hi there');

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(outbound).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);

    await runtime.stop();
  });

  it('does not initiate during quiet hours', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 0, 0));
    const { runtime, llm, outbound, skipped } = await boot(pluginSlice());

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
    const { runtime, llm, outbound } = await boot(pluginSlice());

    runtime.sessions.create();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(outbound).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);

    await runtime.stop();
  });
});
