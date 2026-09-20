import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EventHandler, type EventMap } from '../../core/event-bus.js';
import type { RuntimeConfig } from '../../core/runtime.js';
import { HermesRuntime } from '../../core/runtime.js';
import { SessionManager } from '../../core/session-manager.js';
import { JsonStore, type JsonStoreFs } from '../../core/storage.js';
import type { Message } from '../../core/types.js';
import { MockProvider } from '../../llm/mock.js';
import type { CompletionRequest, CompletionResult, LLMProvider } from '../../llm/types.js';
import type { PluginContext } from '../../plugins/types.js';
import { Scheduler } from '../../scheduler/scheduler.js';
import { resolveProactiveChatConfig } from '../../config/config.js';
import { decide } from './decision.js';
import {
  applyUserMessageCoupling,
  DEFAULT_EMOTION_DYNAMICS,
  evolveEmotion,
} from './emotion.js';
import { ProactiveChatPlugin, PROACTIVE_CHAT_STATE_NAME } from './index.js';
import {
  PROACTIVE_CHAT_SNAPSHOT_VERSION,
  type EmotionState,
  type HeldStub,
  type ProactiveChatSnapshot,
  type ProactiveHeldEvent,
  type ProactiveSkippedEvent,
  type ProactiveThoughtEvent,
} from './types.js';

const tempDirs: string[] = [];

/** Per-runtime temp data dir so runs never share persisted plugin state. */
function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-plugin-'));
  tempDirs.push(dir);
  return dir;
}

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

function runtimeConfig(slice: Record<string, unknown>, dataDir: string = makeDataDir()): RuntimeConfig {
  return {
    llm: { baseURL: 'http://localhost:0/v1', apiKey: '', model: 'mock' },
    storage: { dataDir },
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
  /** Reuse a specific data dir (for restart/persistence tests). */
  dataDir?: string;
}

interface BootResult {
  runtime: HermesRuntime;
  plugin: ProactiveChatPlugin;
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
    config: runtimeConfig(options.slice ?? pluginSlice(), options.dataDir),
    llm,
  });
  const plugin = new ProactiveChatPlugin();
  runtime.register(plugin);
  const outbound: Outbound[] = [];
  const skipped: ProactiveSkippedEvent[] = [];
  const held: ProactiveHeldEvent[] = [];
  const thought: ProactiveThoughtEvent[] = [];
  runtime.eventBus.on('message:outbound', (payload) => outbound.push(payload));
  runtime.eventBus.on('proactive:skipped', (payload) => skipped.push(payload as ProactiveSkippedEvent));
  runtime.eventBus.on('proactive:held', (payload) => held.push(payload as ProactiveHeldEvent));
  runtime.eventBus.on('proactive:thought', (payload) => thought.push(payload as ProactiveThoughtEvent));
  await runtime.start();
  return { runtime, plugin, llm, outbound, skipped, held, thought };
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

/** In-memory filesystem that counts reads/writes for persistence assertions. */
class MemoryFs implements JsonStoreFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readCount = 0;
  writeCount = 0;

  exists(path: string): boolean {
    return this.files.has(path);
  }

  readFile(path: string): string {
    this.readCount += 1;
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return data;
  }

  writeFile(path: string, data: string): void {
    this.writeCount += 1;
    this.files.set(path, data);
  }

  rename(from: string, to: string): void {
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.files.set(to, data);
  }

  mkdir(path: string): void {
    this.dirs.add(path);
  }
}

/** EventBus that counts unsubscribe calls, to prove plugin teardown unsubscribes. */
class RecordingBus extends EventBus {
  unsubscribeCalls = 0;

  override on<K extends keyof EventMap & string>(
    topic: K,
    handler: EventHandler<EventMap[K]>,
  ): () => void {
    const unsubscribe = super.on(topic, handler);
    return () => {
      this.unsubscribeCalls += 1;
      unsubscribe();
    };
  }
}

interface ContextHandle {
  ctx: PluginContext;
  bus: EventBus;
  sessions: SessionManager;
  scheduler: Scheduler;
  fs: MemoryFs;
}

/** Build a PluginContext directly, with an injectable in-memory filesystem. */
function makePluginContext(
  options: { bus?: EventBus; fs?: MemoryFs; slice?: Record<string, unknown> } = {},
): ContextHandle {
  const bus = options.bus ?? new EventBus();
  const sessions = new SessionManager({ eventBus: bus });
  const scheduler = new Scheduler();
  const fs = options.fs ?? new MemoryFs();
  const ctx: PluginContext = {
    eventBus: bus,
    sessions,
    scheduler,
    llm: new MockProvider({ response: 'persisted thought' }),
    storage: new JsonStore({ dataDir: 'data', fs }),
    config: { proactiveChat: options.slice ?? pluginSlice() },
    send: async (sessionId, content): Promise<Message> => {
      const message = sessions.appendMessage(sessionId, 'agent', content);
      bus.emit('message:outbound', { sessionId, content, timestamp: message.timestamp });
      return message;
    },
  };
  return { ctx, bus, sessions, scheduler, fs };
}

