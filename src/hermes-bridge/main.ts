/**
 * HTTP sidecar bridge entry for KAIROS.
 *
 * A hermes-agent (Python) plugin runs this runtime as a sidecar: it feeds user
 * and agent messages in over `POST /events`, receives proactive outreach on a
 * callback URL (`POST {kind:'inject'|'send'}`), and can force an evaluation via
 * `POST /trigger`.
 *
 * Zero runtime dependencies: `node:http`, `node:util.parseArgs` and
 * `node:crypto.randomUUID` only. The server is created separately from
 * `listen()` and every outbound call goes through an injectable `fetch`, so
 * tests exercise routes and callbacks without binding real ports.
 *
 * Cross-process contract (mirrored by the Python lane's `contract.json`): see
 * `src/hermes-bridge/contract.json`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  defaultConfigWarn,
  loadConfig,
  type HermesBridgeConfig,
  type HermesBridgeDeliveryMode,
  type HermesConfig,
} from '../config/config.js';
import { HermesRuntime } from '../core/runtime.js';
import { ProactiveChatPlugin } from '../builtins/proactive-chat/index.js';
import type {
  ProactiveDelegateEvent,
  ProactiveDeliveryHandler,
  ProactiveDeliveryPayload,
  ProactiveThoughtEvent,
} from '../builtins/proactive-chat/types.js';
import type { LLMProvider } from '../llm/types.js';
import { OpenAICompatibleProvider } from '../llm/openai-compatible.js';
import {
  listenWithStalePidRecovery,
  nodePidFileFs,
  removePidFile,
  writePidFile,
  type PidFileFs,
} from './pidfile.js';

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
  /**
   * Boot nonce echoed by `GET /health` and (by the entry point) written to the
   * pidfile. When omitted, `/health` reports `uptimeMs` instead (test/default
   * shape) and the nonce handshake is inactive.
   */
  nonce?: string;
  /**
   * Whether plugin events are forwarded to the callback URL as a fallback.
   * Defaults to true; the bridge entry sets it to false when a
   * {@link ProactiveDeliveryHandler} owns delivery (avoiding a double POST).
   */
  attachCallbacks?: boolean;
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

/** Maximum accepted request body (1 MiB); larger requests get `413`. */
export const MAX_BODY_BYTES = 1_048_576;

/** Signals treated as a graceful stop request (SIGBREAK supports Windows CTRL_BREAK_EVENT). */
export const BRIDGE_SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const;

/** One parsed sidecar argv flag (all optional; absent → config/default). */
export interface BridgeArgv {
  port?: number;
  host?: string;
  token?: string;
  callbackUrl?: string;
  deliveryMode?: HermesBridgeDeliveryMode;
  dataDir?: string;
  nonce?: string;
  /** True when at least one known bridge flag was present — implies a deliberate sidecar launch. */
  explicitLaunch?: boolean;
}

/** Thrown by {@link parseBridgeArgs} for a malformed flag value. */
export class BridgeArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeArgvError';
  }
}

/** CLI value names for {@link parseBridgeArgs}. */
const ARG_OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  token: { type: 'string' },
  'callback-url': { type: 'string' },
  'delivery-mode': { type: 'string' },
  'data-dir': { type: 'string' },
  nonce: { type: 'string' },
} as const;

