/**
 * Shared types for the proactive-chat plugin.
 *
 * This module is intentionally dependency-free: every other module in the
 * plugin imports its shapes from here so that the pure decision/emotion/queue
 * modules never pull in runtime singletons. The kernel does not import these
 * shapes: the plugin owns its config slice end-to-end (see `config.ts`).
 */

/** Per-session emotional state driving the deterministic interest score. */
export interface EmotionState {
  /** Pleasantness in `[0, 1]`; regresses toward `0.5` over time. */
  valence: number;
  /** Activation in `[0, 1]`; decays exponentially over time. */
  arousal: number;
  /** Unmet social desire in `[0, 1]`; grows with elapsed time. */
  socialNeed: number;
}

/** Outcome of the deterministic two-stage gate. */
export type DecisionOutcome = 'generate' | 'hold' | 'skip';

/** Hard guardrail that vetoed a proactive send. */
export type GuardrailVeto =
  | 'quiet_hours'
  | 'recent_activity'
  | 'cooldown'
  | 'hourly_cap'
  | 'daily_cap';

/** Every factor that contributed to (or vetoed) a decision, for observability. */
export interface DecisionBreakdown {
  valence: number;
  arousal: number;
  socialNeed: number;
  /** `(valence + arousal + 3 * socialNeed) / 5`. */
  intensity: number;
  /** Fitness of the current local time-of-day window. */
  timeFitness: number;
  /** `0.3` / `0.5` / `0.9` for short / medium / long silence. */
  silenceFactor: number;
  /** `max(0.1, 1 - sentThisHour / maxPerHour)`. */
  frequencyLimit: number;
  /** Minutes since the session's last message of any role. */
  silenceMinutes: number;
  sentThisHour: number;
  sentToday: number;
  /** Product of the four factors above. */
  score: number;
}

/**
 * A lightweight HOLD-band placeholder held in the delayed queue.
 *
 * Stubs deliberately carry no content: the HOLD band never spends an LLM call.
 * Content is generated only after a later tick promotes the stub to the send
 * threshold (see {@link ThoughtCandidate}).
 */
export interface HeldStub {
  sessionId: string;
  /** Time the stub was first enqueued (ms since epoch). */
  enqueuedAt: number;
  /** Most recently observed score (initialized at enqueue, refreshed on re-score). */
  scoreAtEnqueue: number;
  breakdown: DecisionBreakdown;
}

/** A generated, not-yet-sent (or just-sent) proactive thought. */
export interface ThoughtCandidate {
  sessionId: string;
  content: string;
  score: number;
  breakdown: DecisionBreakdown;
  /** Ids of the transcript messages fed to the LLM (provenance). */
  stimuli: string[];
  createdAt: number;
}

/** A local time-of-day window and its fitness weight. */
export interface ProactiveTimeWindow {
  /** Window start, minutes since local midnight (`0`-`1440`). */
  startMinute: number;
  /** Window end, minutes since local midnight (`0`-`1440`). */
  endMinute: number;
  /** Multiplier applied to the score inside this window. */
  fitness: number;
}

/** Quiet-hours window as `HH:MM` local clock strings. */
export interface ProactiveQuietHours {
  start: string;
  end: string;
}

/** Deterministic gate configuration. */
export interface ProactiveDecisionConfig {
  sendThreshold: number;
  holdThreshold: number;
  maxPerHour: number;
  maxPerDay: number;
  cooldownMinutes: number;
  noSendAfterActivityMinutes: number;
  quietHours: ProactiveQuietHours;
  /** Ordered time-of-day windows; unmatched times score `0`. */
  timeWindows: ProactiveTimeWindow[];
}

/** Emotion dynamics configuration. */
export interface ProactiveEmotionConfig {
  decayRatePerHour: number;
  socialNeedGrowthPerHour: number;
  /**
   * Floor below which `arousal` never decays, keeping long idle sessions
   * reachable instead of fading to zero.
   */
  arousalFloor: number;
  /** When true, a single LLM assessment call is merged into the evolved state. */
  useLlmAssessment: boolean;
  /** `arousal` boost applied when the user messages the agent. */
  userMessageArousalBump: number;
  /** `socialNeed` is capped to this value when the user messages the agent. */
  interactionSocialNeedReset: number;
}

/** Plugin-state persistence configuration. */
export interface ProactivePersistenceConfig {
  /** When false, plugin state is neither loaded nor saved. */
  enabled: boolean;
  /** Heartbeats between periodic saves (in addition to teardown/deliver saves). */
  saveIntervalTicks: number;
}

/** Context-bundle configuration. */
export interface ProactiveContextConfig {
  historyTailMessages: number;
}

/**
 * Who owns content generation for a proactive outreach.
 *
 * - `self`: this plugin asks the thought-engine LLM for content and delivers it
 *   via `ctx.send` (the original, and default, behavior).
 * - `delegate`: the plugin decides *whether* to reach out and emits a directive
 *   for an external agent (e.g. the hermes-agent bridge) to compose and speak
 *   the message itself. No thought-engine LLM call and no `ctx.send`.
 */
