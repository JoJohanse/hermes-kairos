import type { Unsubscribe } from '../../core/event-bus.js';
import type { JsonStore, JsonStoreReadResult } from '../../core/storage.js';
import type { Message, Session } from '../../core/types.js';
import type { LLMProvider } from '../../llm/types.js';
import type { Plugin, PluginContext } from '../../plugins/types.js';
import {
  resolveProactiveChatConfig,
  type ConfigWarnHandler,
  type ProactiveChatConfig,
} from '../../config/config.js';
import { buildContextBundle, type ContextBundle } from './context.js';
import {
  decide,
  evaluateGuardrails,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  type DecisionResult,
  type GuardrailInput,
} from './decision.js';
import { DelayedQueue } from './delayed-queue.js';
import { buildDelegateDirective } from './delegate.js';
import {
  applyUserMessageCoupling,
  clamp01,
  DEFAULT_EMOTION_DYNAMICS,
  DEFAULT_EMOTION_STATE,
  EmotionStore,
  evolveEmotion,
  mergeEmotionAssessment,
  parseEmotionAssessment,
  type EmotionDynamicsConfig,
} from './emotion.js';
import { EMOTION_ASSESSMENT_INSTRUCTION } from './prompts.js';
import { generateThought, serializeContext, type ThoughtEngineResult } from './thought-engine.js';
import {
  PROACTIVE_CHAT_SNAPSHOT_VERSION,
  type EmotionState,
  type HeldStub,
  type ProactiveChatSnapshot,
  type ProactiveDeliveryMode,
  type ProactivePersistedSession,
  type ThoughtCandidate,
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

/** A finite number inside the closed unit interval `[0, 1]`. */
function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isEmotionState(value: unknown): value is EmotionState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isUnitInterval(record['valence']) &&
    isUnitInterval(record['arousal']) &&
    isUnitInterval(record['socialNeed'])
  );
}

/** Clamp every emotion field into `[0, 1]` (defense in depth on restore). */
function clampEmotionState(state: EmotionState): EmotionState {
  return {
    valence: clamp01(state.valence),
    arousal: clamp01(state.arousal),
    socialNeed: clamp01(state.socialNeed),
  };
}

/** Whether a state is exactly the pristine default (i.e. carries no signal). */
function isDefaultEmotion(state: EmotionState): boolean {
  return (
    state.valence === DEFAULT_EMOTION_STATE.valence &&
    state.arousal === DEFAULT_EMOTION_STATE.arousal &&
    state.socialNeed === DEFAULT_EMOTION_STATE.socialNeed
  );
}

