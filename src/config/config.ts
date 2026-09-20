import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  asObject,
  booleanFrom,
  deepMerge,
  defaultConfigWarn,
  numberField,
  stringAllowEmptyFrom,
  type ConfigWarnHandler,
} from './fields.js';

export { defaultConfigWarn } from './fields.js';
export type { ConfigWarning, ConfigWarnHandler } from './fields.js';

/** LLM connection settings. */
export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Per-request timeout in milliseconds. Defaults to `30_000`. */
  requestTimeoutMs: number;
}

/** Default per-request LLM timeout in milliseconds. */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30_000;

/** Default directory for kernel/plugin JSON state. */
export const DEFAULT_STORAGE_DATA_DIR = '.hermes-data';

/** Delivery mode understood by the HTTP bridge entry (`hermesBridge.deliveryMode`). */
export type HermesBridgeDeliveryMode = 'turn' | 'verbatim';

/** HTTP bridge entry configuration (`hermesBridge` root slice). */
export interface HermesBridgeConfig {
  /** When false the bridge entry refuses to start (default). */
  enabled: boolean;
  /** TCP port to bind. */
  port: number;
  /** Interface to bind. */
  host: string;
  /** Shared secret; when non-empty every route requires `Authorization: Bearer <token>`. */
  token: string;
  /** URL the bridge POSTs proactive callbacks to (the hermes-agent side). */
  callbackUrl: string;
  /**
   * Maps to the plugin's `proactiveChat.delivery.mode`:
   * `turn` → `delegate` (agent composes the message), `verbatim` → `self`.
   */
  deliveryMode: HermesBridgeDeliveryMode;
}

/** Default HTTP bridge configuration. Disabled unless explicitly enabled. */
export const DEFAULT_HERMES_BRIDGE: HermesBridgeConfig = {
  enabled: false,
  port: 8671,
  host: '127.0.0.1',
  token: '',
  callbackUrl: 'http://127.0.0.1:8672/speak',
  deliveryMode: 'turn',
};

/** Options for {@link resolveHermesBridgeConfig}. */
export interface ResolveHermesBridgeConfigOptions {
  /** Warning sink for silently-rejected fields. Defaults to `console.warn`. */
  onWarn?: ConfigWarnHandler;
}

/** Fully resolved KAIROS configuration. */
export interface HermesConfig {
  llm: LLMConfig;
  /** Kernel storage location for plugin JSON state. */
  storage: { dataDir: string };
  /** HTTP sidecar bridge entry configuration. */
  hermesBridge: HermesBridgeConfig;
  plugins: {
    /** Raw user-provided slice; the plugin resolves/validates it at init. */
    proactiveChat: Record<string, unknown>;
    [plugin: string]: unknown;
  };
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Directory containing an optional `hermes.config.json`. */
  cwd?: string;
  /** Environment source (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Explicit config file path; when omitted, `<cwd>/hermes.config.json`. */
  configPath?: string;
  /** Warning sink for silently-rejected fields. Defaults to `console.warn`. */
  onWarn?: ConfigWarnHandler;
}