function writeSnapshot(fs: MemoryFs, snapshot: ProactiveChatSnapshot): void {
  fs.files.set(
    join('data', `${PROACTIVE_CHAT_STATE_NAME}.json`),
    JSON.stringify(snapshot),
  );
}

function heldStub(sessionId: string, enqueuedAt: number, score: number): HeldStub {
  return {
    sessionId,
    enqueuedAt,
    scoreAtEnqueue: score,
    breakdown: {
      valence: 0.5,
      arousal: 0.5,
      socialNeed: 0.5,
      intensity: 0.5,
      timeFitness: 1,
      silenceFactor: 1,
      frequencyLimit: 1,
      silenceMinutes: 60,
      sentThisHour: 0,
      sentToday: 0,
      score,
    },
  };
}

describe('ProactiveChatPlugin (integration)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
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

    // 08:30 → score bands to HOLD; no LLM call, a stub is queued.
    vi.setSystemTime(new Date(2026, 0, 15, 8, 30, 0));
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

    vi.setSystemTime(new Date(2026, 0, 15, 8, 30, 0));
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

  describe('user-message coupling (F7)', () => {
    it('raises arousal and resets socialNeed on a user message', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
      const { runtime, plugin } = await boot({ slice: pluginSlice() });
      const session = runtime.sessions.create();

      expect(plugin.emotionState(session.id)).toBeUndefined();
      runtime.sessions.appendMessage(session.id, 'user', 'hello');

      expect(plugin.emotionState(session.id)).toEqual({
        valence: 0.7,
        arousal: 1,
        socialNeed: 0.1,
      });
      await runtime.stop();
    });

    it('does not couple agent-authored messages', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
      const { runtime, plugin } = await boot({ slice: pluginSlice() });
      const session = runtime.sessions.create();

      runtime.sessions.appendMessage(session.id, 'agent', 'proactive hello');

      expect(plugin.emotionState(session.id)).toBeUndefined();
      await runtime.stop();
    });

    it('unsubscribes on teardown so later events cannot mutate state', () => {
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
      const bus = new RecordingBus();
      const { ctx } = makePluginContext({
        bus,
        slice: pluginSlice({ persistence: { enabled: false } }),
      });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);
      expect(bus.unsubscribeCalls).toBe(0);

      plugin.teardown();
      expect(bus.unsubscribeCalls).toBe(1);

      const message: Message = {
        id: 'm1',
        sessionId: 'ghost',
        role: 'user',
        content: 'hi',
        timestamp: Date.now(),
      };
      ctx.eventBus.emit('message:appended', { message });
      expect(plugin.emotionState('ghost')).toBeUndefined();
    });

    it('lowers the proactive score, all else equal, after a user interaction', () => {
      const emotion: EmotionState = { valence: 0.7, arousal: 0.8, socialNeed: 0.5 };
      const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
      const config = resolveProactiveChatConfig(pluginSlice()).decision;
      const input = {
        now,
        lastMessageAt: now - 2 * 60 * 60_000,
        lastProactiveSendAt: undefined,
        sentThisHour: 0,
        sentToday: 0,
        config,
      };

      const before = decide({ emotion, ...input });
      const coupled = applyUserMessageCoupling(emotion, {
        userMessageArousalBump: 0.3,
        interactionSocialNeedReset: 0.1,
      });
      const after = decide({ emotion: coupled, ...input });

      expect(after.score).toBeLessThan(before.score);
    });
  });

  describe('persistence (F7 restart amnesia)', () => {
    it('persists and restores per-session state across a restart', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
      const dataDir = makeDataDir();
      const slice = pluginSlice();

      const first = await boot({ slice, dataDir });
      const session = first.runtime.sessions.create();
      first.runtime.sessions.appendMessage(session.id, 'user', 'hi');

      // A tick evolves emotion and delivers, recording a send.
      vi.setSystemTime(new Date(2026, 0, 15, 8, 30, 0));
      await vi.advanceTimersByTimeAsync(60_000);
      const savedEmotion = first.plugin.emotionState(session.id);
      const savedSends = [...first.plugin.sendTimestamps(session.id)];
      expect(savedEmotion).toBeDefined();
      expect(savedSends).toHaveLength(1);
      await first.runtime.stop();

      const second = await boot({ slice, dataDir });
      expect(second.plugin.emotionState(session.id)).toEqual(savedEmotion);
      expect([...second.plugin.sendTimestamps(session.id)]).toEqual(savedSends);
      await second.runtime.stop();
    });

    it('evolves restored emotion forward by the wall-clock gap', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
      const dataDir = makeDataDir();
      const slice = pluginSlice();

      const first = await boot({ slice, dataDir });
      const session = first.runtime.sessions.create();
      first.runtime.sessions.appendMessage(session.id, 'user', 'hi');
      const saved = first.plugin.emotionState(session.id);
      expect(saved).toBeDefined();
      await first.runtime.stop();

      // 12 hours later the same snapshot is restored and evolved forward.
      vi.setSystemTime(new Date(2026, 0, 15, 15, 0, 0));
      const second = await boot({ slice, dataDir });
      const expected = evolveEmotion(
        saved as EmotionState,
        12 * 60 * 60_000,
        DEFAULT_EMOTION_DYNAMICS,
      );
      expect(second.plugin.emotionState(session.id)).toEqual(expected);
      await second.runtime.stop();
    });

    it('starts fresh and warns when the state file is corrupt', async () => {
      const dataDir = makeDataDir();
      writeFileSync(join(dataDir, `${PROACTIVE_CHAT_STATE_NAME}.json`), '{ not json', 'utf8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { runtime, plugin } = await boot({ slice: pluginSlice(), dataDir });

        expect(plugin.emotionState('anything')).toBeUndefined();
        expect(
          warn.mock.calls.some((call) => String(call[0]).includes('corrupt JSON')),
        ).toBe(true);
        await runtime.stop();
      } finally {
        warn.mockRestore();
      }
    });

    it('uses a real store when no storage stub is supplied (round-trip writes)', async () => {
      const dataDir = makeDataDir();
      const { runtime, plugin } = await boot({ slice: pluginSlice(), dataDir });
      const session = runtime.sessions.create();
      runtime.sessions.appendMessage(session.id, 'user', 'hi');
      await runtime.stop();

      const second = await boot({ slice: pluginSlice(), dataDir });
      expect(second.plugin.emotionState(session.id)).toBeDefined();
      await second.runtime.stop();
    });

    it('does not read or write when persistence is disabled', () => {
      const fs = new MemoryFs();
      const { ctx } = makePluginContext({
        fs,
        slice: pluginSlice({ persistence: { enabled: false } }),
      });
      const plugin = new ProactiveChatPlugin();

      plugin.init(ctx);
      expect(fs.readCount).toBe(0);

      plugin.teardown();
      expect(fs.writeCount).toBe(0);
    });

    it('saves immediately after a delivery, independent of the periodic interval', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 5, 0, 0));
      const fs = new MemoryFs();
      const { ctx, scheduler, sessions } = makePluginContext({
        fs,
        slice: pluginSlice({ persistence: { enabled: true, saveIntervalTicks: 100_000 } }),
      });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);
      scheduler.start();
      const session = sessions.create();
      sessions.appendMessage(session.id, 'user', 'hi');
      expect(fs.writeCount).toBe(0);

      vi.setSystemTime(new Date(2026, 0, 15, 7, 0, 0));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(plugin.sendTimestamps(session.id)).toHaveLength(1);
      expect(fs.writeCount).toBe(1);

      plugin.teardown();
      expect(fs.writeCount).toBe(2);
    });

    it('prunes expired stubs and stale sends when restoring', () => {
      const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
      vi.setSystemTime(now);
      const fs = new MemoryFs();
      const staleSend = now - 25 * 60 * 60_000;
      const freshSend = now - 60 * 60_000;
      const freshStub = heldStub('s1', now - 60 * 60_000, 0.4);
      const expiredStub = heldStub('s1', now - 10 * 60 * 60_000, 0.9);
      writeSnapshot(fs, {
        version: PROACTIVE_CHAT_SNAPSHOT_VERSION,
        savedAt: now,
        sessions: {
          s1: {
            emotion: { valence: 0.5, arousal: 0.5, socialNeed: 0.5 },
            sends: [staleSend, freshSend],
            queue: [freshStub, expiredStub],
          },
        },
      });

      const { ctx } = makePluginContext({
        fs,
        slice: pluginSlice({ delayedQueue: { maxSize: 10, maxAgeHours: 4 } }),
      });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);

      expect([...plugin.heldStubs('s1')]).toEqual([freshStub]);
      expect([...plugin.sendTimestamps('s1')]).toEqual([freshSend]);
      plugin.teardown();
    });

    it('ignores a snapshot with an unsupported version', () => {
      const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
      vi.setSystemTime(now);
      const fs = new MemoryFs();
      writeSnapshot(fs, {
        version: 999 as unknown as typeof PROACTIVE_CHAT_SNAPSHOT_VERSION,
        savedAt: now,
        sessions: { s1: { emotion: { valence: 0.5, arousal: 0.5, socialNeed: 0.5 }, sends: [], queue: [] } },
      });

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { ctx } = makePluginContext({ fs });
        const plugin = new ProactiveChatPlugin();
        plugin.init(ctx);

        expect(plugin.emotionState('s1')).toBeUndefined();
        expect(warn.mock.calls.some((call) => String(call[0]).includes('unsupported'))).toBe(true);
        plugin.teardown();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