function isHeldStub(value: unknown): value is HeldStub {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['sessionId'] === 'string' &&
    isFiniteNumber(record['enqueuedAt']) &&
    isFiniteNumber(record['scoreAtEnqueue']) &&
    typeof record['breakdown'] === 'object' &&
    record['breakdown'] !== null
  );
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
  #storage: JsonStore | undefined;
  #unsubscribeMessage: Unsubscribe | undefined;
  #heartbeatTicks = 0;
  #heartbeatRunning = false;
  #stopped = false;
  readonly #sends = new Map<string, number[]>();
  readonly #nowFn: () => number;
  readonly #onWarn: ConfigWarnHandler | undefined;

  constructor(options: ProactiveChatPluginOptions = {}) {
    this.#nowFn = options.now ?? (() => Date.now());
    this.#onWarn = options.onWarn;
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
    return this.#sends.get(sessionId) ?? [];
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
    const dynamics: EmotionDynamicsConfig = {
      decayRatePerHour: config.emotion.decayRatePerHour,
      socialNeedGrowthPerHour: config.emotion.socialNeedGrowthPerHour,
      arousalFloor: config.emotion.arousalFloor,
    };
    this.#emotionStore = new EmotionStore({
      now: this.#nowFn,
      config: dynamics,
      initialState: DEFAULT_EMOTION_STATE,
    });
    this.#queue = new DelayedQueue({
      maxSize: config.delayedQueue.maxSize,
      maxAgeHours: config.delayedQueue.maxAgeHours,
      now: this.#nowFn,
    });

    if (config.persistence.enabled) this.#restore(dynamics);

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
      await this.#evaluateSession(ctx, session, now);
    }

    this.#heartbeatTicks += 1;
    const interval = config.persistence.saveIntervalTicks;
    if (config.persistence.enabled && interval > 0 && this.#heartbeatTicks % interval === 0) {
      this.#save();
    }
  }

  async #evaluateSession(ctx: PluginContext, session: Session, now: number): Promise<void> {
    const config = this.#config;
    const emotionStore = this.#emotionStore;
    const queue = this.#queue;
    if (!config || !emotionStore || !queue) return;
    if (!session.messages.some((message) => message.role === 'user')) return;

    // Evolve the in-memory emotion state on every tick — even vetoed ones — so
    // long-run dynamics (growing socialNeed, decaying arousal) accumulate.
    let emotion: EmotionState = emotionStore.get(session.id);

    const sends = this.#recentSends(session.id, now);
    const lastSendAt = sends.length > 0 ? sends[sends.length - 1] : undefined;
    const guardrails: GuardrailInput = {
      now,
      lastMessageAt: session.lastActivityAt,
      lastProactiveSendAt: lastSendAt,
      sentThisHour: sends.filter((at) => now - at < ONE_HOUR_MS).length,
      sentToday: sends.filter((at) => now - at < ONE_DAY_MS).length,
      config: config.decision,
    };

    // 1. Hard guardrails first: a vetoed tick never spends an LLM call.
    const veto = evaluateGuardrails(guardrails);
    if (veto !== null) {
      this.#emitSkipped(ctx, session.id, veto);
      return;
    }

    // 2. Optional LLM emotion assessment, only once guardrails have passed.
    if (config.emotion.useLlmAssessment) {
      const assessed = await this.#assessEmotion(ctx, session, emotion, now);
      if (this.#stopped) return;
      if (assessed) {
        // The user may have messaged while the assessment was in flight, and
        // the message handler couples the *current* stored state. Re-read it so
        // the merge builds on that fresh state instead of the stale pre-await
        // snapshot, which would otherwise clobber the coupling.
        const current = emotionStore.get(session.id);
        emotion = mergeEmotionAssessment(current, assessed);
        emotionStore.set(session.id, emotion);
      }
    }

    const decision = decide({ emotion, ...guardrails });

    // 3. Promote held stubs whose fresh score reached the send threshold. This
    //    is the only place HOLD-band work spends an LLM call.
    const rescored = queue.rescore(session.id, () => decision.score, config.decision.sendThreshold);
    if (rescored.promoted.length > 0) {
      if (this.#deliveryMode() === 'delegate') {
        // Never deliver more than one proactive message per tick.
        for (let i = 1; i < rescored.promoted.length; i += 1) {
          const remaining = rescored.promoted[i];
          if (remaining) queue.enqueue(remaining);
        }
        await this.#delegate(ctx, session, emotion, decision, now);
        return;
      }
      const result = await this.#tryGenerate(ctx, session, emotion, decision, now);
      if (this.#stopped) return;
      // Never deliver more than one proactive message per tick.
      for (let i = 1; i < rescored.promoted.length; i += 1) {
        const remaining = rescored.promoted[i];
        if (remaining) queue.enqueue(remaining);
      }
      if (result === undefined) return;
      if (result.kind === 'skipped') {
        // The stub is dropped (already removed by `rescore`).
        this.#emitSkipped(ctx, session.id, result.reason);
        return;
      }
      await this.#deliver(ctx, result.candidate);
      return;
    }
    if (queue.size(session.id) > 0) return;

    if (decision.outcome === 'skip') {
      this.#emitSkipped(ctx, session.id, 'below_threshold');
      return;
    }

    if (decision.outcome === 'hold') {
      // HOLD must stay LLM-free: queue a contentless stub for a later tick.
      const stub: HeldStub = {
        sessionId: session.id,
        enqueuedAt: now,
        scoreAtEnqueue: decision.score,
        breakdown: decision.breakdown,
      };
      const accepted = queue.enqueue(stub);
      ctx.eventBus.emit('proactive:held', {
        sessionId: session.id,
        score: decision.score,
        breakdown: decision.breakdown,
        queueSize: queue.size(session.id),
        accepted,
      });
      return;
    }

    if (this.#deliveryMode() === 'delegate') {
      await this.#delegate(ctx, session, emotion, decision, now);
      return;
    }

    const result = await this.#tryGenerate(ctx, session, emotion, decision, now);
    if (this.#stopped) return;
    if (result === undefined) return;
    if (result.kind === 'skipped') {
      this.#emitSkipped(ctx, session.id, result.reason);
      return;
    }
    await this.#deliver(ctx, result.candidate);
  }

  /** Configured delivery mode (`self` when uninitialized). */
  #deliveryMode(): ProactiveDeliveryMode {
    return this.#config?.delivery.mode ?? 'self';
  }

  /**
   * Delegate delivery: emit a plain-template directive for an external agent
   * instead of calling the thought engine and `ctx.send`.
   *
   * The outreach still consumes a send slot (timestamp recorded, snapshot saved)
   * so cooldown and hourly/daily caps apply exactly as they do in `self` mode.
   */
  async #delegate(
    ctx: PluginContext,
    session: Session,
    emotion: EmotionState,
    decision: DecisionResult,
    now: number,
  ): Promise<void> {
    if (this.#stopped) return;
    const directive = buildDelegateDirective({
      sessionId: session.id,
      emotion,
      score: decision.score,
      breakdown: decision.breakdown,
      lastContactAt: session.lastActivityAt,
      now,
    });
    ctx.eventBus.emit('proactive:delegate', {
      sessionId: session.id,
      directive,
      score: decision.score,
      breakdown: decision.breakdown,
    });
    const sends = this.#recentSends(session.id, now);
    sends.push(now);
    this.#sends.set(session.id, sends);
    if (this.#config?.persistence.enabled) this.#save();
  }

  /** Build a bundle and ask the LLM for content; `undefined` if unbuildable. */
  async #tryGenerate(
    ctx: PluginContext,
    session: Session,
    emotion: EmotionState,
    decision: DecisionResult,
    now: number,
  ): Promise<ThoughtEngineResult | undefined> {
    const config = this.#config;
    if (!config) return undefined;
    const bundle = buildContextBundle(ctx.sessions, session.id, emotion, now, {
      historyTailMessages: config.context.historyTailMessages,
    });
    if (!bundle) return undefined;
    return generateThought(ctx.llm, {
      sessionId: session.id,
      bundle,
      score: decision.score,
      breakdown: decision.breakdown,
      persona: config.persona,
      now,
    });
  }

  async #deliver(ctx: PluginContext, candidate: ThoughtCandidate): Promise<void> {
    if (this.#stopped) return;
    await ctx.send(candidate.sessionId, candidate.content);
    const now = this.#nowFn();
    const sends = this.#recentSends(candidate.sessionId, now);
    sends.push(now);
    this.#sends.set(candidate.sessionId, sends);
    ctx.eventBus.emit('proactive:thought', {
      sessionId: candidate.sessionId,
      content: candidate.content,
      score: candidate.score,
      breakdown: candidate.breakdown,
      stimuli: candidate.stimuli,
      timestamp: now,
    });
    // Keep cooldown/cap state crash-safe: persist immediately after a send.
    if (this.#config?.persistence.enabled) this.#save();
  }

  async #assessEmotion(
    ctx: PluginContext,
    session: Session,
    emotion: EmotionState,
    now: number,
  ): Promise<EmotionState | undefined> {
    const bundle = buildContextBundle(ctx.sessions, session.id, emotion, now, {
      historyTailMessages: this.#config?.context.historyTailMessages,
    });
    if (!bundle) return undefined;
    return this.#requestEmotionAssessment(ctx.llm, bundle);
  }

  async #requestEmotionAssessment(
    llm: LLMProvider,
    bundle: ContextBundle,
  ): Promise<EmotionState | undefined> {
    try {
      const result = await llm.complete({
        system: EMOTION_ASSESSMENT_INSTRUCTION,
        messages: [{ role: 'user', content: serializeContext(bundle) }],
        temperature: 0,
      });
      return parseEmotionAssessment(result.content);
    } catch {
      return undefined;
    }
  }

  /**
   * Restore persisted state, pruning to current rules and evolving emotions
   * forward by the wall-clock gap since the snapshot was taken.
   */
  #restore(dynamics: EmotionDynamicsConfig): void {
    const storage = this.#storage;
    const store = this.#emotionStore;
    const queue = this.#queue;
    if (!storage || !store || !queue) return;

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
      store.set(sessionId, evolveEmotion(emotion, elapsed, dynamics));

      const savedSends = entry['sends'];
      if (Array.isArray(savedSends)) {
        const sends = savedSends.filter(
          (at): at is number => isFiniteNumber(at) && now - at < ONE_DAY_MS,
        );
        if (sends.length > 0) this.#sends.set(sessionId, sends);
      }

      const savedQueue = entry['queue'];
      if (Array.isArray(savedQueue)) {
        queue.restore(sessionId, savedQueue.filter(isHeldStub));
      }
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
        ...this.#sends.keys(),
        ...queue.sessions(),
      ]);
      for (const sessionId of ids) {
        if (liveIds && !liveIds.has(sessionId)) continue;
        // `get` (not `peek`) evolves the stored state to `now` so the snapshot
        // and its `savedAt` stamp stay consistent for restore.
        const emotion = store.get(sessionId, now);
        const sends = (this.#sends.get(sessionId) ?? []).filter((at) => now - at < ONE_DAY_MS);
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

  /** Send timestamps for a session within the counting window, pruned in place. */
  #recentSends(sessionId: string, now: number): number[] {
    const existing = this.#sends.get(sessionId) ?? [];
    const recent = existing.filter((at) => now - at < ONE_DAY_MS);
    this.#sends.set(sessionId, recent);
    return recent;
  }

  #emitSkipped(ctx: PluginContext, sessionId: string, reason: string): void {
    ctx.eventBus.emit('proactive:skipped', { sessionId, reason });
  }
}

/** Factory used by the runtime bootstrap. */
export function createProactiveChatPlugin(options: ProactiveChatPluginOptions = {}): Plugin {
  return new ProactiveChatPlugin(options);
}

/** Re-exported for consumers that need the default dynamics/state constants. */
export { DEFAULT_EMOTION_DYNAMICS, DEFAULT_EMOTION_STATE };