function warnIf(
  warn: ConfigWarnHandler,
  field: string,
  value: unknown,
  condition: boolean,
  reason: string,
): void {
  if (condition) warn({ field, value, reason });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function timeoutFromEnv(raw: string | undefined, warn: ConfigWarnHandler): number {
  if (raw === undefined) return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  warn({
    field: 'llm.requestTimeoutMs',
    value: raw,
    reason: 'must be a positive number; using default',
  });
  return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

/** Parse a bridge delivery mode (`turn` | `verbatim`). */
function bridgeDeliveryModeFrom(
  source: Record<string, unknown>,
  key: string,
  fallback: HermesBridgeDeliveryMode,
  warn: ConfigWarnHandler,
  field: string,
): HermesBridgeDeliveryMode {
  const value = source[key];
  if (value === undefined) return fallback;
  if (value === 'turn' || value === 'verbatim') return value;
  warn({ field, value, reason: "expected 'turn' or 'verbatim'; using default" });
  return fallback;
}

/**
 * Resolve a raw `hermesBridge` config slice, defaulting and warning on every
 * malformed field (the same instrumentation contract as the plugin slices).
 */
export function resolveHermesBridgeConfig(
  raw: unknown,
  options: ResolveHermesBridgeConfigOptions = {},
): HermesBridgeConfig {
  const warn = options.onWarn ?? defaultConfigWarn;
  const defaults = DEFAULT_HERMES_BRIDGE;

  if (raw !== undefined && !isPlainObject(raw)) {
    warn({ field: 'hermesBridge', value: raw, reason: 'expected an object; using defaults' });
  }
  const root = asObject(raw);

  const enabled = booleanFrom(root, 'enabled', defaults.enabled);
  if (root['enabled'] !== undefined && typeof root['enabled'] !== 'boolean') {
    warn({
      field: 'hermesBridge.enabled',
      value: root['enabled'],
      reason: 'expected a boolean; using default',
    });
  }

  const port = numberField(root, 'port', defaults.port, warn, 'hermesBridge.port');
  warnIf(
    warn,
    'hermesBridge.port',
    port,
    port < 1 || port > 65535,
    'expected a port in 1..65535',
  );

  return {
    enabled,
    port,
    host: stringAllowEmptyFrom(root, 'host', defaults.host, warn, 'hermesBridge.host'),
    token: stringAllowEmptyFrom(root, 'token', defaults.token, warn, 'hermesBridge.token'),
    callbackUrl: stringAllowEmptyFrom(
      root,
      'callbackUrl',
      defaults.callbackUrl,
      warn,
      'hermesBridge.callbackUrl',
    ),
    deliveryMode: bridgeDeliveryModeFrom(
      root,
      'deliveryMode',
      defaults.deliveryMode,
      warn,
      'hermesBridge.deliveryMode',
    ),
  };
}

/**
 * Resolve the runtime configuration.
 *
 * Defaults come from environment variables (`LLM_BASE_URL`, `LLM_API_KEY`,
 * `LLM_MODEL`), optionally overridden by `hermes.config.json` at the repo root.
 * The file is optional; a malformed file throws with its path.
 *
 * Plugin slices are passed through raw: the kernel never injects plugin
 * defaults, so each plugin resolves its own slice at init.
 */
export function loadConfig(options: LoadConfigOptions = {}): HermesConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const warn = options.onWarn ?? defaultConfigWarn;

  const defaults: HermesConfig = {
    llm: {
      baseURL: env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.LLM_API_KEY ?? '',
      model: env.LLM_MODEL ?? 'gpt-4o-mini',
      requestTimeoutMs: timeoutFromEnv(env.LLM_REQUEST_TIMEOUT_MS, warn),
    },
    storage: { dataDir: DEFAULT_STORAGE_DATA_DIR },
    hermesBridge: { ...DEFAULT_HERMES_BRIDGE },
    plugins: {
      proactiveChat: {},
    },
  };

  const configPath = options.configPath ?? resolve(cwd, 'hermes.config.json');
  if (!existsSync(configPath)) return defaults;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`loadConfig: failed to parse ${configPath}: ${String(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`loadConfig: ${configPath} must contain a JSON object`);
  }

  // Sections the loader expects to be objects: a wrong-typed section is ignored
  // wholesale (deep-merge would otherwise treat it as a scalar override), so
  // surface it rather than silently dropping it.
  for (const section of ['plugins', 'llm', 'storage', 'hermesBridge'] as const) {
    const value = parsed[section];
    if (value !== undefined && !isPlainObject(value)) {
      warn({ field: section, value, reason: 'not an object; section ignored' });
    }
  }

  const merged = deepMerge(
    defaults as unknown as Record<string, unknown>,
    parsed,
  ) as unknown as HermesConfig;

  // Guarantee structure even if the file half-specified a section.
  const plugins: Record<string, unknown> = isPlainObject(merged.plugins) ? merged.plugins : {};
  const rawPlugins: Record<string, unknown> = isPlainObject(parsed['plugins'])
    ? parsed['plugins']
    : {};
  // Plugin slices are owned by their plugins: the kernel hands over the raw
  // user-provided slice and never injects defaults (which a resolver could
  // otherwise mistake for user intent).
  const rawProactive = isPlainObject(rawPlugins['proactiveChat']) ? rawPlugins['proactiveChat'] : {};
  const mergedLlm: Record<string, unknown> = isPlainObject(merged.llm) ? merged.llm : {};
  const mergedStorage: Record<string, unknown> = isPlainObject(merged.storage)
    ? merged.storage
    : {};
  const mergedBridge: Record<string, unknown> = isPlainObject(merged.hermesBridge)
    ? merged.hermesBridge
    : {};
  const rawDataDir = mergedStorage['dataDir'];
  let dataDir = DEFAULT_STORAGE_DATA_DIR;
  if (rawDataDir !== undefined) {
    if (typeof rawDataDir === 'string' && rawDataDir.trim() !== '') {
      dataDir = rawDataDir;
    } else {
      warn({
        field: 'storage.dataDir',
        value: rawDataDir,
        reason: 'expected a non-empty string; using default',
      });
    }
  }
  // Guarantee the timeout is always a positive number, whatever the file said.
  const rawTimeout = mergedLlm['requestTimeoutMs'];
  let requestTimeoutMs = defaults.llm.requestTimeoutMs;
  if (rawTimeout !== undefined) {
    if (isFiniteNumber(rawTimeout) && rawTimeout > 0) {
      requestTimeoutMs = rawTimeout;
    } else {
      warn({
        field: 'llm.requestTimeoutMs',
        value: rawTimeout,
        reason: 'must be a positive number; using default',
      });
    }
  }

  return {
    llm: {
      ...defaults.llm,
      ...mergedLlm,
      requestTimeoutMs,
    },
    storage: { dataDir },
    hermesBridge: resolveHermesBridgeConfig(mergedBridge, { onWarn: warn }),
    plugins: {
      ...plugins,
      proactiveChat: rawProactive,
    },
  };
}
