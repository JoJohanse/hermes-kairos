/**
 * Per-session heartbeat pipeline.
 *
 * A single `tick(session, now)` runs the full evaluation chain for one session:
 * hard guardrail vetoes → optional LLM emotion assessment → deterministic
 * decision → HOLD enqueue / stub promotion / delivery. Everything the pipeline
 * touches (clock, emotion state, queue, send history, LLM, context bundle,
 * outbound send, event emission, persistence, stop flag) arrives through
 * {@link HeartbeatDeps}, so the ordering invariants are testable at this seam
 * without booting the runtime.
 *
 * The caller owns the plugin-level concerns: the `enabled` gate, one shared
 * clock read per tick, session iteration (including the stopped check between
 * sessions) and the reentrancy guard. `tick` deliberately does not guard itself.
 */

import type { Message, Session } from '../../core/types.js';
import type { LLMProvider } from '../../llm/types.js';
import type { ContextBundle } from './context.js';
import {
  decide,
  evaluateGuardrails,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  type DecisionResult,
  type GuardrailInput,
} from './decision.js';
import { buildDelegateDirective } from './delegate.js';
import type { RescoreResult } from './delayed-queue.js';
import { mergeEmotionAssessment, parseEmotionAssessment } from './emotion.js';
import { EMOTION_ASSESSMENT_INSTRUCTION } from './prompts.js';
import { generateThought, serializeContext, type ThoughtEngineResult } from './thought-engine.js';
import type {
  EmotionState,
  HeldStub,
  ProactiveChatResolvedConfig,
  ProactiveDelegateEvent,
  ProactiveDelegateFailedEvent,
  ProactiveDeliveryFailedEvent,
  ProactiveDeliveryHandler,
  ProactiveDeliveryPayload,
  ProactiveHeldEvent,
  ProactiveSkippedEvent,
  ProactiveThoughtEvent,
  ThoughtCandidate,
} from './types.js';

/** Payload types for every event the pipeline can emit. */
export interface HeartbeatEvents {
  'proactive:skipped': ProactiveSkippedEvent;
  'proactive:held': ProactiveHeldEvent;
  'proactive:delegate': ProactiveDelegateEvent;
  'proactive:delegate-failed': ProactiveDelegateFailedEvent;
  'proactive:thought': ProactiveThoughtEvent;
  'proactive:delivery-failed': ProactiveDeliveryFailedEvent;
}

/** Everything one heartbeat pipeline needs; all I/O is injected. */
export interface HeartbeatDeps {
  /** Resolved pipeline configuration. */
  config: ProactiveChatResolvedConfig;
  /** Injectable clock — used for the post-send slot timestamp in self delivery. */
  now: () => number;
  /** Per-session emotion state. Real `EmotionStore` satisfies this structurally. */
  emotion: {
    get(sessionId: string, atMs?: number): EmotionState;
    set(sessionId: string, state: EmotionState): void;
  };
  /** HOLD-band queue. Real `DelayedQueue` satisfies this structurally. */
  queue: {
    rescore(sessionId: string, score: number, sendThreshold: number): RescoreResult;
    enqueue(stub: HeldStub): boolean;
    size(sessionId: string): number;
  };
  /**
   * Proactive send timestamps. `recent` is a MUTATING query: it prunes the
   * stored window in place (mirrors the plugin's `#recentSends` contract).
   */
  sends: {
    recent(sessionId: string, now: number): number[];
    record(sessionId: string, at: number): void;
  };
  /** LLM used for the optional emotion assessment and thought generation. */
  llm: LLMProvider;
  /** Context bundle builder (history tail bound by the plugin). */
  bundle: (sessionId: string, emotion: EmotionState, now: number) => ContextBundle | undefined;
  /** Sanctioned outbound path (`ctx.send`). */
  send: (sessionId: string, content: string) => Promise<Message>;
  /** Emit one of the pipeline's events. */
  emit: <K extends keyof HeartbeatEvents & string>(topic: K, payload: HeartbeatEvents[K]) => void;
  /** Awaited delivery transport; absent means the event-bus fallback. */
  deliveryHandler?: ProactiveDeliveryHandler;
  /** Post-send persistence hook (the plugin no-ops it when persistence is off). */
  persist?: () => void;
  /** Whether the owning plugin has been torn down. */
  isStopped: () => boolean;
}

