import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../core/runtime.js';
import { HermesRuntime } from '../core/runtime.js';
import { MockProvider } from '../llm/mock.js';
import type { PluginContext } from './types.js';

const CONFIG: RuntimeConfig = {
  llm: { baseURL: 'http://localhost:0/v1', apiKey: '', model: 'mock' },
  plugins: {},
};

describe('PluginContext.send', () => {
  it('appends an agent message to the session and emits message:outbound', async () => {
    const runtime = new HermesRuntime({ config: CONFIG, llm: new MockProvider() });
    let captured: PluginContext | undefined;
    runtime.register({
      name: 'probe',
      version: '0.0.1',
      init: (ctx) => {
        captured = ctx;
      },
    });
    await runtime.start();

    const ctx = captured;
    if (!ctx) throw new Error('plugin context was not captured');

    const session = runtime.sessions.create();
    const received: Array<{ sessionId: string; content: string; timestamp: number }> = [];
    runtime.eventBus.on('message:outbound', (payload) => {
      received.push(payload);
    });

    const message = await ctx.send(session.id, 'hello from the agent');

    expect(message.role).toBe('agent');
    expect(message.sessionId).toBe(session.id);
    expect(message.content).toBe('hello from the agent');
    expect(session.messages).toEqual([message]);
    expect(session.lastActivityAt).toBe(message.timestamp);
    expect(received).toEqual([
      { sessionId: session.id, content: 'hello from the agent', timestamp: message.timestamp },
    ]);

    await runtime.stop();
    expect(runtime.started).toBe(false);
    expect(runtime.scheduler.started).toBe(false);
  });
});

describe('runtime.send (the speak path)', () => {
  it('is the same seam as ctx.send: appends the agent message and emits message:outbound', async () => {
    const runtime = new HermesRuntime({ config: CONFIG, llm: new MockProvider() });
    const session = runtime.sessions.create();
    const appended: string[] = [];
    const outbound: string[] = [];
    runtime.eventBus.on('message:appended', ({ message }) => {
      appended.push(`${message.role}:${message.content}`);
    });
    runtime.eventBus.on('message:outbound', ({ content }) => {
      outbound.push(content);
    });

    const message = await runtime.send(session.id, 'host-composed reply');

    expect(message.role).toBe('agent');
    expect(message.content).toBe('host-composed reply');
    expect(session.messages).toEqual([message]);
    expect(appended).toEqual(['agent:host-composed reply']);
    expect(outbound).toEqual(['host-composed reply']);
  });
});
