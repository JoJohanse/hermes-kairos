import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/event-bus.js';
import { SessionManager } from '../core/session-manager.js';
import { JsonStore } from '../core/storage.js';
import type { Message } from '../core/types.js';
import { MockProvider } from '../llm/mock.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { PluginRegistry } from './registry.js';
import type { Plugin, PluginContext } from './types.js';

function makeContext(): PluginContext {
  const randomId = (): string => `id-${Math.random().toString(16).slice(2)}`;
  return {
    eventBus: new EventBus(),
    sessions: new SessionManager(),
    scheduler: new Scheduler(),
    llm: new MockProvider(),
    // Never touched by these tests; a real store with an unused dir is fine.
    storage: new JsonStore({ dataDir: 'hermes-test-unused' }),
    config: {},
    send: async (sessionId: string, content: string): Promise<Message> => ({
      id: randomId(),
      sessionId,
      role: 'agent',
      content,
      timestamp: Date.now(),
    }),
  };
}

describe('PluginRegistry', () => {
  it('initializes two plugins in registration order', async () => {
    const order: string[] = [];
    const a: Plugin = {
      name: 'a',
      version: '1.0.0',
      init: () => {
        order.push('a');
      },
    };
    const b: Plugin = {
      name: 'b',
      version: '1.0.0',
      init: () => {
        order.push('b');
      },
    };
    const registry = new PluginRegistry();
    registry.register(a);
    registry.register(b);

    const errors = await registry.initAll(makeContext());

    expect(errors).toEqual([]);
    expect(order).toEqual(['a', 'b']);
    expect(registry.initialized()).toEqual(['a', 'b']);
    expect(registry.list().map((plugin) => plugin.name)).toEqual(['a', 'b']);
    expect(registry.get('a')).toBe(a);
  });

  it('collects a throwing init without blocking later plugins', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    const second = vi.fn();

    const registry = new PluginRegistry({ onError });
    registry.register({
      name: 'broken',
      version: '1.0.0',
      init: () => {
        throw new Error('init exploded');
      },
    });
    registry.register({
      name: 'healthy',
      version: '1.0.0',
      init: second,
    });

    const errors = await registry.initAll(makeContext());

    expect(second).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.plugin).toBe('broken');
    expect((errors[0]?.error as Error).message).toBe('init exploded');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(registry.initialized()).toEqual(['healthy']);
    spy.mockRestore();
  });

  it('tears down initialized plugins in reverse order', async () => {
    const order: string[] = [];
    const registry = new PluginRegistry();
    registry.register({
      name: 'a',
      version: '1.0.0',
      init: () => {},
      teardown: () => {
        order.push('a');
      },
    });
    registry.register({
      name: 'b',
      version: '1.0.0',
      init: () => {},
      teardown: () => {
        order.push('b');
      },
    });

    await registry.initAll(makeContext());
    const errors = await registry.teardownAll();

    expect(errors).toEqual([]);
    expect(order).toEqual(['b', 'a']);
    expect(registry.initialized()).toEqual([]);
  });
});
