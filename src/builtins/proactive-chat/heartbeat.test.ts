/**
 * Unit tests for the extracted per-session heartbeat pipeline.
 *
 * These exercise {@link Heartbeat} directly through its injected seam (clock,
 * emotion store, delayed queue, send log, LLM, bundle, event sink, delivery
 * handler, persistence hook, stop flag) instead of booting the runtime, so the
 * pipeline's ordering invariants are pinned at the module interface. The
 * end-to-end behavior remains covered by the untouched `plugin.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../core/session-manager.js';
import type { Message, Session } from '../../core/types.js';
import type { CompletionRequest, CompletionResult, LLMProvider } from '../../llm/types.js';
import { resolveProactiveChatConfig } from './config.js';
import { buildContextBundle, type ContextBundle } from './context.js';
import { DelayedQueue } from './delayed-queue.js';
import { applyUserMessageCoupling, EmotionStore } from './emotion.js';
import { Heartbeat, type HeartbeatDeps, type HeartbeatEvents } from './heartbeat.js';
import { EMOTION_ASSESSMENT_INSTRUCTION } from './prompts.js';
import type { DecisionBreakdown, EmotionState, HeldStub, ProactiveDeliveryHandler } from './types.js';

/** Local wall-clock timestamp on 2026-01-15, the fixed test day. */
function atLocal(hour: number, minute = 0): number {
  return new Date(2026, 0, 15, hour, minute, 0, 0).getTime();
}

/** Slice with low thresholds: any score in a fitted window generates. */
function generateSlice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: {
      sendThreshold: 0.05,
      holdThreshold: 0.01,
      maxPerHour: 2,
      maxPerDay: 8,
      cooldownMinutes: 30,
      noSendAfterActivityMinutes: 5,
      quietHours: { start: '23:30', end: '07:00' },
    },
    ...overrides,
  };
}

/** Slice with the default 0.6/0.3 thresholds (the HOLD band). */
function holdSlice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** LLM stub: records requests and returns (or defers) controlled completions. */
class StubLlm implements LLMProvider {
  readonly requests: CompletionRequest[] = [];
  readonly complete: (req: CompletionRequest) => Promise<CompletionResult>;

  constructor(
    respond: (req: CompletionRequest) => Promise<CompletionResult> = async () => ({
      content: 'stub thought',
    }),
  ) {
    this.complete = vi.fn(async (req: CompletionRequest) => {
      this.requests.push(req);
      return respond(req);
    });
  }
}

function stubBreakdown(score: number): DecisionBreakdown {
  return {
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
  };
}

function makeStub(sessionId: string, at: number, score: number): HeldStub {
  return { sessionId, enqueuedAt: at, scoreAtEnqueue: score, breakdown: stubBreakdown(score) };
}

interface SentMessage {
  sessionId: string;
  content: string;
}

interface EventRecord {
  topic: string;
  payload: unknown;
}

interface BundleCall {
  sessionId: string;
  emotion: EmotionState;
  now: number;
}

interface HarnessOptions {
  slice?: Record<string, unknown>;
  startMs?: number;
  llm?: StubLlm;
  deliveryHandler?: ProactiveDeliveryHandler;
  /** Replaces the default recording stub bundle (e.g. `() => undefined`). */
  bundle?: HeartbeatDeps['bundle'];
  /** Wires the real `buildContextBundle` + `SessionManager` instead of the stub. */
  realBundle?: boolean;
  /** Replaces the real queue (e.g. to force a rejected enqueue). */
  queueOverride?: HeartbeatDeps['queue'];
  /** Clock advance performed by the default `send` (late-clock assertions). */
  sendClockAdvanceMs?: number;
  /**
   * Clock advance performed by the default delivery handler (late-clock
   * assertions on the delegate path, where the slot is recorded post-handler).
   */
  handlerClockAdvanceMs?: number;
}

interface Harness {
  heartbeat: Heartbeat;
  sessions: SessionManager;
  emotion: EmotionStore;
  queue: DelayedQueue;
  llm: StubLlm;
  clock: { nowMs: number };
  state: { stopped: boolean };
  persisted: { count: number };
  sent: SentMessage[];
  sendLog: Map<string, number[]>;
  events: EventRecord[];
  bundleCalls: BundleCall[];
  tick(session: Session, now: number): Promise<void>;
  userSession(content?: string): Session;
}

