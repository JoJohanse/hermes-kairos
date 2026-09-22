import type { Unsubscribe } from '../../core/event-bus.js';
import type { JsonStore, JsonStoreReadResult } from '../../core/storage.js';
import type { Message } from '../../core/types.js';
import type { Plugin, PluginContext } from '../../plugins/types.js';
import {
  resolveProactiveChatConfig,
  type ConfigWarnHandler,
  type ProactiveChatConfig,
} from './config.js';
import { buildContextBundle } from './context.js';
import { DelayedQueue } from './delayed-queue.js';
import {
  applyUserMessageCoupling,
  clampEmotionState,
  DEFAULT_EMOTION_DYNAMICS,
  DEFAULT_EMOTION_STATE,
  EmotionStore,
  evolveEmotion,
  isDefaultEmotion,
  isEmotionState,
} from './emotion.js';
import { Heartbeat } from './heartbeat.js';
import { SendLog } from './sends.js';
import {
  PROACTIVE_CHAT_SNAPSHOT_VERSION,
  type EmotionState,
  type HeldStub,
  type ProactiveChatSnapshot,
  type ProactiveDeliveryHandler,
  type ProactivePersistedSession,
} from './types.js';

/** Plugin name used for config lookup and registry identity. */
export const PROACTIVE_CHAT_PLUGIN_NAME = 'proactive-chat';

/** Plugin version. */
export const PROACTIVE_CHAT_PLUGIN_VERSION = '0.2.0';

/** Scheduler task name for the evaluation heartbeat. */
export const PROACTIVE_CHAT_TASK_NAME = 'proactive-chat.heartbeat';

/** `JsonStore` name under which plugin state is persisted. */
export const PROACTIVE_CHAT_STATE_NAME = 'proactive-chat';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate the outer snapshot envelope; inner entries are guarded per-field. */
function isSnapshot(data: unknown): data is ProactiveChatSnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  if (record['version'] !== PROACTIVE_CHAT_SNAPSHOT_VERSION) return false;
  if (!isFiniteNumber(record['savedAt'])) return false;
  const sessions = record['sessions'];
  return typeof sessions === 'object' && sessions !== null && !Array.isArray(sessions);
}

/** Options for {@link ProactiveChatPlugin}. */
export interface ProactiveChatPluginOptions {
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Warning sink for config fields silently replaced by defaults. Defaults to
   * the shared `console.warn`-based {@link ConfigWarnHandler}.
   */
  onWarn?: ConfigWarnHandler;
  /**
   * Optional awaited delivery transport (the HTTP bridge supplies one that POSTs
   * to its callback URL). When present, the plugin awaits it *before* recording
   * a send slot; a rejection emits `proactive:delegate-failed` /
   * `proactive:delivery-failed` and skips the slot so a later tick can retry.
   * When absent, behavior is exactly the event-bus fallback used by non-bridge
   * deployments.
   */
  deliveryHandler?: ProactiveDeliveryHandler;
}

/**
 * Agent-initiated conversation plugin.
 *
 * A heartbeat runs a two-stage gate per candidate session: a deterministic
 * guardrail/score pass ({@link decide}) decides whether to *ask*, and the LLM
 * ({@link generateThought}) decides what to say — or vetoes with `SKIP`.
 *
 * LLM spend is deliberately minimized: guardrails run before any LLM call, and
 * the HOLD band queues a contentless stub until a later tick promotes it.
 */
export class ProactiveChatPlugin implements Plugin {
  readonly name = PROACTIVE_CHAT_PLUGIN_NAME;
  readonly version = PROACTIVE_CHAT_PLUGIN_VERSION;

  #ctx: PluginContext | undefined;
  #config: ProactiveChatConfig | undefined;
  #emotionStore: EmotionStore | undefined;
  #queue: DelayedQueue | undefined;
  #heartbeatModule: Heartbeat | undefined;
  #storage: JsonStore | undefined;
  #unsubscribeMessage: Unsubscribe | undefined;
  #heartbeatTicks = 0;
  #heartbeatRunning = false;
  #stopped = false;
  readonly #sends = new SendLog();
  readonly #nowFn: () => number;
  readonly #onWarn: ConfigWarnHandler | undefined;
  readonly #deliveryHandler: ProactiveDeliveryHandler | undefined;

  constructor(options: ProactiveChatPluginOptions = {}) {
    this.#nowFn = options.now ?? (() => Date.now());
    this.#onWarn = options.onWarn;
    this.#deliveryHandler = options.deliveryHandler;
  }

  /** PluginContext captured at init; `undefined` before init / after teardown. */
  get context(): PluginContext | undefined {
    return this.#ctx;
  }

  /** Resolved configuration in effect; `undefined` before init / after teardown. */
  get config(): ProactiveChatConfig | undefined {
    return this.#config;
  }

  /** Observability hook: stored (un-evolved) emotion state for a session. */
  emotionState(sessionId: string): EmotionState | undefined {
    return this.#emotionStore?.peek(sessionId);
  }

