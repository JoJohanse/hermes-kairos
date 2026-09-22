import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type HermesBridgeConfig } from '../config/config.js';
import { HermesRuntime } from '../core/runtime.js';
import type { DecisionBreakdown } from '../builtins/proactive-chat/types.js';
import { MockProvider } from '../llm/mock.js';
import {
  BRIDGE_SHUTDOWN_SIGNALS,
  BridgeArgvError,
  createBridgeServer,
  MAX_BODY_BYTES,
  parseBridgeArgs,
  resolveBridgeArgs,
  type BridgeFetch,
  type BridgeFetchInit,
  type BridgeFetchResponse,
  type BridgeLogger,
  type BridgeRequest,
  type BridgeTrigger,
} from './main.js';

const RUNTIME_CONFIG = {
  llm: {
    baseURL: 'http://localhost:0/v1',
    apiKey: '',
    model: 'mock',
    requestTimeoutMs: 30_000,
  },
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

  it('requires a bearer token on protected routes (but not GET /health) when configured', async () => {
    const { bridge } = setup({ config: { token: 's3cret' } });

    // Contract: the liveness probe is exempt so the Python lane can poll it
    // before the token is exchanged.
    const health = await bridge.handleRequest(request());
    expect(health.status).toBe(200);

    const protectedRequest = request({
      method: 'POST',
      url: '/events',
      body: JSON.stringify({ type: 'user-message', sessionId: 's1', content: 'x' }),
    });

    const unauthenticated = await bridge.handleRequest(protectedRequest);
    expect(unauthenticated.status).toBe(401);

    const wrong = await bridge.handleRequest(
      request({ ...protectedRequest, headers: { authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(401);

    const authorized = await bridge.handleRequest(
      request({ ...protectedRequest, headers: { authorization: 'Bearer s3cret' } }),
    );
    expect(authorized.status).toBe(202);

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

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('bridge argv (F2)', () => {
  it('applies argv over hermes.config.json and built-in defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-bridge-args-'));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, 'hermes.config.json'),
      JSON.stringify({
        storage: { dataDir: 'config-data' },
        hermesBridge: {
          enabled: true,
          port: 1111,
          host: '10.0.0.1',
          token: 'config-token',
          callbackUrl: 'http://config.test/speak',
          deliveryMode: 'verbatim',
        },
      }),
      'utf8',
    );
    const config = loadConfig({ cwd: dir, env: {} });

    const args = parseBridgeArgs([
      '--port',
      '2222',
      '--host',
      '0.0.0.0',
      '--token',
      'argv-token',
      '--callback-url',
      'http://argv.test/speak',
      '--delivery-mode',
      'turn',
      '--data-dir',
      'argv-data',
      '--nonce',
      'fixed-nonce',
    ]);
    const resolved = resolveBridgeArgs(config, args);

    expect(resolved.bridge).toEqual({
      enabled: true,
      port: 2222,
      host: '0.0.0.0',
      token: 'argv-token',
      callbackUrl: 'http://argv.test/speak',
      deliveryMode: 'turn',
    });
    expect(resolved.dataDir).toBe('argv-data');
    expect(resolved.nonce).toBe('fixed-nonce');
    // Unknown/positional arguments must not break parsing.
    expect(() => parseBridgeArgs(['--unknown', 'x', 'positional'])).not.toThrow();
  });

  it('falls back to config/defaults when flags are absent and generates a nonce', () => {
    const config = loadConfig({ cwd: join(tmpdir(), 'hermes-bridge-missing-xyz'), env: {} });
    const resolved = resolveBridgeArgs(config, parseBridgeArgs([]));

    expect(resolved.bridge.port).toBe(config.hermesBridge.port);
    expect(resolved.bridge.token).toBe(config.hermesBridge.token);
    expect(resolved.bridge.deliveryMode).toBe(config.hermesBridge.deliveryMode);
    expect(resolved.dataDir).toBe(config.storage.dataDir);
    expect(resolved.nonce).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an invalid --delivery-mode with an error exit', () => {
    expect(() => parseBridgeArgs(['--delivery-mode', 'bogus'])).toThrow(BridgeArgvError);
  });

  it('rejects an invalid --port', () => {
    expect(() => parseBridgeArgs(['--port', 'not-a-number'])).toThrow(BridgeArgvError);
  });

  it('handles SIGBREAK as a graceful shutdown signal (F7)', () => {
    expect([...BRIDGE_SHUTDOWN_SIGNALS]).toContain('SIGBREAK');
  });
});

interface HttpBridgeHandle {
  bridge: ReturnType<typeof createBridgeServer>;
  runtime: HermesRuntime;
  fake: FakeFetch;
  base: string;
}

async function startHttpBridge(
  options: { config?: Partial<HermesBridgeConfig>; nonce?: string } = {},
): Promise<HttpBridgeHandle> {
  const runtime = new HermesRuntime({ config: RUNTIME_CONFIG, llm: new MockProvider() });
  const fake = new FakeFetch();
  const { logger } = collectingLogger();
  const bridge = createBridgeServer({
    runtime,
    plugin: { runOnce: async () => {} },
    config: bridgeConfig({ port: 0, ...options.config }),
    nonce: options.nonce,
    fetchImpl: fake.fetch,
    logger,
  });
  await bridge.listen();
  const address = bridge.server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return { bridge, runtime, fake, base: `http://127.0.0.1:${address.port}` };
}

interface ContractRoute {
  method: string;
  path: string;
  source: string;
  target: string;
}

interface ContractPayload {
  kind?: string;
  type?: string;
  required: string[];
  optional: string[];
  fieldTypes: Record<string, string>;
}

interface ContractShape {
  version: number;
  transport: {
    contentType: string;
    contentTypeHeader: string;
    maxBodyBytes: number;
    unsupportedContentTypeStatus: number;
    payloadTooLargeStatus: number;
  };
  auth: {
    header: string;
    scheme: string;
    emptyTokenMeansDisabled: boolean;
    exemptRoutes: string[];
  };
  routes: { health: ContractRoute; events: ContractRoute; speak: ContractRoute };
  nonce: { perBoot: boolean; field: string; healthRoute: string };
  sidecarArgv: { allOptional: boolean; flags: string[] };
  speakPayloads: { inject: ContractPayload; send: ContractPayload };
  eventPayloads: Record<string, ContractPayload>;
  pidfile: { filename: string };
}

function loadContract(): ContractShape {
  const raw = readFileSync(new URL('./contract.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as ContractShape;
}

describe('sidecar HTTP hardening + contract (F3/F8/F10)', () => {
  const open: Array<() => Promise<void>> = [];

  async function start(
    options: { config?: Partial<HermesBridgeConfig>; nonce?: string } = {},
  ): Promise<HttpBridgeHandle> {
    const handle = await startHttpBridge(options);
    open.push(() => handle.bridge.close());
    return handle;
  }

  afterEach(async () => {
    while (open.length > 0) {
      const close = open.pop();
      if (close) await close();
    }
  });

  it('GET /health is exempt from auth and echoes the boot nonce', async () => {
    const { base } = await start({ config: { token: 'tok' }, nonce: 'nonce-123' });
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, nonce: 'nonce-123' });
  });

  it('POST /events without a bearer token is 401', async () => {
    const { base } = await start({ config: { token: 'tok' } });
    const response = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user-message', sessionId: 's1', content: 'x' }),
    });
    expect(response.status).toBe(401);
  });

  it('POST /events with a non-JSON content-type is 415', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(response.status).toBe(415);
  });

  it('applies auth before content-type: 401 wins when both fail', async () => {
    const { base } = await start({ config: { token: 'tok' } });
    const response = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('rejects an oversize Content-Length with 413 (cap 1 MiB)', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });

  it('accepts a valid /events body and feeds the session store', async () => {
    const { base, runtime } = await start();
    const response = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user-message', sessionId: 's9', content: 'hello' }),
    });
    expect(response.status).toBe(202);
    expect(runtime.sessions.get('s9')?.messages.map((message) => message.content)).toEqual([
      'hello',
    ]);
  });

  it('agent-message speaks through the runtime speak path: message:outbound fires', async () => {
    const { base, runtime } = await start();
    const outbound: Array<{ sessionId: string; content: string }> = [];
    runtime.eventBus.on('message:outbound', (payload) => outbound.push(payload));

    const user = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user-message', sessionId: 'speak', content: 'hi' }),
    });
    const agent = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'agent-message', sessionId: 'speak', content: 'hello again' }),
    });
    expect(user.status).toBe(202);
    expect(agent.status).toBe(202);

    // Only the agent side of the conversation is an outbound agent message;
    // user messages stay append-only.
    expect(outbound).toEqual([
      { sessionId: 'speak', content: 'hello again', timestamp: expect.any(Number) },
    ]);
  });

  it('survives an aborted connection and keeps serving the next request', async () => {
    const { base } = await start();
    const url = new URL(base);
    await new Promise<void>((resolvePromise) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port),
          path: '/events',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolvePromise();
        },
      );
      req.on('error', () => resolvePromise());
      req.write('{"type":"user-message","sessionId":"abort","content":"partial');
      setTimeout(() => req.destroy(), 10);
    });

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
  });

  it('matches the golden contract fixture: auth rule + argv + caps metadata', async () => {
    const contract = loadContract();
    expect(contract.version).toBe(1);
    expect(contract.transport.contentType).toBe('application/json');
    expect(contract.transport.contentTypeHeader).toBe('content-type');
    expect(contract.transport.maxBodyBytes).toBe(MAX_BODY_BYTES);
    expect(contract.transport.unsupportedContentTypeStatus).toBe(415);
    expect(contract.transport.payloadTooLargeStatus).toBe(413);
    expect(contract.auth.scheme).toBe('Bearer');
    expect(contract.auth.emptyTokenMeansDisabled).toBe(true);
    expect(contract.auth.exemptRoutes).toContain(contract.routes.health.path);
    expect(contract.sidecarArgv.allOptional).toBe(true);
    expect([...contract.sidecarArgv.flags].sort()).toEqual(
      ['--port', '--host', '--token', '--callback-url', '--delivery-mode', '--data-dir', '--nonce'].sort(),
    );
    expect(contract.pidfile.filename).toBe('sidecar.pid');

    const { base } = await start({ config: { token: 'tok' } });
    // `exemptRoutes` are reachable without a token; the events route is not.
    expect((await fetch(`${base}${contract.routes.health.path}`)).status).toBe(200);
    const guarded = await fetch(`${base}${contract.routes.events.path}`, {
      method: contract.routes.events.method,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(guarded.status).toBe(401);
  });

  it('matches the golden contract fixture: JSON media type + body cap', async () => {
    const contract = loadContract();
    const { base } = await start();

    const badMedia = await fetch(`${base}${contract.routes.events.path}`, {
      method: contract.routes.events.method,
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(badMedia.status).toBe(contract.transport.unsupportedContentTypeStatus);

    // `/trigger` is a TS-side legacy route with the same JSON admission rule.
    const trigger = await fetch(`${base}/trigger`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(trigger.status).toBe(contract.transport.unsupportedContentTypeStatus);

    const oversize = await fetch(`${base}${contract.routes.events.path}`, {
      method: contract.routes.events.method,
      headers: { 'content-type': contract.transport.contentType },
      body: Buffer.alloc(contract.transport.maxBodyBytes + 1),
    });
    expect(oversize.status).toBe(contract.transport.payloadTooLargeStatus);
  });

  it('matches the golden contract fixture: nonce handshake and payload shapes', async () => {
    const contract = loadContract();
    expect(contract.nonce.perBoot).toBe(true);
    expect(contract.nonce.healthRoute).toBe('/health');

    const { base, fake, runtime } = await start({ nonce: 'contract-nonce' });

    const health = await fetch(`${base}${contract.nonce.healthRoute}`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody['ok']).toBe(true);
    expect(healthBody[contract.nonce.field]).toBe('contract-nonce');

    runtime.eventBus.emit('proactive:delegate', {
      sessionId: 's1',
      directive: 'Reach out now',
      score: 0.5,
      breakdown: breakdown(),
    });
    runtime.eventBus.emit('proactive:thought', {
      sessionId: 's1',
      content: 'long time!',
      score: 0.6,
      breakdown: breakdown(),
      stimuli: [],
      timestamp: Date.now(),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    const byKind = new Map<string, Record<string, unknown>>();
    for (const call of fake.calls) {
      const payload = JSON.parse(call.init.body) as Record<string, unknown>;
      byKind.set(String(payload['kind']), payload);
      expect(call.url).toBe('http://callback.test/speak');
    }

    for (const spec of [contract.speakPayloads.inject, contract.speakPayloads.send]) {
      const payload = byKind.get(String(spec.kind));
      expect(payload).toBeDefined();
      const received = payload as Record<string, unknown>;
      for (const field of spec.required) {
        expect(received).toHaveProperty(field);
      }
      expect(received['kind']).toBe(spec.kind);
      expect(Object.keys(received).sort()).toEqual(
        [...spec.required, ...spec.optional].sort(),
      );
    }

    // `/events` accepts the documented inbound shape (optional `ts` omitted).
    const eventResponse = await fetch(`${base}${contract.routes.events.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user-message', sessionId: 'evt', content: 'hi' }),
    });
    expect(eventResponse.status).toBe(202);
  });
});

describe('explicit sidecar launch (argv implies enabled)', () => {
  const disabledConfig = () => ({
    ...RUNTIME_CONFIG,
    hermesBridge: {
      enabled: false,
      port: 8671,
      host: '127.0.0.1',
      token: '',
      callbackUrl: 'http://127.0.0.1:8672/speak',
      deliveryMode: 'turn' as const,
    },
  });

  it('marks explicitLaunch when any known flag is present', () => {
    expect(parseBridgeArgs(['--port', '8671']).explicitLaunch).toBe(true);
  });

  it('leaves explicitLaunch undefined for an empty argv', () => {
    expect(parseBridgeArgs([]).explicitLaunch).toBeUndefined();
  });

  it('forces enabled:true in resolveBridgeArgs when explicitLaunch', () => {
    const resolved = resolveBridgeArgs(disabledConfig() as Parameters<
      typeof resolveBridgeArgs
    >[0], { explicitLaunch: true, dataDir: 'X:/d' });
    expect(resolved.bridge.enabled).toBe(true);
    expect(resolved.dataDir).toBe('X:/d');
  });

  it('keeps the config gate when no argv was passed', () => {
    const resolved = resolveBridgeArgs(disabledConfig() as Parameters<
      typeof resolveBridgeArgs
    >[0], {});
    expect(resolved.bridge.enabled).toBe(false);
  });
});