function stringArg(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse sidecar argv into {@link BridgeArgv}. Only known flags are read; unknown
 * flags/positionals are ignored so a wrapper can pass extra arguments. Invalid
 * values (`--port`, `--delivery-mode`) throw {@link BridgeArgvError}.
 */
export function parseBridgeArgs(argv: readonly string[]): BridgeArgv {
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: ARG_OPTIONS,
      strict: false,
      allowPositionals: true,
    });
    values = parsed.values as Record<string, unknown>;
  } catch (error) {
    throw new BridgeArgvError(
      `failed to parse sidecar argv: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result: BridgeArgv = {};

  const port = stringArg(values, 'port');
  if (port !== undefined) {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
      throw new BridgeArgvError(`--port must be an integer in 0..65535 (received ${port})`);
    }
    result.port = parsedPort;
  }

  const host = stringArg(values, 'host');
  if (host !== undefined) result.host = host;

  const token = stringArg(values, 'token');
  if (token !== undefined) result.token = token;

  const callbackUrl = stringArg(values, 'callback-url');
  if (callbackUrl !== undefined) result.callbackUrl = callbackUrl;

  const deliveryMode = stringArg(values, 'delivery-mode');
  if (deliveryMode !== undefined) {
    if (deliveryMode !== 'turn' && deliveryMode !== 'verbatim') {
      throw new BridgeArgvError(
        `--delivery-mode must be 'turn' or 'verbatim' (received ${deliveryMode})`,
      );
    }
    result.deliveryMode = deliveryMode;
  }

  const dataDir = stringArg(values, 'data-dir');
  if (dataDir !== undefined) {
    if (dataDir.trim() === '') throw new BridgeArgvError('--data-dir must be a non-empty path');
    result.dataDir = dataDir;
  }

  const nonce = stringArg(values, 'nonce');
  if (nonce !== undefined) result.nonce = nonce;

  // Any recognized flag implies a deliberate sidecar launch (the hermes plugin
  // always passes argv), which overrides the config-file `enabled` gate.
  const flagsPresent = argv.some((token) => {
    if (!token.startsWith('--')) return false;
    const name = token.slice(2).split('=')[0];
    return name !== undefined && Object.prototype.hasOwnProperty.call(ARG_OPTIONS, name);
  });
  if (flagsPresent) result.explicitLaunch = true;

  return result;
}

/** Result of applying argv over a resolved config. */
export interface ResolvedBridgeArgs {
  /** Effective bridge config (argv > config file > built-in defaults). */
  bridge: HermesBridgeConfig;
  /** Effective data directory (argv `--data-dir` wins over `storage.dataDir`). */
  dataDir: string;
  /** Boot nonce (`--nonce`, else generated per boot). */
  nonce: string;
}

/**
 * Apply parsed argv over `config`. Precedence is argv > `hermes.config.json` >
 * built-in default, and `--data-dir` overrides `storage.dataDir` for both the
 * pidfile and the runtime snapshots.
 */
export function resolveBridgeArgs(
  config: HermesConfig,
  args: BridgeArgv,
  options: { generatedNonce?: string } = {},
): ResolvedBridgeArgs {
  const bridge: HermesBridgeConfig = {
    ...config.hermesBridge,
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...(args.host !== undefined ? { host: args.host } : {}),
    ...(args.token !== undefined ? { token: args.token } : {}),
    ...(args.callbackUrl !== undefined ? { callbackUrl: args.callbackUrl } : {}),
    ...(args.deliveryMode !== undefined ? { deliveryMode: args.deliveryMode } : {}),
    // Explicit sidecar argv (the plugin's launch form) implies enabled: the
    // launcher's cwd has no hermes.config.json to carry the flag.
    ...(args.explicitLaunch ? { enabled: true } : {}),
  };
  return {
    bridge,
    dataDir: args.dataDir ?? config.storage.dataDir,
    nonce: args.nonce ?? options.generatedNonce ?? randomUUID(),
  };
}

interface ResolvedBridgeDeps {
  runtime: HermesRuntime;
  plugin: BridgeTrigger;
  config: HermesBridgeConfig;
  fetchImpl: BridgeFetch;
  logger: BridgeLogger;
  now: () => number;
  startedAt: number;
  nonce: string | undefined;
}

/** Delivery transport dependencies (callback URL + injected transport). */
export interface DeliveryTransportDeps {
  callbackUrl: string;
  token: string;
  fetchImpl: BridgeFetch;
  logger: BridgeLogger;
}

/** Outbound callback transport dependencies. */
type CallbackSenderDeps = DeliveryTransportDeps;

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
async function handleEvents(deps: ResolvedBridgeDeps, body: string): Promise<BridgeResponse> {
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

  deps.runtime.sessions.getOrCreate(sessionId);
  if (type === 'agent-message') {
    // Speak through the runtime's single speak path so `message:outbound` fires
    // exactly as it would for a plugin speaking via `ctx.send`.
    await deps.runtime.send(sessionId, content);
    return { status: 202, body: { ok: true } };
  }
  // User messages only need `message:appended` for emotion coupling.
  deps.runtime.sessions.appendMessage(sessionId, 'user', content);
  return { status: 202, body: { ok: true } };
}

/**
 * Core router.
 *
 * Auth applies to every route except `GET /health` (the Python lane's liveness
 * probe runs before the token is exchanged). When no token is configured, auth
 * is disabled entirely — the Python lane now generates a token by default and
 * passes it via `--token`, but standalone users may still opt out by leaving it
 * empty.
 */
async function handleBridgeRequest(
  deps: ResolvedBridgeDeps,
  request: BridgeRequest,
): Promise<BridgeResponse> {
  const path = request.url.split('?')[0] ?? '/';
  const isHealth = request.method === 'GET' && path === '/health';

  if (!isHealth && !isAuthorized(deps.config, request)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  if (isHealth) {
    // Contract shape is `{ok, nonce}`; without a configured nonce (in-memory
    // route tests) fall back to the legacy uptime shape.
    if (deps.nonce === undefined) {
      return {
        status: 200,
        body: { ok: true, uptimeMs: Math.max(0, deps.now() - deps.startedAt) },
      };
    }
    return { status: 200, body: { ok: true, nonce: deps.nonce } };
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

/** Narrow a delivery payload to the wire callback shape (drops extra fields). */
function toCallbackPayload(payload: ProactiveDeliveryPayload): CallbackPayload | undefined {
  if (payload.kind === 'inject') {
    if (typeof payload.directive !== 'string' || payload.directive === '') return undefined;
    return {
      kind: 'inject',
      sessionId: payload.sessionId,
      directive: payload.directive,
      score: payload.score,
    };
  }
  if (typeof payload.content !== 'string') return undefined;
  return {
    kind: 'send',
    sessionId: payload.sessionId,
    content: payload.content,
    score: payload.score,
  };
}

/**
 * POST one callback with a bounded timeout. Throws when the transport fails or
 * returns a non-2xx status, so an awaited delivery handler can surface failure.
 */
async function sendCallback(deps: CallbackSenderDeps, payload: CallbackPayload): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (deps.token !== '') headers['authorization'] = `Bearer ${deps.token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await deps.fetchImpl(deps.callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`callback (${payload.kind}) returned status ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget callback wrapper used by the event-bus fallback. Never throws. */
async function postCallback(deps: ResolvedBridgeDeps, payload: CallbackPayload): Promise<void> {
  try {
    await sendCallback(
      {
        callbackUrl: deps.config.callbackUrl,
        token: deps.config.token,
        fetchImpl: deps.fetchImpl,
        logger: deps.logger,
      },
      payload,
    );
  } catch (error) {
    deps.logger.warn(`[hermes-bridge] callback (${payload.kind}) failed:`, error);
  }
}

/**
 * Subscribe to plugin events and forward them to the callback URL. This is the
 * non-bridge fallback path; the bridge entry disables it and passes a
 * {@link ProactiveDeliveryHandler} to the plugin instead.
 */
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

/** Raised internally when a request body exceeds {@link MAX_BODY_BYTES}. */
class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
    this.name = 'PayloadTooLargeError';
  }
}

/** Read the request body, rejecting as soon as it exceeds `maxBytes`. */
async function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > maxBytes) throw new PayloadTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Header value as a single string, or `undefined`. */
function singleHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : undefined;
}

/** Whether a `content-type` value is JSON (`application/json...`). */
function isJsonContentType(value: string | string[] | undefined): boolean {
  const raw = singleHeader(value);
  return typeof raw === 'string' && raw.trim().toLowerCase().startsWith('application/json');
}

/** Declared `Content-Length`, when finite and non-negative. */
function contentLengthOf(headers: IncomingMessage['headers']): number | undefined {
  const raw = singleHeader(headers['content-length']);
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body) ?? 'null';
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/**
 * Build the bridge: subscribes to plugin callbacks (unless disabled) and creates
 * (but does not bind) the HTTP server. Call {@link BridgeServer.listen} to bind.
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
    nonce: deps.nonce,
  };

  const detach = deps.attachCallbacks === false ? () => {} : attachCallbacks(resolved);

  const server = createServer((req, res) => {
    // Aborted/reset connections must never surface as unhandled 'error' events.
    req.on('error', () => {});
    res.on('error', () => {});
    void (async () => {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      const path = url.split('?')[0] ?? '/';
      const request: BridgeRequest = { method, url, headers: req.headers, body: '' };
      const isHealth = method === 'GET' && path === '/health';
      const isJsonRoute = method === 'POST' && (path === '/events' || path === '/trigger');
      try {
        // Auth first, then media-type, then size: a failed auth is 401 even when
        // the content-type is also wrong.
        if (!isHealth && !isAuthorized(resolved.config, request)) {
          req.resume();
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (isJsonRoute && !isJsonContentType(req.headers['content-type'])) {
          req.resume();
          sendJson(res, 415, { error: 'content-type must be application/json' });
          return;
        }
        const declared = contentLengthOf(req.headers);
        if (declared !== undefined && declared > MAX_BODY_BYTES) {
          req.resume();
          sendJson(res, 413, { error: 'payload too large' });
          return;
        }
        const body = await readBody(req, MAX_BODY_BYTES);
        const response = await handleBridgeRequest(resolved, { ...request, body });
        sendJson(res, response.status, response.body);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          req.resume();
          // The client may already be gone; only write when the response is usable.
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            sendJson(res, 413, { error: 'payload too large' });
          }
          return;
        }
        logger.error('[hermes-bridge] request failed:', error);
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          sendJson(res, 500, { error: 'internal error' });
        }
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
 * Awaiting delivery transport: the plugin only records a send slot after the
 * callback POST succeeds, so the Python lane can retry failed outreach. The
 * transport is injected, so tests and other hosts can supply their own.
 */
export function createDeliveryHandler(deps: DeliveryTransportDeps): ProactiveDeliveryHandler {
  return async (payload) => {
    const callback = toCallbackPayload(payload);
    if (!callback) {
      throw new Error(`unsupported delivery payload for kind ${payload.kind}`);
    }
    await sendCallback(deps, callback);
  };
}

/** Thrown by {@link bootBridge} when `hermesBridge.enabled` is false. */
export class BridgeDisabledError extends Error {
  constructor() {
    super('hermes-bridge is disabled');
    this.name = 'BridgeDisabledError';
  }
}

/** Process side effects the boot lifecycle needs; injectable for tests. */
export interface BridgeBootProcess {
  readonly pid: number;
  onSignal(signal: string, handler: () => void): void;
  setExitCode(code: number): void;
}

const nodeBootProcess: BridgeBootProcess = {
  pid: process.pid,
  onSignal: (signal, handler) => {
    process.on(signal as NodeJS.Signals, handler);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

/** Options for {@link bootBridge} — every default is the production adapter. */
export interface BridgeBootOptions {
  /** Raw argv after the script name. Defaults to `[]`. */
  argv?: readonly string[];
  /** Config override (tests). Defaults to `loadConfig({ onWarn: defaultConfigWarn })`. */
  config?: HermesConfig;
  /** Outbound transport for proactive delivery callbacks. */
  fetchImpl?: BridgeFetch;
  /** Diagnostics sink for boot and shutdown messages. */
  logger?: BridgeLogger;
  /** Pidfile filesystem. Defaults to the real `node:fs`. */
  pidFs?: PidFileFs;
  /** LLM provider override (tests). Defaults to `OpenAICompatibleProvider` from config. */
  llm?: LLMProvider;
  /** Signals that trigger graceful shutdown. Defaults to {@link BRIDGE_SHUTDOWN_SIGNALS}. */
  signals?: readonly string[];
  /** Process adapter. Defaults to the real `process`. */
  process?: BridgeBootProcess;
}

/** Handle over a booted bridge. */
export interface BridgeBootHandle {
  /** The booted runtime (event bus, sessions), for host observability. */
  readonly runtime: HermesRuntime;
  /** The registered proactive-chat plugin. */
  readonly plugin: ProactiveChatPlugin;
  /** Delivery mode the plugin was configured with. */
  readonly deliveryMode: 'self' | 'delegate';
  /** Idempotent graceful shutdown: server → runtime → pidfile removal. */
  stop(signal?: string): Promise<void>;
}

/**
 * The Bridge boot module. Applies argv over `hermes.config.json`, requires
 * `hermesBridge.enabled` (throws {@link BridgeDisabledError}), maps the argv
 * delivery mode onto the plugin's delivery mode, starts the runtime, binds the
 * HTTP server (recovering once from a live stale sidecar), writes the pidfile,
 * registers the shutdown signals and returns a handle. A bind failure stops the
 * runtime before rejecting, so the caller only maps the error onto the exit code.
 */
export async function bootBridge(options: BridgeBootOptions = {}): Promise<BridgeBootHandle> {
  const proc = options.process ?? nodeBootProcess;
  const logger = options.logger ?? consoleBridgeLogger;
  const pidFs = options.pidFs ?? nodePidFileFs;
  const onWarn = defaultConfigWarn;
  const config = options.config ?? loadConfig({ onWarn });
  const { bridge, dataDir, nonce } = resolveBridgeArgs(
    config,
    parseBridgeArgs(options.argv ?? []),
  );

  if (!bridge.enabled) throw new BridgeDisabledError();

  const deliveryMode = bridge.deliveryMode === 'turn' ? 'delegate' : 'self';
  const llm =
    options.llm ??
    new OpenAICompatibleProvider({
      baseURL: config.llm.baseURL,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      requestTimeoutMs: config.llm.requestTimeoutMs,
    });

  const runtime = new HermesRuntime({
    config: {
      ...config,
      // `--data-dir` must move snapshots too, not just the pidfile.
      storage: { dataDir },
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

  const plugin = new ProactiveChatPlugin({
    onWarn,
    deliveryHandler: createDeliveryHandler({
      callbackUrl: bridge.callbackUrl,
      token: bridge.token,
      fetchImpl: options.fetchImpl ?? defaultBridgeFetch,
      logger,
    }),
  });
  runtime.register(plugin);

  await runtime.start();

  const server = createBridgeServer({
    runtime,
    plugin,
    config: bridge,
    nonce,
    attachCallbacks: false,
  });

  try {
    await listenWithStalePidRecovery(server, { dataDir, fs: pidFs, logger });
  } catch (error) {
    logger.error(`[hermes-bridge] failed to bind: ${String(error)}`);
    try {
      await runtime.stop();
    } catch (stopError) {
      logger.error(`[hermes-bridge] shutdown error: ${String(stopError)}`);
    }
    throw error;
  }

  try {
    writePidFile(pidFs, dataDir, { pid: proc.pid, nonce });
  } catch (error) {
    logger.error(`[hermes-bridge] failed to write pidfile: ${String(error)}`);
  }
  logger.info(
    `[hermes-bridge] listening on http://${bridge.host}:${bridge.port} (delivery=${deliveryMode}, nonce=${nonce})`,
  );

  let shutdown: Promise<void> | undefined;
  const stop = (signal?: string): Promise<void> => {
    if (shutdown) return shutdown;
    shutdown = (async (): Promise<void> => {
      if (signal !== undefined) logger.info(`[hermes-bridge] received ${signal}, shutting down…`);
      try {
        await server.close();
      } catch (error) {
        logger.error(`[hermes-bridge] error closing server: ${String(error)}`);
        proc.setExitCode(1);
      }
      try {
        await runtime.stop();
      } catch (error) {
        logger.error(`[hermes-bridge] shutdown error: ${String(error)}`);
        proc.setExitCode(1);
      }
      removePidFile(pidFs, dataDir);
    })();
    return shutdown;
  };

  for (const signal of options.signals ?? BRIDGE_SHUTDOWN_SIGNALS) {
    try {
      proc.onSignal(signal, () => {
        void stop(signal);
      });
    } catch {
      // A platform that does not support this signal (e.g. SIGBREAK off Windows).
    }
  }

  return { runtime, plugin, deliveryMode, stop };
}

/**
 * Bridge entry point: boot the bridge and map boot failures onto the process
 * exit code. Every lifecycle invariant lives in {@link bootBridge}.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    await bootBridge({ argv });
  } catch (error) {
    if (error instanceof BridgeDisabledError) {
      console.error(
        '[hermes-bridge] disabled: set hermesBridge.enabled = true in hermes.config.json to run the bridge entry',
      );
    } else {
      console.error('[hermes-bridge] failed to start:', error);
    }
    process.exit(1);
  }
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
