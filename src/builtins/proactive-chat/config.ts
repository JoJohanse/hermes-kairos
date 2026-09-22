/**
 * Configuration for the proactive-chat plugin.
 *
 * The plugin owns its config slice end-to-end: the defaults live here, the
 * kernel passes the raw user-provided slice from `hermes.config.json` through
 * untouched, and {@link resolveProactiveChatConfig} performs the single
 * resolution pass (at plugin init).
 */

import {
  asObject,
  booleanFrom,
  clockFrom,
  defaultConfigWarn,
  numberField,
  stringFrom,
  warnIf,
  type ConfigWarnHandler,
} from '../../config/fields.js';
import { DEFAULT_TIME_WINDOWS } from './decision.js';
import {
  DEFAULT_EMOTION_DYNAMICS,
  DEFAULT_INTERACTION_SOCIAL_NEED_RESET,
  DEFAULT_USER_MESSAGE_AROUSAL_BUMP,
} from './emotion.js';
import { DEFAULT_PERSONA_SYSTEM_PROMPT } from './prompts.js';
import type {
  ProactiveChatResolvedConfig,
  ProactiveDeliveryMode,
  ProactiveTimeWindow,
} from './types.js';

export type { ConfigWarnHandler } from '../../config/fields.js';

/** Default periodic snapshot interval, in heartbeats. */
export const DEFAULT_PERSISTENCE_SAVE_INTERVAL_TICKS = 20;

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
    ...DEFAULT_EMOTION_DYNAMICS,
    useLlmAssessment: false,
    userMessageArousalBump: DEFAULT_USER_MESSAGE_AROUSAL_BUMP,
    interactionSocialNeedReset: DEFAULT_INTERACTION_SOCIAL_NEED_RESET,
  },
  context: { historyTailMessages: 20 },
  delayedQueue: { maxSize: 10, maxAgeHours: 4 },
  persona: { systemPrompt: DEFAULT_PERSONA_SYSTEM_PROMPT },
  persistence: { enabled: true, saveIntervalTicks: DEFAULT_PERSISTENCE_SAVE_INTERVAL_TICKS },
  delivery: { mode: 'self' },
  // Deprecated placeholders retained so direct construction stays back-compatible.
  // The kernel only ever hands resolveProactiveChatConfig the raw user slice, so
  // these can never masquerade as user-provided values at resolve time.
  checkIntervalMs: 60_000,
  idleThresholdMs: 5 * 60_000,
  maxInitiationsPerHour: 3,
  allowNewSessions: false,
};

const MINUTE_MS = 60_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/**
 * One field-resolution pattern for a replacement field with a deprecated
 * root-level alias: the replacement wins when valid, the alias is honored only
 * when the replacement is absent, and every rejection warns. A fourth
 * deprecated field is one more declaration of this pattern, not another copy.
 */
