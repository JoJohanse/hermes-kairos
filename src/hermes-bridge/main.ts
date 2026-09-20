/**
 * HTTP sidecar bridge entry for KAIROS.
 *
 * A hermes-agent (Python) plugin runs this runtime as a sidecar: it feeds user
 * and agent messages in over `POST /events`, receives proactive outreach on a
 * callback URL (`POST {kind:'inject'|'send'}`), and can force an evaluation via
 * `POST /trigger`.
 *
 * Zero runtime dependencies: `node:http` only. The server is created separately
 * from `listen()` and every outbound call goes through an injectable `fetch`, so
 * tests exercise routes and callbacks without binding real ports.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defaultConfigWarn, loadConfig, type HermesBridgeConfig } from '../config/config.js';
import { HermesRuntime } from '../core/runtime.js';
import type { MessageRole } from '../core/types.js';
import { ProactiveChatPlugin } from '../builtins/proactive-chat/index.js';
import type {
  ProactiveDelegateEvent,
  ProactiveThoughtEvent,
} from '../builtins/proactive-chat/types.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';

/** Minimal trigger surface the bridge needs from the proactive-chat plugin. */
export interface BridgeTrigger {
  runOnce(): Promise<void>;
}

/** Sink for bridge diagnostics; injectable so tests can capture log lines. */
export interface BridgeLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Default logger: routes to the matching `console` method. */
export const consoleBridgeLogger: BridgeLogger = {
  info: (message, ...args) => console.log(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

/** Response shape the bridge needs from a `fetch` implementation. */
export interface BridgeFetchResponse {
  ok: boolean;
  status: number;
}

/** Request init the bridge passes to `fetch`. */
export interface BridgeFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** Injectable outbound HTTP call (structurally satisfied by global `fetch`). */
export type BridgeFetch = (url: string, init: BridgeFetchInit) => Promise<BridgeFetchResponse>;

/** Default fetch backed by `globalThis.fetch`, narrowed to its response shape. */
export const defaultBridgeFetch: BridgeFetch = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return { ok: response.ok, status: response.status };
};

/** A normalized inbound HTTP request (transport-independent, easy to fake). */
export interface BridgeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A normalized HTTP response produced by the route handler. */
export interface BridgeResponse {
  status: number;
  body: unknown;
}

/** Dependencies of {@link createBridgeServer}. */
export interface BridgeServerDeps {
  runtime: HermesRuntime;
  /** Plugin whose heartbeat `POST /trigger` forces. */
  plugin: BridgeTrigger;
  /** Resolved `hermesBridge` config slice. */
  config: HermesBridgeConfig;
  /** Injectable outbound HTTP (defaults to global `fetch`). */
  fetchImpl?: BridgeFetch;
  /** Injectable logger (defaults to console). */
  logger?: BridgeLogger;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
}

/** HTTP server holder returned by {@link createBridgeServer}. */
export interface BridgeServer {
  /** The bound-but-not-yet-listening `node:http` server. */
  server: Server;
  /** Route handler, exposed so tests can drive routes without a socket. */
  handleRequest(request: BridgeRequest): Promise<BridgeResponse>;
  /** Bind the server to the configured host/port. */
  listen(): Promise<void>;
  /** Unsubscribe callbacks and close the server (idempotent). */
  close(): Promise<void>;
}

/** Callback payloads POSTed to `hermesBridge.callbackUrl`. */
type CallbackPayload =
  | { kind: 'inject'; sessionId: string; directive: string; score: number }
  | { kind: 'send'; sessionId: string; content: string; score: number };

/** Per-request callback timeout. */
export const CALLBACK_TIMEOUT_MS = 5_000;

interface ResolvedBridgeDeps {
  runtime: HermesRuntime;
  plugin: BridgeTrigger;
  config: HermesBridgeConfig;
  fetchImpl: BridgeFetch;
  logger: BridgeLogger;
  now: () => number;
  startedAt: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function isAuthorized(config: HermesBridgeConfig, request: BridgeRequest): boolean {
  if (config.token === '') return true;
  return headerValue(request.headers, 'authorization') === `Bearer ${config.token}`;
}

function parseJson(body: string): unknown {
  if (body.trim() === '') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** `POST /events`: feed one message into the kernel session store. */
function handleEvents(deps: ResolvedBridgeDeps, body: string): BridgeResponse {
  const parsed = parseJson(body);
  if (!isPlainRecord(parsed)) {
    return { status: 400, body: { error: 'body must be a JSON object' } };
  }
  const type = parsed['type'];
  const sessionId = parsed['sessionId'];
  const content = parsed['content'];

  if (type !== 'user-message' && type !== 'agent-message') {
    return { status: 400, body: { error: "type must be 'user-message' or 'agent-message'" } };
  }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { status: 400, body: { error: 'sessionId must be a non-empty string' } };
  }
  if (typeof content !== 'string') {
    return { status: 400, body: { error: 'content must be a string' } };
  }

  const role: MessageRole = type === 'user-message' ? 'user' : 'agent';
  deps.runtime.sessions.getOrCreate(sessionId);
  // Flows through `message:appended`, so emotion coupling happens automatically.
  deps.runtime.sessions.appendMessage(sessionId, role, content);
  return { status: 202, body: { ok: true } };
}

/** Core router. Auth applies to every route when a token is configured. */
async function handleBridgeRequest(
  deps: ResolvedBridgeDeps,
  request: BridgeRequest,
): Promise<BridgeResponse> {
  if (!isAuthorized(deps.config, request)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  const path = request.url.split('?')[0] ?? '/';
  if (request.method === 'GET' && path === '/health') {
    return {
      status: 200,
      body: { ok: true, uptimeMs: Math.max(0, deps.now() - deps.startedAt) },
    };
  }
  if (request.method === 'POST' && path === '/events') {
    return handleEvents(deps, request.body);
  }
  if (request.method === 'POST' && path === '/trigger') {
    await deps.plugin.runOnce();
    return { status: 202, body: { ok: true } };
  }
  return { status: 404, body: { error: 'not found' } };
}

/** POST one callback, fire-and-forget with a bounded timeout. Never throws. */
async function postCallback(deps: ResolvedBridgeDeps, payload: CallbackPayload): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.config.token !== '') headers['authorization'] = `Bearer ${deps.config.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await deps.fetchImpl(deps.config.callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      deps.logger.warn(
        `[hermes-bridge] callback (${payload.kind}) returned status ${response.status}`,
      );
    }
  } catch (error) {
    deps.logger.warn(`[hermes-bridge] callback (${payload.kind}) failed:`, error);
  } finally {
    clearTimeout(timer);
  }
}

/** Subscribe to plugin events and forward them to the callback URL. */
function attachCallbacks(deps: ResolvedBridgeDeps): () => void {
  const unsubDelegate = deps.runtime.eventBus.on('proactive:delegate', (payload) => {
    const event = payload as Partial<ProactiveDelegateEvent>;
    if (typeof event.sessionId !== 'string' || typeof event.directive !== 'string') return;
    void postCallback(deps, {
      kind: 'inject',
      sessionId: event.sessionId,
      directive: event.directive,
      score: typeof event.score === 'number' ? event.score : 0,
    });
  });
  const unsubThought = deps.runtime.eventBus.on('proactive:thought', (payload) => {
    const event = payload as Partial<ProactiveThoughtEvent>;
    if (typeof event.sessionId !== 'string' || typeof event.content !== 'string') return;
    void postCallback(deps, {
      kind: 'send',
      sessionId: event.sessionId,
      content: event.content,
      score: typeof event.score === 'number' ? event.score : 0,
    });
  });
  return () => {
    unsubDelegate();
    unsubThought();
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body) ?? 'null';
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/**
 * Build the bridge: subscribes to plugin callbacks and creates (but does not
 * bind) the HTTP server. Call {@link BridgeServer.listen} to bind.
 */
export function createBridgeServer(deps: BridgeServerDeps): BridgeServer {
  const logger = deps.logger ?? consoleBridgeLogger;
  const now = deps.now ?? (() => Date.now());
  const resolved: ResolvedBridgeDeps = {
    runtime: deps.runtime,
    plugin: deps.plugin,
    config: deps.config,
    fetchImpl: deps.fetchImpl ?? defaultBridgeFetch,
    logger,
    now,
    startedAt: now(),
  };

  const detach = attachCallbacks(resolved);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const response = await handleBridgeRequest(resolved, {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body,
        });
        sendJson(res, response.status, response.body);
      } catch (error) {
        logger.error('[hermes-bridge] request failed:', error);
        sendJson(res, 500, { error: 'internal error' });
      }
    })();
  });

  return {
    server,
    handleRequest: (request) => handleBridgeRequest(resolved, request),
    listen: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error): void => {
          rejectPromise(error);
        };
        server.once('error', onError);
        server.listen(resolved.config.port, resolved.config.host, () => {
          server.removeListener('error', onError);
          resolvePromise();
        });
      }),
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        detach();
        if (!server.listening) {
          resolvePromise();
          return;
        }
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
      }),
  };
}

/**
 * Bridge entry point. Requires `hermesBridge.enabled`; exits with status 1
 * otherwise. Starts the runtime, then the HTTP server, then waits for a signal.
 */
async function main(): Promise<void> {
  const onWarn = defaultConfigWarn;
  const config = loadConfig({ onWarn });
  const bridge = config.hermesBridge;

  if (!bridge.enabled) {
    console.error(
      '[hermes-bridge] disabled: set hermesBridge.enabled = true in hermes.config.json to run the bridge entry',
    );
    process.exit(1);
  }

  const deliveryMode = bridge.deliveryMode === 'turn' ? 'delegate' : 'self';
  const llm = new OpenAICompatibleProvider({
    baseURL: config.llm.baseURL,
    apiKey: config.llm.apiKey,
    model: config.llm.model,
    requestTimeoutMs: config.llm.requestTimeoutMs,
  });

  const runtime = new HermesRuntime({
    config: {
      ...config,
      plugins: {
        ...config.plugins,
        proactiveChat: {
          ...config.plugins.proactiveChat,
          delivery: { mode: deliveryMode },
        },
      },
    },
    llm,
  });
  const plugin = new ProactiveChatPlugin({ onWarn });
  runtime.register(plugin);

  await runtime.start();

  const server = createBridgeServer({ runtime, plugin, config: bridge });
  await server.listen();
  console.log(
    `[hermes-bridge] listening on http://${bridge.host}:${bridge.port} (delivery=${deliveryMode})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[hermes-bridge] received ${signal}, shutting down…`);
    try {
      await server.close();
    } catch (error) {
      console.error('[hermes-bridge] error closing server:', error);
      process.exitCode = 1;
    }
    try {
      await runtime.stop();
    } catch (error) {
      console.error('[hermes-bridge] shutdown error:', error);
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', (signal) => {
    void shutdown(signal);
  });
  process.on('SIGTERM', (signal) => {
    void shutdown(signal);
  });
}

// Only auto-boot when executed directly, so tests can import the factory.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('[hermes-bridge] failed to start:', error);
    process.exitCode = 1;
  });
}
