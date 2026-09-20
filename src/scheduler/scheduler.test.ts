import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a registered task after the interval elapses', async () => {
    const scheduler = new Scheduler();
    const run = vi.fn();
    scheduler.registerTask({ name: 'tick', intervalMs: 50, run });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(49);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('stop() prevents further runs', () => {
    const scheduler = new Scheduler();
    const run = vi.fn();
    scheduler.registerTask({ name: 'tick', intervalMs: 50, run });
    scheduler.start();

    vi.advanceTimersByTime(50);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.stop();
    vi.advanceTimersByTime(500);

    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.started).toBe(false);
  });

  it('cancelTask() removes a task and its timer', () => {
    const scheduler = new Scheduler();
    const run = vi.fn();
    scheduler.registerTask({ name: 'tick', intervalMs: 50, run });
    scheduler.start();

    expect(scheduler.cancelTask('tick')).toBe(true);
    vi.advanceTimersByTime(500);

    expect(run).not.toHaveBeenCalled();
    expect(scheduler.list()).toEqual([]);
    expect(scheduler.cancelTask('tick')).toBe(false);
  });

  it('skips a tick while the previous run is still in flight', async () => {
    const scheduler = new Scheduler();
    let resolveRun: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    scheduler.registerTask({ name: 'slow', intervalMs: 50, run });
    scheduler.start();

    vi.advanceTimersByTime(150);
    expect(run).toHaveBeenCalledTimes(1);

    resolveRun?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-positive interval', () => {
    const scheduler = new Scheduler();
    expect(() => scheduler.registerTask({ name: 'bad', intervalMs: 0, run: () => {} })).toThrow(
      /intervalMs must be > 0/,
    );
  });
});