function fieldWithDeprecatedFallback(
  options: {
    /** Section object holding the replacement field. */
    section: Record<string, unknown>;
    /** Replacement field key inside `section`. */
    key: string;
    /** Dotted label used in warnings for the replacement. */
    label: string;
    /** Whether the replacement value is usable. */
    isValid: (value: unknown) => value is number;
    /** Warning reason when the replacement is present but unusable. */
    invalidReason: string;
    /** Raw root object holding the deprecated alias. */
    root: Record<string, unknown>;
    /** Deprecated alias key. */
    legacyKey: string;
    /** Whether the alias value is usable. */
    legacyIsValid: (value: unknown) => value is number;
    /** Convert a usable alias value into the replacement's unit. */
    convertLegacy: (value: number) => number;
    /** Warning reason when the alias is present but unusable. */
    legacyInvalidReason: string;
    /** Fallback when neither field is usable. */
    fallback: number;
  },
  warn: ConfigWarnHandler,
): number {
  const primary = options.section[options.key];
  const legacy = options.root[options.legacyKey];
  if (primary !== undefined) {
    if (options.isValid(primary)) {
      if (legacy !== undefined) {
        warn({
          field: options.legacyKey,
          value: legacy,
          reason: `deprecated; ignored because ${options.label} is set`,
        });
      }
      return primary;
    }
    warn({ field: options.label, value: primary, reason: options.invalidReason });
  }
  if (legacy !== undefined) {
    if (options.legacyIsValid(legacy)) return options.convertLegacy(legacy);
    warn({ field: options.legacyKey, value: legacy, reason: options.legacyInvalidReason });
  }
  return options.fallback;
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

/** Parse a proactive delivery mode (`self` | `delegate`). */
function proactiveDeliveryModeFrom(
  source: Record<string, unknown>,
  key: string,
  fallback: ProactiveDeliveryMode,
  warn: ConfigWarnHandler,
  field: string,
): ProactiveDeliveryMode {
  const value = source[key];
  if (value === undefined) return fallback;
  if (value === 'self' || value === 'delegate') return value;
  warn({ field, value, reason: "expected 'self' or 'delegate'; using default" });
  return fallback;
}

/**
 * Resolve the raw user-provided `proactiveChat` slice into the full plugin
 * configuration.
 *
 * This is the plugin's single resolution pass (called once at init): the kernel
 * hands over exactly what the config file said, and missing or malformed fields
 * fall back to {@link DEFAULT_PROACTIVE_CHAT}. The deprecated placeholder fields
 * (`checkIntervalMs`, `idleThresholdMs`, `maxInitiationsPerHour`) are consulted
 * only when their replacements are absent.
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
  const enabled = booleanFrom(root, 'enabled', defaults.enabled);
  if (root['enabled'] !== undefined && typeof root['enabled'] !== 'boolean') {
    warn({ field: 'enabled', value: root['enabled'], reason: 'expected a boolean; using default' });
  }
  const heartbeat = asObject(root['heartbeat']);
  const decision = asObject(root['decision']);
  const emotion = asObject(root['emotion']);
  const context = asObject(root['context']);
  const delayedQueue = asObject(root['delayedQueue']);
  const persona = asObject(root['persona']);
  const persistence = asObject(root['persistence']);
  const delivery = asObject(root['delivery']);
  const quietHours = asObject(decision['quietHours']);

  const intervalMs = fieldWithDeprecatedFallback(
    {
      section: heartbeat,
      key: 'intervalMs',
      label: 'heartbeat.intervalMs',
      isValid: isPositiveFinite,
      invalidReason: 'must be a positive finite number',
      root,
      legacyKey: 'checkIntervalMs',
      legacyIsValid: isPositiveFinite,
      convertLegacy: (value) => value,
      legacyInvalidReason: 'must be a positive finite number; using default',
      fallback: defaults.heartbeat.intervalMs,
    },
    warn,
  );
  const noSendAfterActivityMinutes = fieldWithDeprecatedFallback(
    {
      section: decision,
      key: 'noSendAfterActivityMinutes',
      label: 'decision.noSendAfterActivityMinutes',
      isValid: isFiniteNumber,
      invalidReason: 'expected a finite number; using fallback',
      root,
      legacyKey: 'idleThresholdMs',
      legacyIsValid: isFiniteNumber,
      convertLegacy: (value) => value / MINUTE_MS,
      legacyInvalidReason: 'expected a finite number of milliseconds; using default',
      fallback: defaults.decision.noSendAfterActivityMinutes,
    },
    warn,
  );
  const maxPerHour = fieldWithDeprecatedFallback(
    {
      section: decision,
      key: 'maxPerHour',
      label: 'decision.maxPerHour',
      isValid: isFiniteNumber,
      invalidReason: 'expected a finite number; using fallback',
      root,
      legacyKey: 'maxInitiationsPerHour',
      legacyIsValid: isFiniteNumber,
      convertLegacy: (value) => value,
      legacyInvalidReason: 'expected a finite number; using default',
      fallback: defaults.decision.maxPerHour,
    },
    warn,
  );

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

  const persistenceEnabled = booleanFrom(persistence, 'enabled', defaults.persistence.enabled);
  if (persistence['enabled'] !== undefined && typeof persistence['enabled'] !== 'boolean') {
    warn({
      field: 'persistence.enabled',
      value: persistence['enabled'],
      reason: 'expected a boolean; using default',
    });
  }
  const personaSystemPrompt = stringFrom(persona, 'systemPrompt', defaults.persona.systemPrompt);
  if (persona['systemPrompt'] !== undefined && typeof persona['systemPrompt'] !== 'string') {
    warn({
      field: 'persona.systemPrompt',
      value: persona['systemPrompt'],
      reason: 'expected a string; using default',
    });
  }

  return {
    enabled,
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
      systemPrompt: personaSystemPrompt,
    },
    persistence: {
      enabled: persistenceEnabled,
      saveIntervalTicks: numberField(
        persistence,
        'saveIntervalTicks',
        defaults.persistence.saveIntervalTicks,
        warn,
        'persistence.saveIntervalTicks',
      ),
    },
    delivery: {
      mode: proactiveDeliveryModeFrom(delivery, 'mode', defaults.delivery.mode, warn, 'delivery.mode'),
    },
  };
}
