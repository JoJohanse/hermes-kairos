import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PERSONA_SYSTEM_PROMPT } from '../builtins/proactive-chat/prompts.js';
import { DEFAULT_TIME_WINDOWS } from '../builtins/proactive-chat/decision.js';
import type {
  ProactiveChatResolvedConfig,
  ProactiveTimeWindow,
} from '../builtins/proactive-chat/types.js';

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

/** Default `arousal` boost applied when the user messages the agent. */
export const DEFAULT_USER_MESSAGE_AROUSAL_BUMP = 0.3;

/** Default `socialNeed` cap applied when the user messages the agent. */
export const DEFAULT_INTERACTION_SOCIAL_NEED_RESET = 0.1;

/** Default periodic snapshot interval, in heartbeats. */
export const DEFAULT_PERSISTENCE_SAVE_INTERVAL_TICKS = 20;

/** A field that could not be honored, plus why it was replaced by a default. */
export interface ConfigWarning {
  /** Dotted path of the offending field, e.g. `decision.sendThreshold`. */
  field: string;
  /** The raw value that was rejected. */
  value: unknown;
  /** Human-readable reason the value was not used. */
  reason: string;
}

/** Sink for {@link ConfigWarning}s. Defaults to `console.warn`. */
export type ConfigWarnHandler = (warning: ConfigWarning) => void;

/** Default warning sink: logs a `[config]`-prefixed line to `console.warn`. */
export const defaultConfigWarn: ConfigWarnHandler = (warning) => {
  let rendered: string;
  try {
    rendered = JSON.stringify(warning.value) ?? String(warning.value);
  } catch {
    rendered = String(warning.value);
  }
  console.warn(`[config] ${warning.field}: ${warning.reason} (received ${rendered})`);
};

function warnIf(
  warn: ConfigWarnHandler,
  field: string,
  value: unknown,
  condition: boolean,
  reason: string,
): void {
  if (condition) warn({ field, value, reason });
}

/**
 * Configuration for the built-in proactive-chat plugin.
 *
 * Extends the fully resolved shape with the original placeholder fields, which
 * remain honored for backward compatibility (see {@link resolveProactiveChatConfig}).
 */
export interface ProactiveChatConfig extends ProactiveChatResolvedConfig {
  /** @deprecated Superseded by `heartbeat.intervalMs`. */
  checkIntervalMs?: number;
  /** @deprecated Superseded by `decision.noSendAfterActivityMinutes`. */
  idleThresholdMs?: number;
  /** @deprecated Superseded by `decision.maxPerHour`. */
  maxInitiationsPerHour?: number;
  /** @deprecated No v1 support for opening sessions unprompted. */
  allowNewSessions?: boolean;
}

