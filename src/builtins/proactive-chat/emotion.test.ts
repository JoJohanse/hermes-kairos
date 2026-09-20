import { describe, expect, it } from 'vitest';
import {
  applyUserMessageCoupling,
  DEFAULT_EMOTION_DYNAMICS,
  DEFAULT_EMOTION_STATE,
  EmotionStore,
  clamp01,
  evolveEmotion,
  mergeEmotionAssessment,
  parseEmotionAssessment,
  type UserMessageCouplingConfig,
} from './emotion.js';

const HOUR = 3_600_000;

describe('evolveEmotion', () => {
  it('grows socialNeed linearly with elapsed hours', () => {
    const evolved = evolveEmotion(
      { valence: 0.5, arousal: 0.5, socialNeed: 0 },
      3 * HOUR,
      DEFAULT_EMOTION_DYNAMICS,
    );
    expect(evolved.socialNeed).toBeCloseTo(0.6);
  });

  it('caps socialNeed at 1', () => {
    const evolved = evolveEmotion(
      { valence: 0.5, arousal: 0.5, socialNeed: 0.9 },
      10 * HOUR,
      DEFAULT_EMOTION_DYNAMICS,
    );
    expect(evolved.socialNeed).toBe(1);
  });

  it('decays arousal exponentially', () => {
    const evolved = evolveEmotion(
      { valence: 0.5, arousal: 1, socialNeed: 0.5 },
      5 * HOUR,
      { decayRatePerHour: 0.1, socialNeedGrowthPerHour: 0, arousalFloor: 0 },
    );
    expect(evolved.arousal).toBeCloseTo(Math.exp(-0.5));
  });

  it('decays arousal toward the configured floor and never below it', () => {
    const config = { decayRatePerHour: 0.1, socialNeedGrowthPerHour: 0, arousalFloor: 0.2 };
    const mid = evolveEmotion({ valence: 0.5, arousal: 1, socialNeed: 0.5 }, 5 * HOUR, config);
    expect(mid.arousal).toBeCloseTo(0.2 + 0.8 * Math.exp(-0.5));

    const longRun = evolveEmotion({ valence: 0.5, arousal: 1, socialNeed: 0.5 }, 500 * HOUR, config);
    expect(longRun.arousal).toBeGreaterThanOrEqual(0.2);
    expect(longRun.arousal).toBeCloseTo(0.2);
  });

  it('regresses valence toward the 0.5 baseline from above and below', () => {
    const high = evolveEmotion(
      { valence: 1, arousal: 0.5, socialNeed: 0.5 },
      5 * HOUR,
      { decayRatePerHour: 0.1, socialNeedGrowthPerHour: 0, arousalFloor: 0 },
    );
    const low = evolveEmotion(
      { valence: 0, arousal: 0.5, socialNeed: 0.5 },
      5 * HOUR,
      { decayRatePerHour: 0.1, socialNeedGrowthPerHour: 0, arousalFloor: 0 },
    );
    expect(high.valence).toBeCloseTo(0.5 + 0.5 * Math.exp(-0.5));
    expect(low.valence).toBeCloseTo(0.5 - 0.5 * Math.exp(-0.5));
  });

  it('is a no-op for zero or negative elapsed time', () => {
    const state = { valence: 0.8, arousal: 0.4, socialNeed: 0.2 };
    expect(evolveEmotion(state, 0, DEFAULT_EMOTION_DYNAMICS)).toEqual(state);
    const negative = evolveEmotion(state, -5 * HOUR, DEFAULT_EMOTION_DYNAMICS);
    expect(negative).toEqual(state);
  });
});

describe('applyUserMessageCoupling', () => {
  const config: UserMessageCouplingConfig = {
    userMessageArousalBump: 0.3,
    interactionSocialNeedReset: 0.1,
  };

  it('raises arousal and caps socialNeed without touching valence', () => {
    const coupled = applyUserMessageCoupling(
      { valence: 0.6, arousal: 0.5, socialNeed: 0.9 },
      config,
    );
    expect(coupled.valence).toBe(0.6);
    expect(coupled.arousal).toBeCloseTo(0.8);
    expect(coupled.socialNeed).toBe(0.1);
  });

  it('caps arousal at 1 and never raises socialNeed above its current value', () => {
    const coupled = applyUserMessageCoupling(
      { valence: 0.5, arousal: 0.9, socialNeed: 0.05 },
      config,
    );
    expect(coupled.arousal).toBe(1);
    expect(coupled.socialNeed).toBe(0.05);
  });
});

describe('mergeEmotionAssessment', () => {
  it('blends evolved and assessed states with the 0.4 / 0.6 weights', () => {
    const merged = mergeEmotionAssessment(
      { valence: 0.5, arousal: 0.5, socialNeed: 0.5 },
      { valence: 1, arousal: 0, socialNeed: 0.5 },
    );
    expect(merged.valence).toBeCloseTo(0.8);
    expect(merged.arousal).toBeCloseTo(0.2);
    expect(merged.socialNeed).toBeCloseTo(0.5);
  });
});

describe('parseEmotionAssessment', () => {
  it('parses a bare JSON assessment', () => {
    expect(parseEmotionAssessment('{"valence":0.2,"arousal":0.4,"socialNeed":0.9}')).toEqual({
      valence: 0.2,
      arousal: 0.4,
      socialNeed: 0.9,
    });
  });

  it('extracts JSON embedded in prose and clamps out-of-range values', () => {
    expect(
      parseEmotionAssessment('Sure! {"valence":2,"arousal":-1,"socialNeed":0.5} done'),
    ).toEqual({ valence: 1, arousal: 0, socialNeed: 0.5 });
  });

  it('returns undefined for malformed or incomplete assessments', () => {
    expect(parseEmotionAssessment('no json here')).toBeUndefined();
    expect(parseEmotionAssessment('{"valence":0.2}')).toBeUndefined();
    expect(parseEmotionAssessment('{"valence":"x","arousal":0.4,"socialNeed":0.5}')).toBeUndefined();
  });
});

describe('EmotionStore', () => {
  it('evolves a session state on each read using the injected clock', () => {
    let now = 1_000;
    const store = new EmotionStore({ now: () => now, initialState: DEFAULT_EMOTION_STATE });

    const initial = store.get('s1');
    expect(initial).toEqual(DEFAULT_EMOTION_STATE);
    expect(store.size).toBe(1);

    now += 2 * HOUR;
    const evolved = store.get('s1');
    expect(evolved.socialNeed).toBeGreaterThan(initial.socialNeed);
    expect(evolved.arousal).toBeLessThan(initial.arousal);
  });

  it('keeps sessions isolated and supports set/peek/clear', () => {
    const store = new EmotionStore({ now: () => 0 });
    store.get('a');
    store.get('b');
    expect(store.size).toBe(2);
    expect(store.sessions().sort()).toEqual(['a', 'b']);

    store.set('a', { valence: 0.1, arousal: 0.2, socialNeed: 0.3 });
    expect(store.peek('a')).toEqual({ valence: 0.1, arousal: 0.2, socialNeed: 0.3 });
    expect(store.peek('missing')).toBeUndefined();

    store.clear();
    expect(store.size).toBe(0);
  });
});

describe('clamp01', () => {
  it('clamps to the unit interval and maps NaN to 0', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
