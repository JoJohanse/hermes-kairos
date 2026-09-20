import { describe, expect, it } from 'vitest';
import { DEFAULT_PROACTIVE_CHAT } from '../../config/config.js';
import {
  decide,
  evaluateGuardrails,
  isWithinQuietHours,
  parseClockToMinutes,
  silenceFactorFor,
  timeFitnessAt,
  DEFAULT_TIME_WINDOWS,
} from './decision.js';
import type { DecisionInput } from './decision.js';
import { DEFAULT_EMOTION_DYNAMICS, DEFAULT_EMOTION_STATE, evolveEmotion } from './emotion.js';
import type { EmotionState, ProactiveDecisionConfig } from './types.js';

const HOUR_MS = 3_600_000;

const CONFIG: ProactiveDecisionConfig = { ...DEFAULT_PROACTIVE_CHAT.decision };

/** Local timestamp on 2026-01-15 at the given hour/minute. */
function at(hour: number, minute = 0): number {
  return new Date(2026, 0, 15, hour, minute, 0, 0).getTime();
}

const FULL_INTENSITY: EmotionState = { valence: 1, arousal: 1, socialNeed: 1 };

function makeInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    emotion: FULL_INTENSITY,
    now: at(10, 0),
    // 7 hours of silence → long-silence factor (0.9).
    lastMessageAt: at(3, 0),
    lastProactiveSendAt: undefined,
    sentThisHour: 0,
    sentToday: 0,
    config: CONFIG,
    ...overrides,
  };
}

describe('decide – score math', () => {
  it('multiplies intensity, time fitness, silence and frequency factors', () => {
    const result = decide(makeInput());

    expect(result.veto).toBeNull();
    expect(result.breakdown.intensity).toBeCloseTo(1);
    expect(result.breakdown.timeFitness).toBeCloseTo(0.8);
    expect(result.breakdown.silenceFactor).toBeCloseTo(0.9);
    expect(result.breakdown.frequencyLimit).toBeCloseTo(1);
    expect(result.breakdown.score).toBeCloseTo(0.72);
    expect(result.score).toBeCloseTo(0.72);
  });

  it('weights socialNeed 3x when computing intensity', () => {
    const result = decide(
      makeInput({ emotion: { valence: 0.3, arousal: 0.6, socialNeed: 0.9 } }),
    );
    // (0.3 + 0.6 + 3 * 0.9) / 5 = 0.72
    expect(result.breakdown.intensity).toBeCloseTo(0.72);
  });

  it.each([
    [8, 1.0],
    [10, 0.8],
    [15, 0.7],
    [20, 1.0],
    [23, 0.5],
    [2, 0],
  ])('applies the time-of-day fitness for %i:00', (hour, expected) => {
    const result = decide(makeInput({ now: at(hour, 0) }));
    expect(result.breakdown.timeFitness).toBeCloseTo(expected);
  });

  it('applies silence bands at their boundaries', () => {
    expect(silenceFactorFor(30 * 60_000)).toBeCloseTo(0.3);
    expect(silenceFactorFor(359 * 60_000)).toBeCloseTo(0.5);
    expect(silenceFactorFor(360 * 60_000)).toBeCloseTo(0.5);
    expect(silenceFactorFor(361 * 60_000)).toBeCloseTo(0.9);
  });

  it('discounts the frequency limit as sends accumulate', () => {
    expect(decide(makeInput({ sentThisHour: 1 })).breakdown.frequencyLimit).toBeCloseTo(0.5);
    expect(decide(makeInput({ sentThisHour: 5 })).breakdown.frequencyLimit).toBeCloseTo(0.1);
  });

  it('scales silence factor from the last message of any role', () => {
    const now = at(10, 0);
    expect(decide(makeInput({ now, lastMessageAt: now - 30 * 60_000 })).breakdown.silenceFactor).toBeCloseTo(0.3);
    expect(decide(makeInput({ now, lastMessageAt: now - 2 * 3_600_000 })).breakdown.silenceFactor).toBeCloseTo(0.5);
    expect(decide(makeInput({ now, lastMessageAt: now - 7 * 3_600_000 })).breakdown.silenceFactor).toBeCloseTo(0.9);
  });
});

describe('decide – guardrails', () => {
  it('vetoes quiet hours including windows that cross midnight', () => {
    expect(decide(makeInput({ now: at(23, 45) })).veto).toBe('quiet_hours');
    expect(decide(makeInput({ now: at(2, 0) })).veto).toBe('quiet_hours');
    expect(decide(makeInput({ now: at(7, 0) })).veto).toBeNull();
    expect(decide(makeInput({ now: at(7, 30) })).veto).toBeNull();
    expect(decide(makeInput({ now: at(23, 0) })).veto).toBeNull();
  });

  it('vetoes recent activity within noSendAfterActivityMinutes', () => {
    const now = at(10, 0);
    expect(decide(makeInput({ now, lastMessageAt: now - 4 * 60_000 })).veto).toBe('recent_activity');
    expect(decide(makeInput({ now, lastMessageAt: now - 5 * 60_000 })).veto).toBeNull();
  });

  it('vetoes within the cooldown after a proactive send', () => {
    const now = at(10, 0);
    expect(decide(makeInput({ now, lastProactiveSendAt: now - 29 * 60_000 })).veto).toBe('cooldown');
    expect(decide(makeInput({ now, lastProactiveSendAt: now - 30 * 60_000 })).veto).toBeNull();
  });

  it('vetoes at the hourly cap', () => {
    expect(decide(makeInput({ sentThisHour: CONFIG.maxPerHour })).veto).toBe('hourly_cap');
  });

  it('vetoes at the daily cap', () => {
    expect(decide(makeInput({ sentThisHour: 0, sentToday: CONFIG.maxPerDay })).veto).toBe(
      'daily_cap',
    );
  });

  it('reports the first guardrail that fires', () => {
    const now = at(23, 45);
    const result = decide(
      makeInput({ now, lastMessageAt: now - 60_000, sentToday: CONFIG.maxPerDay }),
    );
    expect(result.veto).toBe('quiet_hours');
    expect(result.outcome).toBe('skip');
  });

  it('still reports a breakdown when vetoed', () => {
    const result = decide(makeInput({ now: at(23, 45) }));
    expect(result.outcome).toBe('skip');
    expect(result.breakdown.intensity).toBeCloseTo(1);
    expect(result.breakdown.score).toBeGreaterThanOrEqual(0);
  });
});

