import type { Session } from '../../core/types.js';
import type { LLMProvider } from '../../llm/types.js';
import type { Plugin, PluginContext } from '../../plugins/types.js';
import { resolveProactiveChatConfig, type ProactiveChatConfig } from '../../config/config.js';
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
import {
  DEFAULT_EMOTION_DYNAMICS,
  DEFAULT_EMOTION_STATE,
  EmotionStore,
  mergeEmotionAssessment,
  parseEmotionAssessment,
} from './emotion.js';
import { EMOTION_ASSESSMENT_INSTRUCTION } from './prompts.js';
import { generateThought, serializeContext, type ThoughtEngineResult } from './thought-engine.js';
import type { EmotionState, HeldStub, ThoughtCandidate } from './types.js';

/** Plugin name used for config lookup and registry identity. */
export const PROACTIVE_CHAT_PLUGIN_NAME = 'proactive-chat';

/** Plugin version. */
export const PROACTIVE_CHAT_PLUGIN_VERSION = '0.2.0';

/** Scheduler task name for the evaluation heartbeat. */
export const PROACTIVE_CHAT_TASK_NAME = 'proactive-chat.heartbeat';

/** Options for {@link ProactiveChatPlugin}. */
export interface ProactiveChatPluginOptions {
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
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
  #stopped = false;
  readonly #sends = new Map<string, number[]>();
  readonly #nowFn: () => number;

  constructor(options: ProactiveChatPluginOptions = {}) {
    this.#nowFn = options.now ?? (() => Date.now());
  }

  /** PluginContext captured at init; `undefined` before init / after teardown. */
  get context(): PluginContext | undefined {
    return this.#ctx;
  }

  /** Resolved configuration in effect; `undefined` before init / after teardown. */
  get config(): ProactiveChatConfig | undefined {
    return this.#config;
  }

  init(ctx: PluginContext): void {
    this.#stopped = false;
    this.#ctx = ctx;
    this.#config = resolveProactiveChatConfig(ctx.config['proactiveChat']);
    this.#emotionStore = new EmotionStore({
      now: this.#nowFn,
      config: {
        decayRatePerHour: this.#config.emotion.decayRatePerHour,
        socialNeedGrowthPerHour: this.#config.emotion.socialNeedGrowthPerHour,
        arousalFloor: this.#config.emotion.arousalFloor,
      },
      initialState: DEFAULT_EMOTION_STATE,
    });
    this.#queue = new DelayedQueue({
      maxSize: this.#config.delayedQueue.maxSize,
      maxAgeHours: this.#config.delayedQueue.maxAgeHours,
      now: this.#nowFn,
    });

    ctx.scheduler.registerTask({
      name: PROACTIVE_CHAT_TASK_NAME,
      intervalMs: this.#config.heartbeat.intervalMs,
      run: () => this.#heartbeat(),
    });
    console.log(`[plugin] registered ${this.name}@${this.version}`);
  }

  teardown(): void {
    // Set before cancelling so an in-flight heartbeat aborts silently.
    this.#stopped = true;
    this.#ctx?.scheduler.cancelTask(PROACTIVE_CHAT_TASK_NAME);
    this.#queue?.clear();
    this.#emotionStore?.clear();
    this.#sends.clear();
    this.#ctx = undefined;
    this.#config = undefined;
    console.log(`[plugin] stopped ${this.name}@${this.version}`);
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
        emotion = mergeEmotionAssessment(emotion, assessed);
        emotionStore.set(session.id, emotion);
      }
    }

    const decision = decide({ emotion, ...guardrails });

    // 3. Promote held stubs whose fresh score reached the send threshold. This
    //    is the only place HOLD-band work spends an LLM call.
    const rescored = queue.rescore(session.id, () => decision.score, config.decision.sendThreshold);
    if (rescored.promoted.length > 0) {
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

    const result = await this.#tryGenerate(ctx, session, emotion, decision, now);
    if (this.#stopped) return;
    if (result === undefined) return;
    if (result.kind === 'skipped') {
      this.#emitSkipped(ctx, session.id, result.reason);
      return;
    }
    await this.#deliver(ctx, result.candidate);
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
