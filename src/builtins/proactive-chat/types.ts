/**
 * Shared types for the proactive-chat plugin.
 *
 * This module is intentionally dependency-free: every other module in the
 * plugin (and `src/config/config.ts`) imports its shapes from here so that the
 * pure decision/emotion/queue modules never pull in runtime singletons.
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
  /** `(valence + arousal + socialNeed) / 3`. */
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
  /** When true, a single LLM assessment call is merged into the evolved state. */
  useLlmAssessment: boolean;
}

/** Context-bundle configuration. */
export interface ProactiveContextConfig {
  historyTailMessages: number;
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

/** Payload for the `proactive:held` event. */
export interface ProactiveHeldEvent {
  sessionId: string;
  content: string;
  score: number;
  breakdown: DecisionBreakdown;
  queueSize: number;
  /** Whether the candidate was accepted into the queue. */
  accepted: boolean;
}

/** Payload for the `proactive:skipped` event. */
export interface ProactiveSkippedEvent {
  sessionId: string;
  reason: string;
}