describe('decide – threshold banding', () => {
  // intensity 1 × timeFitness 1.0 (08:00) × silence 0.5 (2h) × frequency 1 = 0.5
  const bandInput = (config: ProactiveDecisionConfig): DecisionInput =>
    makeInput({ now: at(8, 0), lastMessageAt: at(6, 0), config });

  it('returns GENERATE at or above sendThreshold', () => {
    const result = decide(bandInput({ ...CONFIG, sendThreshold: 0.5, holdThreshold: 0.3 }));
    expect(result.score).toBeCloseTo(0.5);
    expect(result.outcome).toBe('generate');
  });

  it('returns HOLD between holdThreshold and sendThreshold', () => {
    const result = decide(bandInput({ ...CONFIG, sendThreshold: 0.51, holdThreshold: 0.5 }));
    expect(result.outcome).toBe('hold');
  });

  it('returns SKIP below holdThreshold', () => {
    const result = decide(bandInput({ ...CONFIG, sendThreshold: 0.51, holdThreshold: 0.51 }));
    expect(result.outcome).toBe('skip');
  });

  it('banded HOLD/SKIP results have no veto', () => {
    const result = decide(bandInput({ ...CONFIG, sendThreshold: 0.51, holdThreshold: 0.5 }));
    expect(result.veto).toBeNull();
  });
});

describe('decide – long-run reachability (F3b)', () => {
  it('generates for a session idle 48h at an 18:30 tick with default config', () => {
    const now = at(18, 30);
    const emotion = evolveEmotion(
      DEFAULT_EMOTION_STATE,
      48 * HOUR_MS,
      DEFAULT_EMOTION_DYNAMICS,
    );
    const result = decide(makeInput({ now, lastMessageAt: now - 48 * HOUR_MS, emotion }));

    expect(result.veto).toBeNull();
    expect(result.outcome).toBe('generate');
  });

  it('keeps the long-run score ceiling at least 0.05 above the send threshold', () => {
    const now = at(18, 30);
    const longRun: EmotionState = { valence: 0.5, arousal: 0.2, socialNeed: 1 };
    const result = decide(makeInput({ now, lastMessageAt: now - 48 * HOUR_MS, emotion: longRun }));

    expect(result.score - CONFIG.sendThreshold).toBeGreaterThanOrEqual(0.05);
  });

  it('evaluateGuardrails vetoes without requiring an emotion state', () => {
    const now = at(23, 45);
    expect(
      evaluateGuardrails({
        now,
        lastMessageAt: now - 60_000,
        lastProactiveSendAt: undefined,
        sentThisHour: 0,
        sentToday: 0,
        config: CONFIG,
      }),
    ).toBe('quiet_hours');
  });
});

describe('clock helpers', () => {
  it('parses valid HH:MM strings and rejects malformed ones', () => {
    expect(parseClockToMinutes('23:30')).toBe(1410);
    expect(parseClockToMinutes('07:00')).toBe(420);
    expect(parseClockToMinutes('7:05')).toBe(425);
    expect(parseClockToMinutes('24:00')).toBeUndefined();
    expect(parseClockToMinutes('nope')).toBeUndefined();
  });

  it('handles quiet windows that wrap around midnight', () => {
    const quiet = { start: '23:30', end: '07:00' };
    expect(isWithinQuietHours(at(23, 29), quiet)).toBe(false);
    expect(isWithinQuietHours(at(23, 30), quiet)).toBe(true);
    expect(isWithinQuietHours(at(0, 0), quiet)).toBe(true);
    expect(isWithinQuietHours(at(6, 59), quiet)).toBe(true);
    expect(isWithinQuietHours(at(7, 0), quiet)).toBe(false);
  });

  it('handles non-wrapping quiet windows', () => {
    const quiet = { start: '13:00', end: '14:00' };
    expect(isWithinQuietHours(at(13, 30), quiet)).toBe(true);
    expect(isWithinQuietHours(at(12, 59), quiet)).toBe(false);
    expect(isWithinQuietHours(at(14, 0), quiet)).toBe(false);
  });

  it('returns zero fitness outside every configured window', () => {
    expect(timeFitnessAt(at(3, 0), DEFAULT_TIME_WINDOWS)).toBe(0);
    expect(timeFitnessAt(at(8, 0), DEFAULT_TIME_WINDOWS)).toBeCloseTo(1);
  });
});
