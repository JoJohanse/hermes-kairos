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
    useLlmAssessment: false,
  },
  context: { historyTailMessages: 20 },
  delayedQueue: { maxSize: 10, maxAgeHours: 4 },
  persona: { systemPrompt: DEFAULT_PERSONA_SYSTEM_PROMPT },
  // Deprecated placeholders retained so existing config files keep parsing.
  checkIntervalMs: 60_000,
  idleThresholdMs: 5 * 60_000,
  maxInitiationsPerHour: 3,
  allowNewSessions: false,
};

const MINUTE_MS = 60_000;

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

const CLOCK_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

function clockFrom(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = source[key];
  return typeof value === 'string' && CLOCK_PATTERN.test(value.trim()) ? value.trim() : fallback;
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
export function resolveProactiveChatConfig(raw: unknown): ProactiveChatConfig {
  const root = asObject(raw);
  const heartbeat = asObject(root['heartbeat']);
  const decision = asObject(root['decision']);
  const emotion = asObject(root['emotion']);
  const context = asObject(root['context']);
  const delayedQueue = asObject(root['delayedQueue']);
  const persona = asObject(root['persona']);
  const quietHours = asObject(decision['quietHours']);

  const defaults = DEFAULT_PROACTIVE_CHAT;

  const intervalMs = numberFrom(
    heartbeat,
    'intervalMs',
    numberFrom(root, 'checkIntervalMs', defaults.heartbeat.intervalMs),
  );
  const noSendAfterActivityMinutes = numberFrom(
    decision,
    'noSendAfterActivityMinutes',
    numberFrom(root, 'idleThresholdMs', defaults.decision.noSendAfterActivityMinutes * MINUTE_MS) /
      MINUTE_MS,
  );
  const maxPerHour = numberFrom(
    decision,
    'maxPerHour',
    numberFrom(root, 'maxInitiationsPerHour', defaults.decision.maxPerHour),
  );

  return {
    enabled: booleanFrom(root, 'enabled', defaults.enabled),
    heartbeat: { intervalMs },
    decision: {
      sendThreshold: numberFrom(decision, 'sendThreshold', defaults.decision.sendThreshold),
      holdThreshold: numberFrom(decision, 'holdThreshold', defaults.decision.holdThreshold),
      maxPerHour,
      maxPerDay: numberFrom(decision, 'maxPerDay', defaults.decision.maxPerDay),
      cooldownMinutes: numberFrom(
        decision,
        'cooldownMinutes',
        defaults.decision.cooldownMinutes,
      ),
      noSendAfterActivityMinutes,
      quietHours: {
        start: clockFrom(quietHours, 'start', defaults.decision.quietHours.start),
        end: clockFrom(quietHours, 'end', defaults.decision.quietHours.end),
      },
      timeWindows: timeWindowsFrom(decision['timeWindows'], defaults.decision.timeWindows),
    },
    emotion: {
      decayRatePerHour: numberFrom(
        emotion,
        'decayRatePerHour',
        defaults.emotion.decayRatePerHour,
      ),
      socialNeedGrowthPerHour: numberFrom(
        emotion,
        'socialNeedGrowthPerHour',
        defaults.emotion.socialNeedGrowthPerHour,
      ),
      useLlmAssessment: booleanFrom(
        emotion,
        'useLlmAssessment',
        defaults.emotion.useLlmAssessment,
      ),
    },
    context: {
      historyTailMessages: numberFrom(
        context,
        'historyTailMessages',
        defaults.context.historyTailMessages,
      ),
    },
    delayedQueue: {
      maxSize: numberFrom(delayedQueue, 'maxSize', defaults.delayedQueue.maxSize),
      maxAgeHours: numberFrom(delayedQueue, 'maxAgeHours', defaults.delayedQueue.maxAgeHours),
    },
    persona: {
      systemPrompt: stringFrom(persona, 'systemPrompt', defaults.persona.systemPrompt),
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

  const defaults: HermesConfig = {
    llm: {
      baseURL: env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.LLM_API_KEY ?? '',
      model: env.LLM_MODEL ?? 'gpt-4o-mini',
    },
    plugins: {
      proactiveChat: { ...DEFAULT_PROACTIVE_CHAT },
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
  const proactive = isPlainObject(plugins.proactiveChat)
    ? (plugins.proactiveChat as Partial<ProactiveChatConfig>)
    : {};
  return {
    llm: { ...defaults.llm, ...(isPlainObject(merged.llm) ? merged.llm : {}) },
    plugins: {
      ...plugins,
      proactiveChat: { ...DEFAULT_PROACTIVE_CHAT, ...proactive },
    },
  };
}