/** Fully resolved KAIROS configuration. */
export interface HermesConfig {
  llm: LLMConfig;
  /** Kernel storage location for plugin JSON state. */
  storage: { dataDir: string };
  plugins: {
    proactiveChat: ProactiveChatConfig;
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

/** Options for {@link resolveProactiveChatConfig}. */
export interface ResolveProactiveChatConfigOptions {
  /** Warning sink for silently-rejected fields. Defaults to `console.warn`. */
  onWarn?: ConfigWarnHandler;
}

/** Default proactive-chat configuration (also the base for {@link resolveProactiveChatConfig}). */
export const DEFAULT_PROACTIVE_CHAT: ProactiveChatConfig = {
  enabled: true,
  heartbeat: { intervalMs: 60_000 },
  decision: {
    sendThreshold: 0.6,
    holdThreshold: 0.3,
    maxPerHour: 2,
    maxPerDay: 8,
    cooldownMinutes: 30,
    noSendAfterActivityMinutes: 5,
    quietHours: { start: '23:30', end: '07:00' },
    timeWindows: [...DEFAULT_TIME_WINDOWS],
  },
  emotion: {
    decayRatePerHour: 0.1,
    socialNeedGrowthPerHour: 0.2,
    arousalFloor: 0.2,
    useLlmAssessment: false,
    userMessageArousalBump: DEFAULT_USER_MESSAGE_AROUSAL_BUMP,
    interactionSocialNeedReset: DEFAULT_INTERACTION_SOCIAL_NEED_RESET,
  },
  context: { historyTailMessages: 20 },
  delayedQueue: { maxSize: 10, maxAgeHours: 4 },
  persona: { systemPrompt: DEFAULT_PERSONA_SYSTEM_PROMPT },
  persistence: { enabled: true, saveIntervalTicks: DEFAULT_PERSISTENCE_SAVE_INTERVAL_TICKS },
  // Deprecated placeholders retained so existing config files keep parsing.
  checkIntervalMs: 60_000,
  idleThresholdMs: 5 * 60_000,
  maxInitiationsPerHour: 3,
  allowNewSessions: false,
};

const MINUTE_MS = 60_000;

/**
 * Deprecated placeholder fields. They are retained in
 * {@link DEFAULT_PROACTIVE_CHAT} for direct construction/back-compat, but
 * `loadConfig` must not inject them into the resolved plugin slice: doing so
 * would make `resolveProactiveChatConfig` treat inherited defaults as user
 * intent and emit spurious "deprecated; ignored" warnings.
 */
const DEPRECATED_PLUGIN_FIELDS = [
  'checkIntervalMs',
  'idleThresholdMs',
  'maxInitiationsPerHour',
  'allowNewSessions',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merge `override` into `base`, returning a new object. */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function numberFrom(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringFrom(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function booleanFrom(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
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

const CLOCK_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Read a finite number, warning when a present value must be defaulted. */
function numberField(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  warn: ConfigWarnHandler,
  field: string,
): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (isFiniteNumber(value)) return value;
  warn({ field, value, reason: 'expected a finite number; using default' });
  return fallback;
}

function clockFrom(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  warn: ConfigWarnHandler,
  field: string,
): string {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string' && CLOCK_PATTERN.test(value.trim())) return value.trim();
  warn({ field, value, reason: 'expected an HH:MM clock; using default' });
  return fallback;
}

/** Resolve `heartbeat.intervalMs` with its deprecated `checkIntervalMs` fallback. */
function intervalField(
  heartbeat: Record<string, unknown>,
  root: Record<string, unknown>,
  warn: ConfigWarnHandler,
): number {
  const primary = heartbeat['intervalMs'];
  if (primary !== undefined) {
    if (isFiniteNumber(primary) && primary > 0) {
      if (root['checkIntervalMs'] !== undefined) {
        warn({
          field: 'checkIntervalMs',
          value: root['checkIntervalMs'],
          reason: 'deprecated; ignored because heartbeat.intervalMs is set',
        });
      }
      return primary;
    }
    warn({
      field: 'heartbeat.intervalMs',
      value: primary,
      reason: 'must be a positive finite number',
    });
  }
  const legacy = root['checkIntervalMs'];
  if (legacy !== undefined) {
    if (isFiniteNumber(legacy) && legacy > 0) return legacy;
    warn({
      field: 'checkIntervalMs',
      value: legacy,
      reason: 'must be a positive finite number; using default',
    });
  }
  return DEFAULT_PROACTIVE_CHAT.heartbeat.intervalMs;
}

/** Resolve `decision.noSendAfterActivityMinutes` with its `idleThresholdMs` fallback. */
function noSendField(
  decision: Record<string, unknown>,
  root: Record<string, unknown>,
  warn: ConfigWarnHandler,
): number {
  const primary = decision['noSendAfterActivityMinutes'];
  const legacy = root['idleThresholdMs'];
  if (primary !== undefined) {
    if (isFiniteNumber(primary)) {
      if (legacy !== undefined) {
        warn({
          field: 'idleThresholdMs',
          value: legacy,
          reason: 'deprecated; ignored because decision.noSendAfterActivityMinutes is set',
        });
      }
      return primary;
    }
    warn({
      field: 'decision.noSendAfterActivityMinutes',
      value: primary,
      reason: 'expected a finite number; using fallback',
    });
  }
  if (legacy !== undefined) {
    if (isFiniteNumber(legacy)) return legacy / MINUTE_MS;
    warn({
      field: 'idleThresholdMs',
      value: legacy,
      reason: 'expected a finite number of milliseconds; using default',
    });
  }
  return DEFAULT_PROACTIVE_CHAT.decision.noSendAfterActivityMinutes;
}

/** Resolve `decision.maxPerHour` with its `maxInitiationsPerHour` fallback. */
function maxPerHourField(
  decision: Record<string, unknown>,
  root: Record<string, unknown>,
  warn: ConfigWarnHandler,
): number {
  const primary = decision['maxPerHour'];
  const legacy = root['maxInitiationsPerHour'];
  if (primary !== undefined) {
    if (isFiniteNumber(primary)) {
      if (legacy !== undefined) {
        warn({
          field: 'maxInitiationsPerHour',
          value: legacy,
          reason: 'deprecated; ignored because decision.maxPerHour is set',
        });
      }
      return primary;
    }
    warn({
      field: 'decision.maxPerHour',
      value: primary,
      reason: 'expected a finite number; using fallback',
    });
  }
  if (legacy !== undefined) {
    if (isFiniteNumber(legacy)) return legacy;
    warn({
      field: 'maxInitiationsPerHour',
      value: legacy,
      reason: 'expected a finite number; using default',
    });
  }
  return DEFAULT_PROACTIVE_CHAT.decision.maxPerHour;
}

function timeWindowsFrom(value: unknown, fallback: ProactiveTimeWindow[]): ProactiveTimeWindow[] {
  if (!Array.isArray(value) || value.length === 0) return [...fallback];
  const windows: ProactiveTimeWindow[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const { startMinute, endMinute, fitness } = entry;
    if (
      typeof startMinute !== 'number' ||
      typeof endMinute !== 'number' ||
      typeof fitness !== 'number' ||
      !Number.isFinite(startMinute) ||
      !Number.isFinite(endMinute) ||
      !Number.isFinite(fitness)
    ) {
      continue;
    }
    windows.push({ startMinute, endMinute, fitness });
  }
  return windows.length > 0 ? windows : [...fallback];
}

/**
 * Resolve a raw `proactiveChat` config slice into the full plugin configuration.
 *
 * Missing or malformed fields fall back to {@link DEFAULT_PROACTIVE_CHAT}. The
 * deprecated placeholder fields (`checkIntervalMs`, `idleThresholdMs`,
 * `maxInitiationsPerHour`) are consulted only when their replacements are absent.
 */
export function resolveProactiveChatConfig(
  raw: unknown,
  options: ResolveProactiveChatConfigOptions = {},
): ProactiveChatConfig {
  const warn = options.onWarn ?? defaultConfigWarn;
  const defaults = DEFAULT_PROACTIVE_CHAT;

  if (raw !== undefined && !isPlainObject(raw)) {
    warn({
      field: 'proactiveChat',
      value: raw,
      reason: 'expected an object; using defaults',
    });
  }
  const root = asObject(raw);
  if (root['allowNewSessions'] !== undefined) {
    warn({
      field: 'allowNewSessions',
      value: root['allowNewSessions'],
      reason: 'deprecated and unsupported; ignored',
    });
  }
  const heartbeat = asObject(root['heartbeat']);
  const decision = asObject(root['decision']);
  const emotion = asObject(root['emotion']);
  const context = asObject(root['context']);
  const delayedQueue = asObject(root['delayedQueue']);
  const persona = asObject(root['persona']);
  const persistence = asObject(root['persistence']);
  const quietHours = asObject(decision['quietHours']);

  const intervalMs = intervalField(heartbeat, root, warn);
  const noSendAfterActivityMinutes = noSendField(decision, root, warn);
  const maxPerHour = maxPerHourField(decision, root, warn);

  const sendThreshold = numberField(
    decision,
    'sendThreshold',
    defaults.decision.sendThreshold,
    warn,
    'decision.sendThreshold',
  );
  const holdThreshold = numberField(
    decision,
    'holdThreshold',
    defaults.decision.holdThreshold,
    warn,
    'decision.holdThreshold',
  );
  const maxPerDay = numberField(
    decision,
    'maxPerDay',
    defaults.decision.maxPerDay,
    warn,
    'decision.maxPerDay',
  );
  const cooldownMinutes = numberField(
    decision,
    'cooldownMinutes',
    defaults.decision.cooldownMinutes,
    warn,
    'decision.cooldownMinutes',
  );

  // Semantic checks: values may still be honored, but warn loudly.
  warnIf(
    warn,
    'decision.sendThreshold',
    sendThreshold,
    sendThreshold < holdThreshold,
    `sendThreshold is below holdThreshold (${holdThreshold}); every HOLD becomes a GENERATE`,
  );
  warnIf(
    warn,
    'decision.maxPerHour',
    maxPerHour,
    maxPerHour <= 0,
    'must be greater than zero; the frequency limit will clamp to its floor',
  );
  warnIf(
    warn,
    'decision.maxPerDay',
    maxPerDay,
    maxPerDay <= 0,
    'must be greater than zero',
  );
  warnIf(
    warn,
    'decision.cooldownMinutes',
    cooldownMinutes,
    cooldownMinutes <= 0,
    'must be greater than zero',
  );
  warnIf(
    warn,
    'persistence.saveIntervalTicks',
    persistence['saveIntervalTicks'],
    isFiniteNumber(persistence['saveIntervalTicks']) &&
      persistence['saveIntervalTicks'] <= 0,
    'must be greater than zero; periodic saves will not run',
  );

  const useLlmAssessment = booleanFrom(
    emotion,
    'useLlmAssessment',
    defaults.emotion.useLlmAssessment,
  );
  if (emotion['useLlmAssessment'] !== undefined && typeof emotion['useLlmAssessment'] !== 'boolean') {
    warn({
      field: 'emotion.useLlmAssessment',
      value: emotion['useLlmAssessment'],
      reason: 'expected a boolean; using default',
    });
  }

  return {
    enabled: booleanFrom(root, 'enabled', defaults.enabled),
    heartbeat: { intervalMs },
    decision: {
      sendThreshold,
      holdThreshold,
      maxPerHour,
      maxPerDay,
      cooldownMinutes,
      noSendAfterActivityMinutes,
      quietHours: {
        start: clockFrom(
          quietHours,
          'start',
          defaults.decision.quietHours.start,
          warn,
          'decision.quietHours.start',
        ),
        end: clockFrom(
          quietHours,
          'end',
          defaults.decision.quietHours.end,
          warn,
          'decision.quietHours.end',
        ),
      },
      timeWindows: timeWindowsFrom(decision['timeWindows'], defaults.decision.timeWindows),
    },
    emotion: {
      decayRatePerHour: numberField(
        emotion,
        'decayRatePerHour',
        defaults.emotion.decayRatePerHour,
        warn,
        'emotion.decayRatePerHour',
      ),
      socialNeedGrowthPerHour: numberField(
        emotion,
        'socialNeedGrowthPerHour',
        defaults.emotion.socialNeedGrowthPerHour,
        warn,
        'emotion.socialNeedGrowthPerHour',
      ),
      arousalFloor: numberField(
        emotion,
        'arousalFloor',
        defaults.emotion.arousalFloor,
        warn,
        'emotion.arousalFloor',
      ),
      useLlmAssessment,
      userMessageArousalBump: numberField(
        emotion,
        'userMessageArousalBump',
        defaults.emotion.userMessageArousalBump,
        warn,
        'emotion.userMessageArousalBump',
      ),
      interactionSocialNeedReset: numberField(
        emotion,
        'interactionSocialNeedReset',
        defaults.emotion.interactionSocialNeedReset,
        warn,
        'emotion.interactionSocialNeedReset',
      ),
    },
    context: {
      historyTailMessages: numberField(
        context,
        'historyTailMessages',
        defaults.context.historyTailMessages,
        warn,
        'context.historyTailMessages',
      ),
    },
    delayedQueue: {
      maxSize: numberField(
        delayedQueue,
        'maxSize',
        defaults.delayedQueue.maxSize,
        warn,
        'delayedQueue.maxSize',
      ),
      maxAgeHours: numberField(
        delayedQueue,
        'maxAgeHours',
        defaults.delayedQueue.maxAgeHours,
        warn,
        'delayedQueue.maxAgeHours',
      ),
    },
    persona: {
      systemPrompt: stringFrom(persona, 'systemPrompt', defaults.persona.systemPrompt),
    },
    persistence: {
      enabled: booleanFrom(persistence, 'enabled', defaults.persistence.enabled),
      saveIntervalTicks: numberField(
        persistence,
        'saveIntervalTicks',
        defaults.persistence.saveIntervalTicks,
        warn,
        'persistence.saveIntervalTicks',
      ),
    },
  };
}

/**
 * Resolve the runtime configuration.
 *
 * Defaults come from environment variables (`LLM_BASE_URL`, `LLM_API_KEY`,
 * `LLM_MODEL`), optionally overridden by `hermes.config.json` at the repo root.
 * The file is optional; a malformed file throws with its path.
 */
export function loadConfig(options: LoadConfigOptions = {}): HermesConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const warn = options.onWarn ?? defaultConfigWarn;

  // Start from clean plugin defaults so inherited deprecated placeholders never
  // masquerade as user-provided values at resolve time.
  const cleanPluginDefaults: ProactiveChatConfig = { ...DEFAULT_PROACTIVE_CHAT };
  for (const key of DEPRECATED_PLUGIN_FIELDS) delete cleanPluginDefaults[key];

  const defaults: HermesConfig = {
    llm: {
      baseURL: env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.LLM_API_KEY ?? '',
      model: env.LLM_MODEL ?? 'gpt-4o-mini',
      requestTimeoutMs: timeoutFromEnv(env.LLM_REQUEST_TIMEOUT_MS, warn),
    },
    storage: { dataDir: DEFAULT_STORAGE_DATA_DIR },
    plugins: {
      proactiveChat: cleanPluginDefaults,
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

  const merged = deepMerge(
    defaults as unknown as Record<string, unknown>,
    parsed,
  ) as unknown as HermesConfig;

  // Guarantee structure even if the file half-specified a section.
  const plugins: Record<string, unknown> = isPlainObject(merged.plugins) ? merged.plugins : {};
  const rawPlugins: Record<string, unknown> = isPlainObject(parsed['plugins'])
    ? parsed['plugins']
    : {};
  const rawProactive: Record<string, unknown> = isPlainObject(rawPlugins['proactiveChat'])
    ? rawPlugins['proactiveChat']
    : {};
  const proactive = deepMerge(
    cleanPluginDefaults as unknown as Record<string, unknown>,
    rawProactive,
  ) as unknown as ProactiveChatConfig;
  const mergedLlm: Record<string, unknown> = isPlainObject(merged.llm) ? merged.llm : {};
  const mergedStorage: Record<string, unknown> = isPlainObject(merged.storage)
    ? merged.storage
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
    plugins: {
      ...plugins,
      proactiveChat: proactive,
    },
  };
}