const BASE_MS = atLocal(12, 0);

function makeHarness(options: HarnessOptions = {}): Harness {
  const clock = { nowMs: options.startMs ?? BASE_MS };
  const config = resolveProactiveChatConfig(options.slice ?? generateSlice());
  const sessions = new SessionManager({ now: () => clock.nowMs });
  const emotion = new EmotionStore({
    now: () => clock.nowMs,
    config: {
      decayRatePerHour: config.emotion.decayRatePerHour,
      socialNeedGrowthPerHour: config.emotion.socialNeedGrowthPerHour,
      arousalFloor: config.emotion.arousalFloor,
    },
  });
  const queue = new DelayedQueue({
    maxSize: config.delayedQueue.maxSize,
    maxAgeHours: config.delayedQueue.maxAgeHours,
    now: () => clock.nowMs,
  });
  const sendLog = new Map<string, number[]>();
  const llm = options.llm ?? new StubLlm();

  const sent: SentMessage[] = [];
  const events: EventRecord[] = [];
  const bundleCalls: BundleCall[] = [];
  const persisted = { count: 0 };
  const state = { stopped: false };
  const sendAdvanceMs = options.sendClockAdvanceMs ?? 0;

  const deps: HeartbeatDeps = {
    config,
    now: () => clock.nowMs,
    emotion,
    queue: options.queueOverride ?? queue,
    sends: {
      recent: (sessionId) => [...(sendLog.get(sessionId) ?? [])],
      record: (sessionId, at) => {
        sendLog.set(sessionId, [...(sendLog.get(sessionId) ?? []), at]);
      },
    },
    llm,
    bundle:
      options.bundle ??
      (options.realBundle
        ? (sessionId, emotionState, at) =>
            buildContextBundle(sessions, sessionId, emotionState, at, {
              historyTailMessages: config.context.historyTailMessages,
            })
        : (sessionId, emotionState, at) => {
            bundleCalls.push({ sessionId, emotion: emotionState, now: at });
            return {
              sessionId,
              tailMessages: [],
              stimuli: [],
              recentProactive: [],
              emotion: emotionState,
              timeOfDay: 'afternoon',
            } satisfies ContextBundle;
          }),
    send: async (sessionId, content): Promise<Message> => {
      const message: Message = {
        id: `sent-${sent.length + 1}`,
        sessionId,
        role: 'agent',
        content,
        timestamp: clock.nowMs,
      };
      sent.push({ sessionId, content });
      clock.nowMs += sendAdvanceMs;
      return message;
    },
    emit: (topic, payload) => {
      events.push({ topic, payload });
    },
    deliveryHandler:
      options.deliveryHandler ??
      (options.handlerClockAdvanceMs !== undefined
        ? async () => {
            clock.nowMs += options.handlerClockAdvanceMs!;
          }
        : undefined),
    persist: () => {
      persisted.count += 1;
    },
    isStopped: () => state.stopped,
  };

  const heartbeat = new Heartbeat(deps);
  return {
    heartbeat,
    sessions,
    emotion,
    queue,
    llm,
    clock,
    state,
    persisted,
    sent,
    sendLog,
    events,
    bundleCalls,
    tick: async (session, now) => {
      clock.nowMs = now;
      await heartbeat.tick(session, now);
    },
    userSession: (content = 'hello') => {
      const session = sessions.create();
      sessions.appendMessage(session.id, 'user', content);
      return session;
    },
  };
}

function eventsOf<K extends keyof HeartbeatEvents & string>(
  harness: Harness,
  topic: K,
): HeartbeatEvents[K][] {
  return harness.events
    .filter((event) => event.topic === topic)
    .map((event) => event.payload as HeartbeatEvents[K]);
}

