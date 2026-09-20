import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** LLM connection settings. */
export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** Placeholder configuration for the built-in proactive-chat plugin. */
export interface ProactiveChatConfig {
  enabled: boolean;
  /** How often the plugin evaluates whether to initiate, in ms. */
  checkIntervalMs: number;
  /** Session silence required before the agent may initiate, in ms. */
  idleThresholdMs: number;
  /** Upper bound on agent-initiated messages per session per hour. */
  maxInitiationsPerHour: number;
  /** Whether the agent may open brand-new sessions unprompted. */
  allowNewSessions: boolean;
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

const DEFAULT_PROACTIVE_CHAT: ProactiveChatConfig = {
  enabled: false,
  checkIntervalMs: 60_000,
  idleThresholdMs: 5 * 60_000,
  maxInitiationsPerHour: 3,
  allowNewSessions: false,
};

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
