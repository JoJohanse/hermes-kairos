import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { resolveProactiveChatConfig } from './config.js';
import { decide } from './decision.js';
import {
  applyUserMessageCoupling,
  DEFAULT_EMOTION_DYNAMICS,
  DEFAULT_EMOTION_STATE,
  evolveEmotion,
} from './emotion.js';
import {
  ProactiveChatPlugin,
  PROACTIVE_CHAT_STATE_NAME,
  type ProactiveChatPluginOptions,
} from './index.js';
import {
  PROACTIVE_CHAT_SNAPSHOT_VERSION,
  type EmotionState,
  type HeldStub,
  type ProactiveChatSnapshot,
  type ProactiveDelegateEvent,
  type ProactiveDelegateFailedEvent,
  type ProactiveDeliveryFailedEvent,
  type ProactiveDeliveryHandler,
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
  /** Extra plugin options (e.g. a `deliveryHandler`). */
  pluginOptions?: ProactiveChatPluginOptions;
}

interface BootResult {
  runtime: HermesRuntime;
  plugin: ProactiveChatPlugin;
  llm: LLMProvider;
  outbound: Outbound[];
  skipped: ProactiveSkippedEvent[];
  held: ProactiveHeldEvent[];
  thought: ProactiveThoughtEvent[];
  delegate: ProactiveDelegateEvent[];
  delegateFailed: ProactiveDelegateFailedEvent[];
  deliveryFailed: ProactiveDeliveryFailedEvent[];
}

