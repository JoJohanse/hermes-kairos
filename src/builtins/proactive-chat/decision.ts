/**
 * Deterministic two-stage gate: "should we speak?".
 *
 * Hard guardrails are checked first (each a veto). Otherwise a purely
 * arithmetic score is compared against the send/hold thresholds. No clocks or
 * I/O are read here — every input is a parameter.
 */

import type {
  DecisionBreakdown,
  DecisionOutcome,
  EmotionState,
  GuardrailVeto,
  ProactiveDecisionConfig,
  ProactiveTimeWindow,
} from './types.js';

/** Default time-of-day windows (local clock, minutes since midnight). */
export const DEFAULT_TIME_WINDOWS: readonly ProactiveTimeWindow[] = [
  { startMinute: 7 * 60, endMinute: 9 * 60, fitness: 1.0 },
  { startMinute: 9 * 60, endMinute: 12 * 60, fitness: 0.8 },
  { startMinute: 12 * 60, endMinute: 18 * 60, fitness: 0.7 },
  { startMinute: 18 * 60, endMinute: 22 * 60, fitness: 1.0 },
  { startMinute: 22 * 60, endMinute: 23 * 60 + 30, fitness: 0.5 },
];

/** Silence bands (ms) → score multiplier. */
export const SILENCE_SHORT_MS = 60 * 60_000;
/** Upper bound of the medium silence band; beyond it use the long factor. */
export const SILENCE_MEDIUM_MS = 360 * 60_000;
/** Score multiplier for the short, medium and long silence bands. */
export const SILENCE_FACTORS = { short: 0.3, medium: 0.5, long: 0.9 } as const;

const MINUTES_PER_DAY = 24 * 60;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Parse an `HH:MM` clock string into minutes since midnight, or `undefined`. */
export function parseClockToMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/** Local minutes since midnight for a timestamp. */
export function minutesOfDay(nowMs: number): number {
  const date = new Date(nowMs);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Whether `nowMs` falls inside the quiet-hours window.
 * Supports windows that cross midnight (e.g. `23:30`–`07:00`).
 */
export function isWithinQuietHours(
  nowMs: number,
  quietHours: { start: string; end: string },
): boolean {
  const start = parseClockToMinutes(quietHours.start);
  const end = parseClockToMinutes(quietHours.end);
  if (start === undefined || end === undefined || start === end) return false;
  const minute = minutesOfDay(nowMs);
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

/** Fitness for the current local time, or `0` when no window matches. */
export function timeFitnessAt(nowMs: number, windows: readonly ProactiveTimeWindow[]): number {
  const minute = minutesOfDay(nowMs);
  for (const window of windows) {
    if (minute >= window.startMinute && minute < window.endMinute) return window.fitness;
  }
  return 0;
}

/** Map an idle duration to its silence multiplier. */
export function silenceFactorFor(silenceMs: number): number {
  if (!Number.isFinite(silenceMs)) return SILENCE_FACTORS.long;
  if (silenceMs < SILENCE_SHORT_MS) return SILENCE_FACTORS.short;
  if (silenceMs <= SILENCE_MEDIUM_MS) return SILENCE_FACTORS.medium;
  return SILENCE_FACTORS.long;
}

/** Inputs to {@link decide}. Every value is supplied by the caller. */
export interface DecisionInput {
  emotion: EmotionState;
  /** Current time (ms since epoch). */
  now: number;
  /** Session's last message timestamp (any role), if any. */
  lastMessageAt: number | undefined;
  /** This plugin's last proactive send timestamp for the session, if any. */
  lastProactiveSendAt: number | undefined;
  sentThisHour: number;
  sentToday: number;
  config: ProactiveDecisionConfig;
}

/**
 * Inputs to {@link evaluateGuardrails}. Guardrails are emotion-independent, so
 * callers can cheaply check whether a send is even possible before spending an
 * LLM call on emotion assessment or thought generation.
 */
export type GuardrailInput = Omit<DecisionInput, 'emotion'>;

/** Result of {@link decide}. `veto` non-null implies `outcome === 'skip'`. */
export interface DecisionResult {
  outcome: DecisionOutcome;
  score: number;
  breakdown: DecisionBreakdown;
  veto: GuardrailVeto | null;
}

/**
 * Evaluate the gate for a single session.
 *
 * Guardrails (in order): quiet hours, recent activity, cooldown, hourly cap,
 * daily cap. When none fire, band the score into GENERATE / HOLD / SKIP.
 */
export function decide(input: DecisionInput): DecisionResult {
  const { config, now } = input;
  const windows = config.timeWindows.length > 0 ? config.timeWindows : DEFAULT_TIME_WINDOWS;

  const silenceMs =
    input.lastMessageAt === undefined ? Number.POSITIVE_INFINITY : now - input.lastMessageAt;
  // `socialNeed` is weighted 3×: it is the only signal that keeps growing while
  // a session sits idle, so long-run reachability depends on it.
  const intensity =
    (input.emotion.valence + input.emotion.arousal + 3 * input.emotion.socialNeed) / 5;
  const timeFitness = timeFitnessAt(now, windows);
  const silenceFactor = silenceFactorFor(silenceMs);
  const frequencyLimit = Math.max(0.1, 1 - input.sentThisHour / config.maxPerHour);
  const score = intensity * timeFitness * silenceFactor * frequencyLimit;

  const breakdown: DecisionBreakdown = {
    valence: input.emotion.valence,
    arousal: input.emotion.arousal,
    socialNeed: input.emotion.socialNeed,
    intensity,
    timeFitness,
    silenceFactor,
    frequencyLimit,
    silenceMinutes: Number.isFinite(silenceMs) ? silenceMs / MINUTE_MS : Number.POSITIVE_INFINITY,
    sentThisHour: input.sentThisHour,
    sentToday: input.sentToday,
    score,
  };

  const veto = evaluateGuardrails(input);
  if (veto !== null) {
    return { outcome: 'skip', score, breakdown, veto };
  }

  let outcome: DecisionOutcome;
  if (score >= config.sendThreshold) outcome = 'generate';
  else if (score >= config.holdThreshold) outcome = 'hold';
  else outcome = 'skip';

  return { outcome, score, breakdown, veto: null };
}

/**
 * Check the hard guardrails for a session, in priority order: quiet hours,
 * recent activity, cooldown, hourly cap, daily cap.
 *
 * Guardrails do not depend on the emotion state, so callers can (and the
 * plugin does) run these before any LLM call.
 *
 * @returns the first firing {@link GuardrailVeto}, or `null` when none fire.
 */
export function evaluateGuardrails(input: GuardrailInput): GuardrailVeto | null {
  const { config, now } = input;

  if (isWithinQuietHours(now, config.quietHours)) return 'quiet_hours';

  const noSendMs = config.noSendAfterActivityMinutes * MINUTE_MS;
  if (input.lastMessageAt !== undefined && now - input.lastMessageAt < noSendMs) {
    return 'recent_activity';
  }

  const cooldownMs = config.cooldownMinutes * MINUTE_MS;
  if (input.lastProactiveSendAt !== undefined && now - input.lastProactiveSendAt < cooldownMs) {
    return 'cooldown';
  }

  if (input.sentThisHour >= config.maxPerHour) return 'hourly_cap';
  if (input.sentToday >= config.maxPerDay) return 'daily_cap';

  return null;
}

/** Milliseconds in an hour, re-exported for counter windows. */
export const ONE_HOUR_MS = HOUR_MS;
/** Milliseconds in a day, re-exported for counter windows. */
export const ONE_DAY_MS = MINUTES_PER_DAY * MINUTE_MS;