/**
 * The per-session heartbeat pipeline.
 *
 * Constructed once per plugin init (after the emotion store and queue exist) and
 * discarded on teardown.
 */
export class Heartbeat {
  readonly #deps: HeartbeatDeps;

  constructor(deps: HeartbeatDeps) {
    this.#deps = deps;
  }

  /**
   * Evaluate one session tick: guardrail vetoes → optional LLM emotion
   * assessment → deterministic decision → HOLD/promotion/delivery.
   *
   * The CALLER guarantees no overlapping tick for the same plugin (the plugin's
   * reentrancy guard); `tick` does not guard itself.
   */
  async tick(session: Session, now: number): Promise<void> {
    const { config, queue } = this.#deps;

    // Sessions with no user message are not candidates. This fires before any
    // `emotion.get` so user-less sessions never create an emotion-store entry
    // (the plugin's snapshot prune relies on pristine-default states).
    if (!session.messages.some((message) => message.role === 'user')) return;

    // Evolve the in-memory emotion state on every tick — even vetoed ones — so
    // long-run dynamics (growing socialNeed, decaying arousal) accumulate.
    let emotion: EmotionState = this.#deps.emotion.get(session.id, now);

    const sends = this.#deps.sends.recent(session.id, now);
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
      this.#emitSkipped(session.id, veto);
      return;
    }

    // 2. Optional LLM emotion assessment, only once guardrails have passed.
    if (config.emotion.useLlmAssessment) {
      const assessed = await this.#assessEmotion(session, emotion, now);
      if (this.#deps.isStopped()) return;
      if (assessed) {
        // The user may have messaged while the assessment was in flight, and
        // the message handler couples the *current* stored state. Re-read it so
        // the merge builds on that fresh state instead of the stale pre-await
        // snapshot, which would otherwise clobber the coupling.
        const current = this.#deps.emotion.get(session.id, now);
        emotion = mergeEmotionAssessment(current, assessed);
        this.#deps.emotion.set(session.id, emotion);
      }
    }

    const decision = decide({ emotion, ...guardrails });

    // 3. Promote held stubs whose fresh score reached the send threshold. This
    //    is the only place HOLD-band work spends an LLM call.
    const rescored = queue.rescore(session.id, decision.score, config.decision.sendThreshold);
    if (rescored.promoted.length > 0) {
      // Never deliver more than one proactive message per tick: extras go back.
      const reenqueueExtras = (): void => {
        for (let i = 1; i < rescored.promoted.length; i += 1) {
          const remaining = rescored.promoted[i];
          if (remaining) queue.enqueue(remaining);
        }
      };

      if (config.delivery.mode === 'delegate') {
        reenqueueExtras();
        await this.#delegate(session, emotion, decision, now);
        return;
      }
      const result = await this.#tryGenerate(session, emotion, decision, now);
      if (this.#deps.isStopped()) return;
      reenqueueExtras();
      if (result === undefined) return;
      if (result.kind === 'skipped') {
        // The stub is dropped (already removed by `rescore`).
        this.#emitSkipped(session.id, result.reason);
        return;
      }
      await this.#deliver(result.candidate);
      return;
    }
    if (queue.size(session.id) > 0) return;

    if (decision.outcome === 'skip') {
      this.#emitSkipped(session.id, 'below_threshold');
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
      this.#deps.emit('proactive:held', {
        sessionId: session.id,
        score: decision.score,
        breakdown: decision.breakdown,
        queueSize: queue.size(session.id),
        accepted,
      });
      return;
    }

    if (config.delivery.mode === 'delegate') {
      await this.#delegate(session, emotion, decision, now);
      return;
    }

    const result = await this.#tryGenerate(session, emotion, decision, now);
    if (this.#deps.isStopped()) return;
    if (result === undefined) return;
    if (result.kind === 'skipped') {
      this.#emitSkipped(session.id, result.reason);
      return;
    }
    await this.#deliver(result.candidate);
  }