async function boot(options: BootOptions = {}): Promise<BootResult> {
  const llm: LLMProvider =
    options.provider ?? new MockProvider({ response: options.response ?? 'Hey, long time no chat!' });
  const runtime = new HermesRuntime({
    config: runtimeConfig(options.slice ?? pluginSlice(), options.dataDir),
    llm,
  });
  const plugin = new ProactiveChatPlugin(options.pluginOptions);
  runtime.register(plugin);
  const outbound: Outbound[] = [];
  const skipped: ProactiveSkippedEvent[] = [];
  const held: ProactiveHeldEvent[] = [];
  const thought: ProactiveThoughtEvent[] = [];
  const delegate: ProactiveDelegateEvent[] = [];
  const delegateFailed: ProactiveDelegateFailedEvent[] = [];
  const deliveryFailed: ProactiveDeliveryFailedEvent[] = [];
  runtime.eventBus.on('message:outbound', (payload) => outbound.push(payload));
  runtime.eventBus.on('proactive:skipped', (payload) => skipped.push(payload as ProactiveSkippedEvent));
  runtime.eventBus.on('proactive:held', (payload) => held.push(payload as ProactiveHeldEvent));
  runtime.eventBus.on('proactive:thought', (payload) => thought.push(payload as ProactiveThoughtEvent));
  runtime.eventBus.on('proactive:delegate', (payload) =>
    delegate.push(payload as ProactiveDelegateEvent),
  );
  runtime.eventBus.on('proactive:delegate-failed', (payload) =>
    delegateFailed.push(payload as ProactiveDelegateFailedEvent),
  );
  runtime.eventBus.on('proactive:delivery-failed', (payload) =>
    deliveryFailed.push(payload as ProactiveDeliveryFailedEvent),
  );
  await runtime.start();
  return { runtime, plugin, llm, outbound, skipped, held, thought, delegate, delegateFailed, deliveryFailed };
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

/** Read back the snapshot the plugin wrote to an injected {@link MemoryFs}. */
function readMemorySnapshot(fs: MemoryFs): ProactiveChatSnapshot {
  const raw = fs.files.get(join('data', `${PROACTIVE_CHAT_STATE_NAME}.json`));
  if (raw === undefined) throw new Error('snapshot was not written');
  return JSON.parse(raw) as ProactiveChatSnapshot;
}

/** Read back the snapshot the plugin wrote to a real data dir. */
function readSnapshotFrom(dataDir: string): ProactiveChatSnapshot {
  return JSON.parse(
    readFileSync(join(dataDir, `${PROACTIVE_CHAT_STATE_NAME}.json`), 'utf8'),
  ) as ProactiveChatSnapshot;
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

  it('merges an in-flight assessment into a state coupled by a concurrent message', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
    const provider = new DeferredProvider();
    const { runtime, plugin } = await boot({
      slice: pluginSlice({
        emotion: {
          decayRatePerHour: 0.1,
          socialNeedGrowthPerHour: 0.2,
          arousalFloor: 0.2,
          useLlmAssessment: true,
        },
      }),
      provider,
    });

    const session = runtime.sessions.create();
    runtime.sessions.appendMessage(session.id, 'user', 'hello');

    // Start a heartbeat whose assessment call stays pending.
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.requests).toHaveLength(1);

    // A user message arrives while the assessment is in flight and couples the
    // *current* state (arousal bumped, socialNeed reset).
    runtime.sessions.appendMessage(session.id, 'user', 'still here');
    const coupled = plugin.emotionState(session.id);
    expect(coupled?.arousal).toBeGreaterThan(0.85);
    expect(coupled?.socialNeed).toBeCloseTo(0.1);

    provider.resolve('{"valence":0.9,"arousal":1,"socialNeed":0.9}');
    await vi.advanceTimersByTimeAsync(0);

    // The merge must build on the coupled state, not the stale pre-await one.
    const merged = plugin.emotionState(session.id);
    expect(merged?.arousal).toBeGreaterThan(0.9);
    expect(merged?.socialNeed).toBeLessThan(0.65);

    await runtime.stop();
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

    it('re-init unsubscribes the old handler so coupling is not applied twice', () => {
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
      const bus = new RecordingBus();
      const { ctx } = makePluginContext({
        bus,
        slice: pluginSlice({
          emotion: {
            decayRatePerHour: 0.1,
            socialNeedGrowthPerHour: 0.2,
            arousalFloor: 0.2,
            useLlmAssessment: false,
            userMessageArousalBump: 0.1,
            interactionSocialNeedReset: 0.1,
          },
          persistence: { enabled: false },
        }),
      });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);
      plugin.init(ctx);

      // The second init must drop the first subscription before re-subscribing.
      expect(bus.unsubscribeCalls).toBe(1);

      const session = ctx.sessions.create();
      ctx.sessions.appendMessage(session.id, 'user', 'hi');

      // Default arousal 0.8 + a single 0.1 bump = 0.9 (a double bump would be 1).
      const state = plugin.emotionState(session.id);
      expect(state?.arousal).toBeCloseTo(0.9, 10);
      expect(state?.socialNeed).toBe(0.1);
      expect(state?.valence).toBe(0.7);
    });

    it('re-init clears stale send cooldown state', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 5, 0, 0));
      const { ctx, scheduler, sessions } = makePluginContext({
        slice: pluginSlice({ persistence: { enabled: false } }),
      });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);
      scheduler.start();
      const session = sessions.create();
      sessions.appendMessage(session.id, 'user', 'hi');

      vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(plugin.sendTimestamps(session.id)).toHaveLength(1);

      plugin.init(ctx);
      expect(plugin.sendTimestamps(session.id)).toHaveLength(0);

      plugin.teardown();
      scheduler.stop();
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

      // The session was never re-created in the second runtime (fresh UUIDs), so
      // pruning at save time must drop it instead of re-persisting it forever.
      const persisted = readSnapshotFrom(dataDir);
      expect(Object.keys(persisted.sessions)).not.toContain(session.id);
    });

    it('drops a session removed at runtime from the next snapshot', () => {
      const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
      vi.setSystemTime(now);
      const fs = new MemoryFs();
      const { ctx, sessions } = makePluginContext({ fs, slice: pluginSlice() });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);
      const kept = sessions.create();
      const removed = sessions.create();
      sessions.appendMessage(kept.id, 'user', 'hi');
      sessions.appendMessage(removed.id, 'user', 'hi');

      // First save persists both live sessions.
      plugin.teardown();
      expect(Object.keys(readMemorySnapshot(fs).sessions).sort()).toEqual(
        [kept.id, removed.id].sort(),
      );

      // Re-init restores both from the snapshot, but the removed session is no
      // longer live, so the next save must not re-persist it.
      sessions.remove(removed.id);
      plugin.init(ctx);
      plugin.teardown();
      expect(Object.keys(readMemorySnapshot(fs).sessions)).toEqual([kept.id]);
    });

    it('periodically saves every saveIntervalTicks heartbeats', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 5, 0, 0));
      const fs = new MemoryFs();
      const { ctx, scheduler, sessions } = makePluginContext({
        fs,
        slice: pluginSlice({ persistence: { enabled: true, saveIntervalTicks: 2 } }),
      });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);
      scheduler.start();
      const session = sessions.create();
      sessions.appendMessage(session.id, 'user', 'hi');
      expect(fs.writeCount).toBe(0);

      // Tick 1: below the interval, no periodic save.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fs.writeCount).toBe(0);

      // Tick 2: the interval elapses exactly once.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fs.writeCount).toBe(1);

      // Tick 3: no save (and no double-count from the previous tick).
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fs.writeCount).toBe(1);

      // Tick 4: saves again.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fs.writeCount).toBe(2);

      plugin.teardown();
      scheduler.stop();
    });

    it('rejects out-of-range emotion in a snapshot and restores the default', () => {
      const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
      vi.setSystemTime(now);
      const fs = new MemoryFs();
      writeSnapshot(fs, {
        version: PROACTIVE_CHAT_SNAPSHOT_VERSION,
        savedAt: now,
        sessions: {
          bad: {
            emotion: { valence: 42, arousal: -5, socialNeed: 2 },
            sends: [],
            queue: [],
          },
        },
      });

      const { ctx } = makePluginContext({ fs });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);

      expect(plugin.emotionState('bad')).toEqual(DEFAULT_EMOTION_STATE);
      plugin.teardown();
    });

    it('restores valid in-range emotion unchanged', () => {
      const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
      vi.setSystemTime(now);
      const fs = new MemoryFs();
      const emotion: EmotionState = { valence: 0.2, arousal: 0.3, socialNeed: 0.4 };
      writeSnapshot(fs, {
        version: PROACTIVE_CHAT_SNAPSHOT_VERSION,
        savedAt: now,
        sessions: { good: { emotion, sends: [], queue: [] } },
      });

      const { ctx } = makePluginContext({ fs });
      const plugin = new ProactiveChatPlugin();
      plugin.init(ctx);

      expect(plugin.emotionState('good')).toEqual(emotion);
      plugin.teardown();
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

    it('ignores a snapshot with an unsupported version', () => {      const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
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

  describe('delegate delivery mode', () => {
    it('emits a directive instead of calling the LLM or ctx.send on GENERATE', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
      const llm = new MockProvider({ response: 'should not be used' });
      const { runtime, outbound, delegate } = await boot({
        slice: pluginSlice({ delivery: { mode: 'delegate' } }),
        provider: llm,
      });

      const session = runtime.sessions.create();
      runtime.sessions.appendMessage(session.id, 'user', 'hi there');

      await vi.advanceTimersByTimeAsync(6 * 60_000);

      expect(delegate).toHaveLength(1);
      expect(delegate[0]?.sessionId).toBe(session.id);
      expect(delegate[0]?.directive).toContain(session.id);
      expect(delegate[0]?.directive).toContain('Time since last contact');
      expect(delegate[0]?.directive).toContain('socialNeed');
      expect(llm.requests).toHaveLength(0);
      expect(outbound).toHaveLength(0);
      expect(session.messages.filter((message) => message.role === 'agent')).toHaveLength(0);

      await runtime.stop();
    });

    it('delegates a promoted HOLD stub without an LLM call', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
      const llm = new MockProvider({ response: 'unused' });
      const { runtime, outbound, held, delegate } = await boot({
        slice: holdSlice({
          delayedQueue: { maxSize: 10, maxAgeHours: 24 },
          delivery: { mode: 'delegate' },
        }),
        provider: llm,
      });

      const session = runtime.sessions.create();
      runtime.sessions.appendMessage(session.id, 'user', 'hi');

      // 08:30 → HOLD: stub queued, no delegation yet.
      vi.setSystemTime(new Date(2026, 0, 15, 8, 30, 0));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(held).toHaveLength(1);
      expect(delegate).toHaveLength(0);

      // 18:00 → promotion: delegate instead of generating content.
      vi.setSystemTime(new Date(2026, 0, 15, 18, 0, 0));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(delegate).toHaveLength(1);
      expect(delegate[0]?.sessionId).toBe(session.id);
      expect(llm.requests).toHaveLength(0);
      expect(outbound).toHaveLength(0);

      await runtime.stop();
    });

    it('runOnce forces an immediate evaluation tick', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 3, 0, 0));
      const { runtime, outbound, plugin } = await boot({ slice: pluginSlice() });

      const session = runtime.sessions.create();
      runtime.sessions.appendMessage(session.id, 'user', 'hi');

      // No timers advanced: only the explicit trigger should evaluate.
      vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
      await plugin.runOnce();

      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.sessionId).toBe(session.id);

      await runtime.stop();
    });
  });

  describe('awaited delivery handler (F6)', () => {
    it('delegate: a rejecting handler records no send slot and the next tick retries', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
      let attempts = 0;
      const deliveryHandler: ProactiveDeliveryHandler = async () => {
        attempts += 1;
        throw new Error('post failed');
      };
      const { runtime, plugin, delegate, delegateFailed } = await boot({
        slice: pluginSlice({ delivery: { mode: 'delegate' } }),
        pluginOptions: { deliveryHandler },
      });

      const session = runtime.sessions.create();
      runtime.sessions.appendMessage(session.id, 'user', 'hi there');

      // 5 min of silence is the first tick that clears `noSendAfterActivity`.
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(attempts).toBe(1);
      expect(delegateFailed).toHaveLength(1);
      expect(delegateFailed[0]?.reason).toBe('post failed');
      // The event-bus fallback must stay silent when a handler owns delivery.
      expect(delegate).toHaveLength(0);
      // No slot recorded → cooldown does not apply → the next eligible tick retries.
      expect(plugin.sendTimestamps(session.id)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(2);
      expect(plugin.sendTimestamps(session.id)).toHaveLength(0);

      await runtime.stop();
    });

    it('delegate: a resolving handler records the slot exactly once', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
      let attempts = 0;
      const deliveryHandler: ProactiveDeliveryHandler = async () => {
        attempts += 1;
      };
      const { runtime, plugin, delegateFailed } = await boot({
        slice: pluginSlice({ delivery: { mode: 'delegate' } }),
        pluginOptions: { deliveryHandler },
      });

      const session = runtime.sessions.create();
      runtime.sessions.appendMessage(session.id, 'user', 'hi there');

      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(attempts).toBe(1);
      expect(delegateFailed).toHaveLength(0);
      expect(plugin.sendTimestamps(session.id)).toHaveLength(1);

      // Inside the 30-minute cooldown the slot suppresses further delivery.
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(attempts).toBe(1);
      expect(plugin.sendTimestamps(session.id)).toHaveLength(1);

      await runtime.stop();
    });

    it('self: a rejecting handler emits delivery-failed, skips ctx.send and the slot', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
      let attempts = 0;
      const deliveryHandler: ProactiveDeliveryHandler = async () => {
        attempts += 1;
        throw new Error('transport down');
      };
      const { runtime, plugin, outbound, deliveryFailed } = await boot({
        slice: pluginSlice(),
        pluginOptions: { deliveryHandler },
      });

      const session = runtime.sessions.create();
      runtime.sessions.appendMessage(session.id, 'user', 'hi there');

      // 5 min of silence is the first tick that clears `noSendAfterActivity`.
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(attempts).toBe(1);
      expect(deliveryFailed).toHaveLength(1);
      expect(deliveryFailed[0]?.reason).toBe('transport down');
      expect(outbound).toHaveLength(0);
      expect(plugin.sendTimestamps(session.id)).toHaveLength(0);

      // The retry path is open again on the next eligible tick.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(2);

      await runtime.stop();
    });

    it('self: a resolving handler delivers via ctx.send and records the slot once', async () => {
      vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
      let attempts = 0;
      const deliveryHandler: ProactiveDeliveryHandler = async () => {
        attempts += 1;
      };
      const { runtime, plugin, outbound, deliveryFailed } = await boot({
        slice: pluginSlice(),
        pluginOptions: { deliveryHandler },
      });

      const session = runtime.sessions.create();
      runtime.sessions.appendMessage(session.id, 'user', 'hi there');

      await vi.advanceTimersByTimeAsync(6 * 60_000);

      expect(attempts).toBe(1);
      expect(deliveryFailed).toHaveLength(0);
      expect(outbound).toHaveLength(1);
      expect(outbound[0]?.content).toBe('Hey, long time no chat!');
      expect(plugin.sendTimestamps(session.id)).toHaveLength(1);

      await runtime.stop();
    });
  });
});