export type ProactiveDeliveryMode = 'self' | 'delegate';

/** Delivery-mode configuration. */
export interface ProactiveDeliveryConfig {
  mode: ProactiveDeliveryMode;
}

/** Delayed (held) candidate queue configuration. */
export interface ProactiveDelayedQueueConfig {
  maxSize: number;
  maxAgeHours: number;
}

/** Persona configuration for the thought-generation prompt. */
export interface ProactivePersonaConfig {
  systemPrompt: string;
}

/** Heartbeat scheduling configuration. */
export interface ProactiveHeartbeatConfig {
  intervalMs: number;
}

/** Fully resolved proactive-chat configuration. */
export interface ProactiveChatResolvedConfig {
  enabled: boolean;
  heartbeat: ProactiveHeartbeatConfig;
  decision: ProactiveDecisionConfig;
  emotion: ProactiveEmotionConfig;
  context: ProactiveContextConfig;
  delayedQueue: ProactiveDelayedQueueConfig;
  persona: ProactivePersonaConfig;
  persistence: ProactivePersistenceConfig;
  delivery: ProactiveDeliveryConfig;
}

/** Payload for the `proactive:thought` event (emitted when a thought is sent). */
export interface ProactiveThoughtEvent {
  sessionId: string;
  content: string;
  score: number;
  breakdown: DecisionBreakdown;
  stimuli: string[];
  timestamp: number;
}

/**
 * Payload for the `proactive:delegate` event (delivery mode `delegate`).
 *
 * Emitted instead of `proactive:thought` when the plugin has decided to reach
 * out but delegates composition/delivery to an external agent: `directive` is a
 * plain-template instruction (no LLM) the delegate uses to author the message.
 */
export interface ProactiveDelegateEvent {
  sessionId: string;
  directive: string;
  score: number;
  breakdown: DecisionBreakdown;
}

/**
 * Payload for the `proactive:held` event.
 *
 * No `content` is included: HOLD-band stubs are queued without an LLM call, so
 * there is nothing generated yet.
 */
export interface ProactiveHeldEvent {
  sessionId: string;
  score: number;
  breakdown: DecisionBreakdown;
  queueSize: number;
  /** Whether the stub was accepted into the queue. */
  accepted: boolean;
}

/** Payload for the `proactive:skipped` event. */
export interface ProactiveSkippedEvent {
  sessionId: string;
  reason: string;
}

/** Payload for the `proactive:delegate-failed` event (delegate delivery rejected). */
export interface ProactiveDelegateFailedEvent {
  sessionId: string;
  reason: string;
}

/** Payload for the `proactive:delivery-failed` event (`self` delivery rejected). */
export interface ProactiveDeliveryFailedEvent {
  sessionId: string;
  reason: string;
}

/**
 * Delivery payload handed to a {@link ProactiveDeliveryHandler}.
 *
 * `inject` carries the delegate directive (external agent composes the message);
 * `send` carries plugin-generated content (`self`/verbatim mode). `breakdown` is
 * intentionally `unknown` so the plugin stays decoupled from transport shapes;
 * bridge consumers can re-narrow it.
 */
export interface ProactiveDeliveryPayload {
  kind: 'inject' | 'send';
  sessionId: string;
  directive?: string;
  content?: string;
  score: number;
  breakdown: unknown;
}

/**
 * Awaited delivery transport. The bridge injects one that POSTs to its callback
 * URL. When it rejects, the plugin surfaces `*-failed` and does **not** record a
 * send slot, so the next tick can retry.
 */
export type ProactiveDeliveryHandler = (payload: ProactiveDeliveryPayload) => Promise<void>;

/** Current schema version for {@link ProactiveChatSnapshot}. */
export const PROACTIVE_CHAT_SNAPSHOT_VERSION = 1;

/** Persisted per-session plugin state. */
export interface ProactivePersistedSession {
  /** Emotion state as stored (not yet evolved to reload time). */
  emotion: EmotionState;
  /** Proactive send timestamps (ms since epoch). */
  sends: number[];
  /** Held HOLD-band stubs. */
  queue: HeldStub[];
}

/**
 * On-disk snapshot of all proactive-chat per-session state.
 *
 * Written by `JsonStore` under `<dataDir>/proactive-chat.json`. On restore the
 * plugin prunes time-sensitive entries and evolves emotions forward by the
 * wall-clock gap since `savedAt`.
 */
export interface ProactiveChatSnapshot {
  version: typeof PROACTIVE_CHAT_SNAPSHOT_VERSION;
  /** Wall-clock time the snapshot was taken (ms since epoch). */
  savedAt: number;
  sessions: Record<string, ProactivePersistedSession>;
}
