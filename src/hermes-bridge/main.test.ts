import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesBridgeConfig } from '../config/config.js';
import { HermesRuntime } from '../core/runtime.js';
import type { DecisionBreakdown } from '../builtins/proactive-chat/types.js';
import { MockProvider } from '../llm/mock.js';
import {
  createBridgeServer,
  type BridgeFetch,
  type BridgeFetchInit,
  type BridgeFetchResponse,
  type BridgeLogger,
  type BridgeRequest,
  type BridgeTrigger,
} from './main.js';

const RUNTIME_CONFIG = {
  llm: { baseURL: 'http://localhost:0/v1', apiKey: '', model: 'mock' },
  storage: { dataDir: 'bridge-test-data' },
  plugins: { proactiveChat: { enabled: false } },
};

function bridgeConfig(overrides: Partial<HermesBridgeConfig> = {}): HermesBridgeConfig {
  return {
    enabled: true,
    port: 8671,
    host: '127.0.0.1',
    token: '',
    callbackUrl: 'http://callback.test/speak',
    deliveryMode: 'turn',
    ...overrides,
  };
}

/** Records every outbound call; response is configurable per test. */
class FakeFetch {
  readonly calls: Array<{ url: string; init: BridgeFetchInit }> = [];
  response: BridgeFetchResponse = { ok: true, status: 200 };
  readonly fetch: BridgeFetch = async (url, init) => {
    this.calls.push({ url, init });
    return this.response;
  };
}

function collectingLogger(): { logger: BridgeLogger; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  const logger: BridgeLogger = {
    info: () => {},
    warn: (...args) => warnings.push(args),
    error: () => {},
  };
  return { logger, warnings };
}

function breakdown(): DecisionBreakdown {
  return {
    valence: 0.7,
    arousal: 0.8,
    socialNeed: 0.5,
    intensity: 0.5,
    timeFitness: 1,
    silenceFactor: 0.9,
    frequencyLimit: 1,
    silenceMinutes: 60,
    sentThisHour: 0,
    sentToday: 0,
    score: 0.7,
  };
}

function request(overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return { method: 'GET', url: '/health', headers: {}, body: '', ...overrides };
}

