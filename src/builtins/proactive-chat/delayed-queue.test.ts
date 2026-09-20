import { describe, expect, it } from 'vitest';
import { DelayedQueue } from './delayed-queue.js';
import type { DecisionBreakdown, HeldStub } from './types.js';

const HOUR = 3_600_000;

function breakdown(score: number): DecisionBreakdown {
  return {
    valence: 0.5,
    arousal: 0.5,
    socialNeed: 0.5,
    intensity: 0.5,
    timeFitness: 1,
    silenceFactor: 1,
    frequencyLimit: 1,
    silenceMinutes: 120,
    sentThisHour: 0,
    sentToday: 0,
    score,
  };
}

function stub(sessionId: string, score: number, enqueuedAt: number): HeldStub {
  return { sessionId, enqueuedAt, scoreAtEnqueue: score, breakdown: breakdown(score) };
}

describe('DelayedQueue', () => {
  it('enqueues and reports per-session size', () => {
    const queue = new DelayedQueue({ now: () => 0 });
    expect(queue.size('s1')).toBe(0);
    expect(queue.enqueue(stub('s1', 0.4, 0))).toBe(true);
    expect(queue.size('s1')).toBe(1);
    expect(queue.enqueue(stub('s2', 0.4, 0))).toBe(true);
    expect([...queue.entries('s1')].map((entry) => entry.scoreAtEnqueue)).toEqual([0.4]);
    expect(queue.sessions().sort()).toEqual(['s1', 's2']);
  });

  it('promotes stubs whose re-score reaches the threshold', () => {
    let now = 0;
    const queue = new DelayedQueue({ maxSize: 10, maxAgeHours: 4, now: () => now });
    queue.enqueue(stub('s1', 0.1, 0));
    queue.enqueue(stub('s1', 0.2, 0));

    now = 60_000;
    const result = queue.rescore('s1', () => 0.9, 0.6);

    expect(result.promoted).toHaveLength(2);
    expect(result.promoted.every((entry) => entry.scoreAtEnqueue === 0.9)).toBe(true);
    expect(result.queued).toHaveLength(0);
    expect(queue.size('s1')).toBe(0);
  });

  it('keeps below-threshold stubs, updating their score', () => {
    let now = 0;
    const queue = new DelayedQueue({ maxAgeHours: 4, now: () => now });
    queue.enqueue(stub('s1', 0.1, 0));

    now = 60_000;
    const result = queue.rescore('s1', () => 0.5, 0.6);

    expect(result.promoted).toHaveLength(0);
    expect(result.queued).toHaveLength(1);
    expect(queue.entries('s1')[0]?.scoreAtEnqueue).toBeCloseTo(0.5);
  });

  it('expires stubs older than maxAgeHours', () => {
    let now = 0;
    const queue = new DelayedQueue({ maxAgeHours: 4, now: () => now });
    queue.enqueue(stub('s1', 0.1, 0));

    now = 4 * HOUR + 1;
    const result = queue.rescore('s1', () => 0.9, 0.6);

    expect(result.expired).toHaveLength(1);
    expect(result.promoted).toHaveLength(0);
    expect(queue.size('s1')).toBe(0);
  });

  it('evicts the lowest score when a full queue receives a better stub', () => {
    const queue = new DelayedQueue({ maxSize: 2, maxAgeHours: 4, now: () => 0 });
    queue.enqueue(stub('s1', 0.5, 0));
    queue.enqueue(stub('s1', 0.3, 0));

    const accepted = queue.enqueue(stub('s1', 0.7, 0));

    expect(accepted).toBe(true);
    expect(queue.size('s1')).toBe(2);
    expect([...queue.entries('s1')].map((entry) => entry.scoreAtEnqueue).sort()).toEqual([0.5, 0.7]);
  });

  it('rejects a newcomer that does not outscore the weakest held stub', () => {
    const queue = new DelayedQueue({ maxSize: 2, maxAgeHours: 4, now: () => 0 });
    queue.enqueue(stub('s1', 0.5, 0));
    queue.enqueue(stub('s1', 0.3, 0));

    expect(queue.enqueue(stub('s1', 0.2, 0))).toBe(false);
    expect(queue.size('s1')).toBe(2);
    expect([...queue.entries('s1')].map((entry) => entry.scoreAtEnqueue).sort()).toEqual([0.3, 0.5]);
  });

  it('prunes expired stubs before deciding whether the queue is full', () => {
    let now = 0;
    const queue = new DelayedQueue({ maxSize: 1, maxAgeHours: 4, now: () => now });
    queue.enqueue(stub('s1', 0.9, 0));

    now = 5 * HOUR;
    expect(queue.enqueue(stub('s1', 0.1, now))).toBe(true);
    expect(queue.size('s1')).toBe(1);
    expect(queue.entries('s1')[0]?.scoreAtEnqueue).toBeCloseTo(0.1);
  });

  it('clears one session or all sessions', () => {
    const queue = new DelayedQueue({ now: () => 0 });
    queue.enqueue(stub('s1', 0.4, 0));
    queue.enqueue(stub('s2', 0.4, 0));

    queue.clear('s1');
    expect(queue.size('s1')).toBe(0);
    expect(queue.size('s2')).toBe(1);

    queue.clear();
    expect(queue.sessions()).toEqual([]);
  });
});
