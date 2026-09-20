import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './event-bus.js';

interface TestEvents extends Record<string, unknown> {
  ping: { n: number };
}

describe('EventBus', () => {
  it('delivers a payload to a subscriber after emit', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on('ping', handler);

    bus.emit('ping', { n: 1 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ n: 1 });
  });

  it('stops delivery after off()', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on('ping', handler);

    bus.emit('ping', { n: 1 });
    bus.off('ping', handler);
    bus.emit('ping', { n: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe function from on()', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    const unsubscribe = bus.on('ping', handler);

    unsubscribe();
    bus.emit('ping', { n: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers once() only for the first emission', () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.once('ping', handler);

    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing handler from other subscribers', () => {
    const bus = new EventBus<TestEvents>();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', good);

    bus.emit('ping', { n: 1 });

    expect(good).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