  /** Observability hook: held HOLD-band stubs for a session. */
  heldStubs(sessionId: string): readonly HeldStub[] {
    return this.#queue?.entries(sessionId) ?? [];
  }

  /** Observability hook: tracked proactive send timestamps for a session. */
  sendTimestamps(sessionId: string): readonly number[] {
    return this.#sends.recent(sessionId, this.#nowFn());
  }

  /**
   * Run one heartbeat evaluation immediately (scheduler-independent).
   *
   * Reentrancy-guarded so a manual trigger overlapping a scheduled tick is
   * skipped rather than double-evaluating sessions. Used by the HTTP bridge.
   */
  async runOnce(): Promise<void> {
    await this.#runHeartbeat();
  }

  init(ctx: PluginContext): void {
    this.#stopped = false;
    this.#ctx = ctx;
    this.#storage = ctx.storage;
    this.#heartbeatTicks = 0;
    // Re-init must not leak state from a previous lifecycle: stale send
    // timestamps would otherwise survive teardown→init when the snapshot lacks
    // the session, and a live subscription would double-apply message coupling.
    this.#sends.clear();
    this.#unsubscribeMessage?.();
    this.#unsubscribeMessage = undefined;
    const config = resolveProactiveChatConfig(
      ctx.config['proactiveChat'],
      this.#onWarn ? { onWarn: this.#onWarn } : {},
    );
    this.#config = config;
    this.#emotionStore = new EmotionStore({
      now: this.#nowFn,
      config: config.emotion,
      initialState: DEFAULT_EMOTION_STATE,
    });
    this.#queue = new DelayedQueue({
      maxSize: config.delayedQueue.maxSize,
      maxAgeHours: config.delayedQueue.maxAgeHours,
      now: this.#nowFn,
    });

    // The per-session pipeline lives in its own deep module; the plugin supplies
    // the adapters (clock, stores, outbound send, event bus, persistence, stop
    // flag) and keeps the lifecycle/scheduling concerns.
    const emotionStore = this.#emotionStore;
    const queue = this.#queue;
    this.#heartbeatModule = new Heartbeat({
      config,
      now: this.#nowFn,
      emotion: emotionStore,
      queue,
      sends: {
        recent: (sessionId, atMs) => this.#sends.recent(sessionId, atMs),
        record: (sessionId, atMs) => this.#sends.record(sessionId, atMs),
      },
      llm: ctx.llm,
      bundle: (sessionId, emotion, atMs) =>
        buildContextBundle(ctx.sessions, sessionId, emotion, atMs, {
          historyTailMessages: config.context.historyTailMessages,
        }),
      send: (sessionId, content) => ctx.send(sessionId, content),
      emit: (topic, payload) => {
        ctx.eventBus.emit(topic, payload);
      },
      deliveryHandler: this.#deliveryHandler,
      persist: () => this.#save(),
      isStopped: () => this.#stopped,
    });

    if (config.persistence.enabled) this.#restore();

    // User messages signal presence: excitement rises while the urge to reach
    // out drops. Agent-originated messages deliberately do not couple.
    this.#unsubscribeMessage = ctx.eventBus.on('message:appended', (payload) => {
      this.#handleMessageAppended(payload);
    });

    ctx.scheduler.registerTask({
      name: PROACTIVE_CHAT_TASK_NAME,
      intervalMs: config.heartbeat.intervalMs,
      run: () => this.#runHeartbeat(),
    });
    console.log(`[plugin] registered ${this.name}@${this.version}`);
  }

  teardown(): void {
    // Set before cancelling so an in-flight heartbeat aborts silently.
    this.#stopped = true;
    this.#unsubscribeMessage?.();
    this.#unsubscribeMessage = undefined;
    this.#ctx?.scheduler.cancelTask(PROACTIVE_CHAT_TASK_NAME);
    if (this.#config?.persistence.enabled) this.#save();
    this.#queue?.clear();
    this.#emotionStore?.clear();
    this.#heartbeatModule = undefined;
    this.#sends.clear();
    this.#ctx = undefined;
    this.#config = undefined;
    this.#storage = undefined;
    console.log(`[plugin] stopped ${this.name}@${this.version}`);
  }

  /** Couple a user message to the session's emotion state. */
  #handleMessageAppended(payload: unknown): void {
    const config = this.#config;
    const store = this.#emotionStore;
    if (!config || !store || this.#stopped) return;
    if (typeof payload !== 'object' || payload === null) return;
    const message = (payload as { message?: Message }).message;
    if (message === undefined || message.role !== 'user') return;
    // `get` evolves the stored state to the current clock time first.
    const current = store.get(message.sessionId);
    store.set(
      message.sessionId,
      applyUserMessageCoupling(current, {
        userMessageArousalBump: config.emotion.userMessageArousalBump,
        interactionSocialNeedReset: config.emotion.interactionSocialNeedReset,
      }),
    );
  }

  /**
   * Reentrancy guard shared by the scheduler task and {@link runOnce}: a tick
   * requested while another is in flight is dropped.
   */
  async #runHeartbeat(): Promise<void> {
    if (this.#heartbeatRunning) return;
    this.#heartbeatRunning = true;
    try {
      await this.#heartbeat();
    } finally {
      this.#heartbeatRunning = false;
    }
  }

  /** One heartbeat tick: evaluate every candidate session. */
  async #heartbeat(): Promise<void> {
    const ctx = this.#ctx;
    const config = this.#config;
    if (!ctx || !config) return;
    if (!config.enabled) return;

    const now = this.#nowFn();
    for (const session of ctx.sessions.list()) {
      if (this.#stopped) return;
      await this.#heartbeatModule?.tick(session, now);
    }

    this.#heartbeatTicks += 1;
    const interval = config.persistence.saveIntervalTicks;
    if (config.persistence.enabled && interval > 0 && this.#heartbeatTicks % interval === 0) {
      this.#save();
    }
  }

  /**
   * Restore persisted state, pruning to current rules and evolving emotions
   * forward by the wall-clock gap since the snapshot was taken.
   */
  #restore(): void {
    const storage = this.#storage;
    const store = this.#emotionStore;
    const queue = this.#queue;
    const config = this.#config;
    if (!storage || !store || !queue || !config) return;

    let result: JsonStoreReadResult | undefined;
    try {
      result = storage.read(PROACTIVE_CHAT_STATE_NAME);
    } catch (error) {
      console.warn('[plugin] failed to read proactive-chat state; starting fresh:', error);
      return;
    }
    if (!result) return;
    if (!isSnapshot(result.data)) {
      console.warn('[plugin] proactive-chat state has an unsupported version/shape; starting fresh');
      return;
    }

    const snapshot = result.data;
    const now = this.#nowFn();
    const elapsed = Math.max(0, now - snapshot.savedAt);

    for (const [sessionId, raw] of Object.entries<unknown>(snapshot.sessions)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;

      const savedEmotion = entry['emotion'];
      // Out-of-range/tampered values are rejected by `isEmotionState` and fall
      // back to the pristine default; `clampEmotionState` guards the (currently
      // unreachable) in-range-but-unclamped case as defense in depth.
      const emotion = isEmotionState(savedEmotion)
        ? clampEmotionState(savedEmotion)
        : DEFAULT_EMOTION_STATE;
      store.set(sessionId, evolveEmotion(emotion, elapsed, config.emotion));

      const savedSends = entry['sends'];
      if (Array.isArray(savedSends)) this.#sends.restore(sessionId, savedSends, now);

      const savedQueue = entry['queue'];
      if (Array.isArray(savedQueue)) queue.restore(sessionId, savedQueue);
    }
  }

  /** Snapshot all per-session plugin state. Never throws into the heartbeat. */
  #save(): void {
    const storage = this.#storage;
    const store = this.#emotionStore;
    const queue = this.#queue;
    const config = this.#config;
    const ctx = this.#ctx;
    if (!storage || !store || !queue || !config || !config.persistence.enabled) return;

    try {
      // One clock read drives both the per-session `get()`s and `savedAt`, so a
      // restore evolves from an exactly-consistent baseline.
      const now = this.#nowFn();
      // Prune to sessions that still exist: sessions removed at runtime, or not
      // re-created after a restart (fresh UUIDs), must not be re-persisted.
      const liveIds = ctx
        ? new Set(ctx.sessions.list().map((session) => session.id))
        : undefined;
      const sessions: Record<string, ProactivePersistedSession> = {};
      const ids = new Set<string>([
        ...store.sessions(),
        ...this.#sends.sessionIds(),
        ...queue.sessions(),
      ]);
      for (const sessionId of ids) {
        if (liveIds && !liveIds.has(sessionId)) continue;
        // `get` (not `peek`) evolves the stored state to `now` so the snapshot
        // and its `savedAt` stamp stay consistent for restore.
        const emotion = store.get(sessionId, now);
        const sends = this.#sends.recent(sessionId, now);
        const held = [...queue.entries(sessionId)];
        // Drop entries that carry no signal: a pristine-default emotion with no
        // sends and no held stubs is indistinguishable from a fresh session.
        if (held.length === 0 && sends.length === 0 && isDefaultEmotion(emotion)) continue;
        sessions[sessionId] = { emotion, sends, queue: held };
      }

      const snapshot: ProactiveChatSnapshot = {
        version: PROACTIVE_CHAT_SNAPSHOT_VERSION,
        savedAt: now,
        sessions,
      };
      storage.write(PROACTIVE_CHAT_STATE_NAME, snapshot);
    } catch (error) {
      console.warn('[plugin] failed to persist proactive-chat state:', error);
    }
  }
}

/** Factory used by the runtime bootstrap. */
export function createProactiveChatPlugin(options: ProactiveChatPluginOptions = {}): Plugin {
  return new ProactiveChatPlugin(options);
}

/** Re-exported for consumers that need the default dynamics/state constants. */
export { DEFAULT_EMOTION_DYNAMICS, DEFAULT_EMOTION_STATE };