describe('Heartbeat (per-session pipeline)', () => {
  it('vetoes a quiet-hours tick before any LLM call, send or persist', async () => {
    const h = makeHarness({ startMs: atLocal(23, 0) });
    const session = h.userSession('goodnight');

    await h.tick(session, atLocal(23, 45));

    expect(h.llm.complete).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    expect(h.sendLog.size).toBe(0);
    expect(h.persisted.count).toBe(0);
    expect(eventsOf(h, 'proactive:skipped')).toEqual([
      { sessionId: session.id, reason: 'quiet_hours' },
    ]);
  });

  it('enqueues a contentless stub on HOLD with zero LLM calls', async () => {
    const h = makeHarness({ slice: holdSlice(), startMs: atLocal(10, 30) });
    const session = h.userSession('hi');

    await h.tick(session, atLocal(18, 30));

    expect(h.llm.complete).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    expect(h.persisted.count).toBe(0);

    const held = eventsOf(h, 'proactive:held');
    expect(held).toHaveLength(1);
    expect(held[0]?.sessionId).toBe(session.id);
    // intensity 0.6 × fitness 1.0 (18:00–22:00) × silence 0.9 (>6h) = 0.54.
    expect(held[0]?.score).toBeCloseTo(0.54, 5);
    expect(held[0]?.queueSize).toBe(1);
    expect(held[0]?.accepted).toBe(true);

    const entries = h.queue.entries(session.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      sessionId: session.id,
      enqueuedAt: atLocal(18, 30),
      scoreAtEnqueue: held[0]?.score,
      breakdown: held[0]?.breakdown,
    });
    expect((entries[0] as { content?: string } | undefined)?.content).toBeUndefined();
  });

  it('promotes one stub per tick and re-enqueues the extras in self mode', async () => {
    const h = makeHarness({ slice: generateSlice() });
    const session = h.userSession('hi');
    h.clock.nowMs = atLocal(12, 20);
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.5));
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.4));

    await h.tick(session, atLocal(12, 30));

    expect(h.sent).toEqual([{ sessionId: session.id, content: 'stub thought' }]);
    expect(eventsOf(h, 'proactive:thought')).toHaveLength(1);
    expect(h.persisted.count).toBe(1);
    // Exactly one delivery: the second promoted stub goes back into the queue.
    expect(h.queue.size(session.id)).toBe(1);
    const [extra] = h.queue.entries(session.id);
    expect(extra?.enqueuedAt).toBe(atLocal(12, 20));
    expect(extra?.scoreAtEnqueue).toBeCloseTo(0.126, 5);
  });

  it('delegates a promoted stub without an LLM call (event-bus fallback path)', async () => {
    const h = makeHarness({ slice: generateSlice({ delivery: { mode: 'delegate' } }) });
    const session = h.userSession('hi');
    h.clock.nowMs = atLocal(12, 20);
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.5));

    const now = atLocal(12, 30);
    await h.tick(session, now);

    expect(h.llm.complete).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    const delegated = eventsOf(h, 'proactive:delegate');
    expect(delegated).toHaveLength(1);
    expect(delegated[0]?.sessionId).toBe(session.id);
    expect(delegated[0]?.directive).toContain('Time since last contact');
    expect(delegated[0]?.directive).toContain(session.id);
    expect(delegated[0]?.score).toBeCloseTo(0.126, 5);
    expect(h.sendLog.get(session.id)).toEqual([now]);
    expect(h.persisted.count).toBe(1);
  });

  it('records the delegate slot at tick now, not a post-handler read', async () => {
    // The handler advances the clock, so a slot taken from a *fresh* read would
    // be `now + 5000`; the delegate slot must come from the tick's `now`. The
    // handler path also replaces the event-bus fallback (no double signaling).
    const h = makeHarness({
      slice: generateSlice({ delivery: { mode: 'delegate' } }),
      handlerClockAdvanceMs: 5000,
    });
    const session = h.userSession('hi');
    h.clock.nowMs = atLocal(12, 20);
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.5));

    const now = atLocal(12, 30);
    await h.tick(session, now);

    expect(h.llm.complete).not.toHaveBeenCalled();
    expect(eventsOf(h, 'proactive:delegate')).toHaveLength(0);
    expect(h.sendLog.get(session.id)).toEqual([now]);
    expect(h.persisted.count).toBe(1);
  });

  it('re-enqueues the extras in delegate mode and still delivers the directive', async () => {
    const h = makeHarness({ slice: generateSlice({ delivery: { mode: 'delegate' } }) });
    const session = h.userSession('hi');
    h.clock.nowMs = atLocal(12, 20);
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.5));
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.4));

    await h.tick(session, atLocal(12, 30));

    // Exactly one delivery: the second promoted stub goes back into the queue
    // BEFORE the directive is emitted.
    expect(eventsOf(h, 'proactive:delegate')).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    expect(h.queue.size(session.id)).toBe(1);
    const [extra] = h.queue.entries(session.id);
    expect(extra?.enqueuedAt).toBe(atLocal(12, 20));
    expect(extra?.scoreAtEnqueue).toBeCloseTo(0.126, 5);
    expect(h.persisted.count).toBe(1);
  });

  it('records the slot and thought timestamp from a fresh clock read after send', async () => {
    const h = makeHarness({ slice: generateSlice(), sendClockAdvanceMs: 5000 });
    const session = h.userSession('hi');
    const tickNow = atLocal(12, 10);

    await h.tick(session, tickNow);

    expect(h.sent).toEqual([{ sessionId: session.id, content: 'stub thought' }]);
    const thoughts = eventsOf(h, 'proactive:thought');
    expect(thoughts).toHaveLength(1);
    // The late read, not the tick's `now` (which would be tickNow).
    expect(thoughts[0]?.timestamp).toBe(tickNow + 5000);
    expect(h.sendLog.get(session.id)).toEqual([tickNow + 5000]);
    expect(h.persisted.count).toBe(1);
  });

  it('delegate delivery failure drops the slot but retains the extra promoted stub', async () => {
    const h = makeHarness({
      slice: generateSlice({ delivery: { mode: 'delegate' } }),
      deliveryHandler: async () => {
        throw new Error('post failed');
      },
    });
    const session = h.userSession('hi');
    h.clock.nowMs = atLocal(12, 20);
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.5));
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.4));

    await h.tick(session, atLocal(12, 30));

    expect(eventsOf(h, 'proactive:delegate-failed')).toEqual([
      { sessionId: session.id, reason: 'post failed' },
    ]);
    expect(eventsOf(h, 'proactive:delegate')).toHaveLength(0);
    expect(h.sendLog.size).toBe(0);
    expect(h.persisted.count).toBe(0);
    // Extras are re-enqueued BEFORE delegating, so a failed transport keeps them.
    expect(h.queue.size(session.id)).toBe(1);
  });

  it('self delivery failure emits delivery-failed and never calls send', async () => {
    const h = makeHarness({
      slice: generateSlice(),
      deliveryHandler: async () => {
        throw new Error('transport down');
      },
    });
    const session = h.userSession('hi');

    await h.tick(session, atLocal(12, 10));

    expect(h.llm.complete).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(0);
    expect(h.sendLog.size).toBe(0);
    expect(h.persisted.count).toBe(0);
    expect(eventsOf(h, 'proactive:thought')).toHaveLength(0);
    expect(eventsOf(h, 'proactive:delivery-failed')).toEqual([
      { sessionId: session.id, reason: 'transport down' },
    ]);
  });

  it('drops the extra promoted stub silently when torn down mid-generation', async () => {
    const pending = deferred<CompletionResult>();
    const h = makeHarness({ slice: generateSlice(), llm: new StubLlm(() => pending.promise) });
    const session = h.userSession('hi');
    h.clock.nowMs = atLocal(12, 20);
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.5));
    h.queue.enqueue(makeStub(session.id, atLocal(12, 20), 0.4));

    const now = atLocal(12, 30);
    h.clock.nowMs = now;
    const tickPromise = h.heartbeat.tick(session, now);
    expect(h.llm.complete).toHaveBeenCalledTimes(1);

    h.state.stopped = true;
    pending.resolve({ content: 'too late' });
    await tickPromise;

    expect(h.sent).toHaveLength(0);
    expect(h.sendLog.size).toBe(0);
    expect(h.persisted.count).toBe(0);
    expect(h.events).toHaveLength(0);
    // The post-await stopped check returns before extras are re-enqueued.
    expect(h.queue.size(session.id)).toBe(0);
  });

  it('records no slot and returns silently when torn down mid-deliveryHandler', async () => {
    const pending = deferred<void>();
    let attempts = 0;
    const h = makeHarness({
      slice: generateSlice({ delivery: { mode: 'delegate' } }),
      deliveryHandler: () => {
        attempts += 1;
        return pending.promise;
      },
    });
    const session = h.userSession('hi');
    const now = atLocal(12, 10);
    h.clock.nowMs = now;
    const tickPromise = h.heartbeat.tick(session, now);
    expect(attempts).toBe(1);

    h.state.stopped = true;
    pending.resolve(undefined);
    await tickPromise;

    expect(h.sendLog.size).toBe(0);
    expect(h.persisted.count).toBe(0);
    expect(h.events).toHaveLength(0);
  });

  it('merges an assessment over a state coupled while the call was in flight', async () => {
    const pending = deferred<CompletionResult>();
    const h = makeHarness({
      slice: holdSlice({ emotion: { useLlmAssessment: true } }),
      llm: new StubLlm(() => pending.promise),
    });
    const session = h.userSession('hello');
    const now = atLocal(12, 30);
    h.clock.nowMs = now;
    const tickPromise = h.heartbeat.tick(session, now);
    expect(h.llm.complete).toHaveBeenCalledTimes(1);

    // Simulate the plugin's `message:appended` coupling arriving mid-flight.
    const coupled = applyUserMessageCoupling(h.emotion.get(session.id, now), {
      userMessageArousalBump: 0.3,
      interactionSocialNeedReset: 0.1,
    });
    h.emotion.set(session.id, coupled);
    expect(coupled).toEqual({ valence: 0.7, arousal: 1, socialNeed: 0.1 });

    pending.resolve({ content: '{"valence":0.9,"arousal":1,"socialNeed":0.9}' });
    await tickPromise;

    // merge(coupled, assessment) = 0.4 × coupled + 0.6 × assessment.
    const stored = h.emotion.peek(session.id);
    expect(stored?.valence).toBeCloseTo(0.82, 5);
    expect(stored?.arousal).toBeCloseTo(1, 5); // 0.92 if the stale snapshot were used
    expect(stored?.socialNeed).toBeCloseTo(0.58, 5); // 0.74 if the stale snapshot were used
  });

  it('builds the assessment bundle from the pre-merge emotion (real bundle)', async () => {
    const h = makeHarness({
      slice: holdSlice({ emotion: { useLlmAssessment: true } }),
      llm: new StubLlm(async () => ({
        content: '{"valence":0.9,"arousal":1,"socialNeed":0.9}',
      })),
      realBundle: true,
    });
    const session = h.userSession('hello');

    await h.tick(session, atLocal(12, 30));

    expect(h.llm.requests).toHaveLength(1);
    const request = h.llm.requests[0];
    expect(request?.system).toBe(EMOTION_ASSESSMENT_INSTRUCTION);
    expect(request?.temperature).toBe(0);
    // The serialized pre-merge state, not the post-merge one.
    const content = request?.messages[0]?.content ?? '';
    expect(content).toContain('valence 0.70, arousal 0.80, social need 0.50');
    expect(content).toContain('user: hello');

    const stored = h.emotion.peek(session.id);
    expect(stored?.valence).toBeCloseTo(0.82, 5);
    expect(stored?.arousal).toBeCloseTo(0.92, 5);
    expect(stored?.socialNeed).toBeCloseTo(0.74, 5);
  });

  it('swallows a rejecting assessment and decides on the evolved state', async () => {
    const h = makeHarness({
      slice: holdSlice({ emotion: { useLlmAssessment: true } }),
      llm: new StubLlm(async () => {
        throw new Error('assess down');
      }),
    });
    const session = h.userSession('hello');
    const now = atLocal(12, 30);
    h.clock.nowMs = now;
    const seeded: EmotionState = { valence: 0.2, arousal: 0.3, socialNeed: 0.4 };
    h.emotion.set(session.id, seeded);

    await expect(h.tick(session, now)).resolves.toBeUndefined();

    expect(h.llm.complete).toHaveBeenCalledTimes(1);
    expect(h.emotion.peek(session.id)).toEqual(seeded);
    // The pipeline continued into the deterministic decision.
    expect(eventsOf(h, 'proactive:skipped')).toEqual([
      { sessionId: session.id, reason: 'below_threshold' },
    ]);
  });

  it('makes no LLM call and creates no emotion entry for a user-less session', async () => {
    const h = makeHarness();
    const session = h.sessions.create();

    await h.tick(session, atLocal(12, 30));

    expect(h.llm.complete).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.emotion.size).toBe(0);
    expect(h.emotion.peek(session.id)).toBeUndefined();
  });

  it('retained below-threshold stubs suppress both the skip event and a fresh hold', async () => {
    const h = makeHarness({ slice: holdSlice(), startMs: atLocal(14, 0) });
    const session = h.userSession('hi');
    h.clock.nowMs = atLocal(22, 0);
    h.queue.enqueue(makeStub(session.id, atLocal(22, 0), 0.5));

    await h.tick(session, atLocal(22, 20));

    // Fresh score 0.27 = SKIP band, but the retained stub short-circuits first.
    expect(h.llm.complete).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
    expect(h.persisted.count).toBe(0);
    const entries = h.queue.entries(session.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.enqueuedAt).toBe(atLocal(22, 0));
    expect(entries[0]?.scoreAtEnqueue).toBeCloseTo(0.27, 5);
  });

  it('reports accepted: false in the held payload when the queue rejects the stub', async () => {
    const enqueued: HeldStub[] = [];
    let attempted = false;
    const queueOverride: HeartbeatDeps['queue'] = {
      rescore: () => ({ promoted: [], expired: [], queued: [] }),
      enqueue: (stub) => {
        enqueued.push(stub);
        attempted = true;
        return false;
      },
      size: () => (attempted ? 3 : 0),
    };
    const h = makeHarness({ slice: holdSlice(), startMs: atLocal(10, 30), queueOverride });
    const session = h.userSession('hi');

    await h.tick(session, atLocal(18, 30));

    expect(h.llm.complete).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    const held = eventsOf(h, 'proactive:held');
    expect(held).toHaveLength(1);
    expect(held[0]?.accepted).toBe(false);
    expect(held[0]?.queueSize).toBe(3);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.enqueuedAt).toBe(atLocal(18, 30));
    expect((enqueued[0] as { content?: string } | undefined)?.content).toBeUndefined();
  });

  it('spends exactly one LLM call (the assessment) in delegate mode', async () => {
    const h = makeHarness({
      slice: generateSlice({
        delivery: { mode: 'delegate' },
        emotion: { useLlmAssessment: true },
      }),
      llm: new StubLlm(async () => ({
        content: '{"valence":0.9,"arousal":0.9,"socialNeed":0.9}',
      })),
    });
    const session = h.userSession('hi');

    await h.tick(session, atLocal(12, 10));

    expect(h.llm.complete).toHaveBeenCalledTimes(1);
    expect(h.llm.requests[0]?.system).toBe(EMOTION_ASSESSMENT_INSTRUCTION);
    const delegated = eventsOf(h, 'proactive:delegate');
    expect(delegated).toHaveLength(1);
    expect(delegated[0]?.sessionId).toBe(session.id);
    expect(h.sent).toHaveLength(0);
  });

  it('short-circuits on an unbuildable bundle without events or sends', async () => {
    const generate = makeHarness({ slice: generateSlice(), bundle: () => undefined });
    const genSession = generate.userSession('hi');

    await generate.tick(genSession, atLocal(12, 10));

    expect(generate.llm.complete).not.toHaveBeenCalled();
    expect(generate.sent).toHaveLength(0);
    expect(generate.events).toHaveLength(0);
    expect(generate.persisted.count).toBe(0);

    const assess = makeHarness({
      slice: holdSlice({ emotion: { useLlmAssessment: true } }),
      bundle: () => undefined,
    });
    const assessSession = assess.userSession('hi');

    await assess.tick(assessSession, atLocal(12, 30));

    expect(assess.llm.complete).not.toHaveBeenCalled();
    // The pipeline continues past the skipped assessment into the decision.
    expect(eventsOf(assess, 'proactive:skipped')).toEqual([
      { sessionId: assessSession.id, reason: 'below_threshold' },
    ]);
  });
});