describe('hermes-bridge HTTP entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(options: {
    config?: Partial<HermesBridgeConfig>;
    runOnce?: () => Promise<void>;
  } = {}): {
    bridge: ReturnType<typeof createBridgeServer>;
    runtime: HermesRuntime;
    fake: FakeFetch;
    warnings: unknown[][];
  } {
    const runtime = new HermesRuntime({ config: RUNTIME_CONFIG, llm: new MockProvider() });
    const fake = new FakeFetch();
    const { logger, warnings } = collectingLogger();
    const plugin: BridgeTrigger = { runOnce: options.runOnce ?? (async () => {}) };
    const bridge = createBridgeServer({
      runtime,
      plugin,
      config: bridgeConfig(options.config),
      fetchImpl: fake.fetch,
      logger,
      now: () => Date.now(),
    });
    return { bridge, runtime, fake, warnings };
  }

  it('serves GET /health with uptime', async () => {
    const runtime = new HermesRuntime({ config: RUNTIME_CONFIG, llm: new MockProvider() });
    const { logger } = collectingLogger();
    let clock = 10_000;
    const bridge = createBridgeServer({
      runtime,
      plugin: { runOnce: async () => {} },
      config: bridgeConfig(),
      logger,
      now: () => clock,
    });

    clock = 10_500;
    const response = await bridge.handleRequest(request({ method: 'GET', url: '/health' }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, uptimeMs: 500 });
    await bridge.close();
  });

  it('requires a bearer token on every route when one is configured', async () => {
    const { bridge } = setup({ config: { token: 's3cret' } });

    const unauthenticated = await bridge.handleRequest(request());
    expect(unauthenticated.status).toBe(401);

    const wrong = await bridge.handleRequest(
      request({ headers: { authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(401);

    const authorized = await bridge.handleRequest(
      request({ headers: { authorization: 'Bearer s3cret' } }),
    );
    expect(authorized.status).toBe(200);

    await bridge.close();
  });

  it('feeds POST /events into the SessionManager with the mapped role', async () => {
    const { bridge, runtime } = setup();

    const userResponse = await bridge.handleRequest(
      request({
        method: 'POST',
        url: '/events',
        body: JSON.stringify({ type: 'user-message', sessionId: 's1', content: 'hello' }),
      }),
    );
    expect(userResponse.status).toBe(202);
    expect(userResponse.body).toEqual({ ok: true });

    const agentResponse = await bridge.handleRequest(
      request({
        method: 'POST',
        url: '/events',
        body: JSON.stringify({ type: 'agent-message', sessionId: 's1', content: 'hi there' }),
      }),
    );
    expect(agentResponse.status).toBe(202);

    const session = runtime.sessions.get('s1');
    expect(session?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['agent', 'hi there'],
    ]);

    await bridge.close();
  });

  it('rejects malformed POST /events bodies with 400', async () => {
    const { bridge } = setup();

    const badType = await bridge.handleRequest(
      request({
        method: 'POST',
        url: '/events',
        body: JSON.stringify({ type: 'nope', sessionId: 's1', content: 'x' }),
      }),
    );
    expect(badType.status).toBe(400);

    const missingSession = await bridge.handleRequest(
      request({
        method: 'POST',
        url: '/events',
        body: JSON.stringify({ type: 'user-message', content: 'x' }),
      }),
    );
    expect(missingSession.status).toBe(400);

    const notJson = await bridge.handleRequest(
      request({ method: 'POST', url: '/events', body: '{ not json' }),
    );
    expect(notJson.status).toBe(400);

    await bridge.close();
  });

  it('POSTs an inject callback when proactive:delegate fires', async () => {
    const { bridge, runtime, fake } = setup({ config: { token: 'tok' } });

    runtime.eventBus.emit('proactive:delegate', {
      sessionId: 's1',
      directive: 'Reach out now',
      score: 0.72,
      breakdown: breakdown(),
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe('http://callback.test/speak');
    expect(fake.calls[0]?.init.method).toBe('POST');
    expect(fake.calls[0]?.init.headers['authorization']).toBe('Bearer tok');
    expect(JSON.parse(fake.calls[0]?.init.body ?? '')).toEqual({
      kind: 'inject',
      sessionId: 's1',
      directive: 'Reach out now',
      score: 0.72,
    });

    await bridge.close();
  });

  it('POSTs a send callback when proactive:thought fires (verbatim mode)', async () => {
    const { bridge, runtime, fake } = setup();

    runtime.eventBus.emit('proactive:thought', {
      sessionId: 's1',
      content: 'long time!',
      score: 0.8,
      breakdown: breakdown(),
      stimuli: [],
      timestamp: Date.now(),
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(fake.calls[0]?.init.body ?? '')).toEqual({
      kind: 'send',
      sessionId: 's1',
      content: 'long time!',
      score: 0.8,
    });

    await bridge.close();
  });

  it('logs but never crashes when a callback fails', async () => {
    const { bridge, runtime, fake, warnings } = setup();
    fake.response = { ok: false, status: 503 };

    runtime.eventBus.emit('proactive:delegate', {
      sessionId: 's1',
      directive: 'Reach out now',
      score: 0.5,
      breakdown: breakdown(),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(warnings.length).toBe(1);

    await bridge.close();
  });

  it('POST /trigger invokes the plugin runOnce', async () => {
    const runOnce = vi.fn(async () => {});
    const { bridge } = setup({ runOnce });

    const response = await bridge.handleRequest(request({ method: 'POST', url: '/trigger' }));
    expect(response.status).toBe(202);
    expect(runOnce).toHaveBeenCalledTimes(1);

    await bridge.close();
  });
});