  /**
   * Delegate delivery: emit a plain-template directive for an external agent
   * instead of calling the thought engine and `ctx.send`.
   *
   * The outreach still consumes a send slot (timestamp recorded, snapshot saved)
   * so cooldown and hourly/daily caps apply exactly as they do in `self` mode.
   */
  async #delegate(
    session: Session,
    emotion: EmotionState,
    decision: DecisionResult,
    now: number,
  ): Promise<void> {
    if (this.#deps.isStopped()) return;
    const directive = buildDelegateDirective({
      sessionId: session.id,
      emotion,
      score: decision.score,
      breakdown: decision.breakdown,
      lastContactAt: session.lastActivityAt,
      now,
    });

    if (this.#deps.deliveryHandler) {
      // Awaited transport: only record the send slot once delivery succeeded, so
      // a failed POST leaves cooldown/cap state untouched and the next tick
      // retries instead of silently dropping the outreach.
      const payload: ProactiveDeliveryPayload = {
        kind: 'inject',
        sessionId: session.id,
        directive,
        score: decision.score,
        breakdown: decision.breakdown,
      };
      try {
        await this.#deps.deliveryHandler(payload);
      } catch (error) {
        this.#deps.emit('proactive:delegate-failed', {
          sessionId: session.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (this.#deps.isStopped()) return;
    } else {
      // Event-bus fallback for non-bridge deployments.
      this.#deps.emit('proactive:delegate', {
        sessionId: session.id,
        directive,
        score: decision.score,
        breakdown: decision.breakdown,
      });
    }

    this.#deps.sends.record(session.id, now);
    this.#deps.persist?.();
  }

  /** Build a bundle and ask the LLM for content; `undefined` if unbuildable. */
  async #tryGenerate(
    session: Session,
    emotion: EmotionState,
    decision: DecisionResult,
    now: number,
  ): Promise<ThoughtEngineResult | undefined> {
    const bundle = this.#deps.bundle(session.id, emotion, now);
    if (!bundle) return undefined;
    return generateThought(this.#deps.llm, {
      sessionId: session.id,
      bundle,
      score: decision.score,
      breakdown: decision.breakdown,
      persona: this.#deps.config.persona,
      now,
    });
  }

  async #deliver(candidate: ThoughtCandidate): Promise<void> {
    if (this.#deps.isStopped()) return;
    if (this.#deps.deliveryHandler) {
      // `self`/verbatim bridge delivery: await the outbound transport first so a
      // rejection skips the send slot (and the local `ctx.send`) entirely.
      const payload: ProactiveDeliveryPayload = {
        kind: 'send',
        sessionId: candidate.sessionId,
        content: candidate.content,
        score: candidate.score,
        breakdown: candidate.breakdown,
      };
      try {
        await this.#deps.deliveryHandler(payload);
      } catch (error) {
        this.#deps.emit('proactive:delivery-failed', {
          sessionId: candidate.sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (this.#deps.isStopped()) return;
    }
    await this.#deps.send(candidate.sessionId, candidate.content);
    const now = this.#deps.now();
    this.#deps.sends.record(candidate.sessionId, now);
    this.#deps.emit('proactive:thought', {
      sessionId: candidate.sessionId,
      content: candidate.content,
      score: candidate.score,
      breakdown: candidate.breakdown,
      stimuli: candidate.stimuli,
      timestamp: now,
    });
    // Keep cooldown/cap state crash-safe: persist immediately after a send.
    this.#deps.persist?.();
  }

  async #assessEmotion(
    session: Session,
    emotion: EmotionState,
    now: number,
  ): Promise<EmotionState | undefined> {
    const bundle = this.#deps.bundle(session.id, emotion, now);
    if (!bundle) return undefined;
    return this.#requestEmotionAssessment(bundle);
  }

  async #requestEmotionAssessment(bundle: ContextBundle): Promise<EmotionState | undefined> {
    try {
      const result = await this.#deps.llm.complete({
        system: EMOTION_ASSESSMENT_INSTRUCTION,
        messages: [{ role: 'user', content: serializeContext(bundle) }],
        temperature: 0,
      });
      return parseEmotionAssessment(result.content);
    } catch {
      return undefined;
    }
  }

  #emitSkipped(sessionId: string, reason: string): void {
    this.#deps.emit('proactive:skipped', { sessionId, reason });
  }
}
