import { describe, expect, it } from 'vitest';
import { ONE_DAY_MS } from './decision.js';
import { SendLog } from './sends.js';

describe('SendLog', () => {
  it('prunes the send window in place on every read', () => {
    const log = new SendLog();
    log.record('s1', 1_000);
    log.record('s1', 2_000);
    expect(log.recent('s1', 2_500)).toEqual([1_000, 2_000]);
    // A read past the window drops stale stamps; the entry disappears when empty.
    expect(log.recent('s1', 1_000 + ONE_DAY_MS + 1)).toEqual([2_000]);
    expect(log.recent('s1', 2_000 + ONE_DAY_MS + 1)).toEqual([]);
    expect(log.sessionIds()).toEqual([]);
  });

  it('record prunes first, so stale stamps cannot accumulate', () => {
    const log = new SendLog();
    log.record('s1', 0);
    log.record('s1', ONE_DAY_MS + 10);
    expect(log.recent('s1', ONE_DAY_MS + 10)).toEqual([ONE_DAY_MS + 10]);
  });

  it('restore drops non-finite and out-of-window stamps', () => {
    const log = new SendLog();
    const now = 10_000;
    log.restore('s1', [9_000, 5_000, 'nope', Number.NaN, now - ONE_DAY_MS], now);
    expect(log.recent('s1', now)).toEqual([9_000, 5_000]);
    // An entirely invalid batch leaves no entry behind.
    log.restore('s2', ['x'], now);
    expect(log.sessionIds()).toEqual(['s1']);
  });

  it('clear forgets everything (re-init idempotence)', () => {
    const log = new SendLog();
    log.record('s1', 1);
    log.clear();
    expect(log.sessionIds()).toEqual([]);
    expect(log.recent('s1', 2)).toEqual([]);
  });
});
