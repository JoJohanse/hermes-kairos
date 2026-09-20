import { describe, expect, it } from 'vitest';
import type { ConfigWarning } from '../../config/fields.js';
import { DEFAULT_PROACTIVE_CHAT, resolveProactiveChatConfig } from './config.js';
import { DEFAULT_TIME_WINDOWS } from './decision.js';
import {
  DEFAULT_INTERACTION_SOCIAL_NEED_RESET,
  DEFAULT_USER_MESSAGE_AROUSAL_BUMP,
} from './emotion.js';
import { DEFAULT_PERSONA_SYSTEM_PROMPT } from './prompts.js';

/** The fully-resolved default shape (note: no deprecated placeholder fields). */
const RESOLVED_DEFAULTS = {
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
    userMessageArousalBump: 0.3,
    interactionSocialNeedReset: 0.1,
  },
  context: { historyTailMessages: 20 },
  delayedQueue: { maxSize: 10, maxAgeHours: 4 },
  persona: { systemPrompt: DEFAULT_PERSONA_SYSTEM_PROMPT },
  persistence: { enabled: true, saveIntervalTicks: 20 },
  delivery: { mode: 'self' },
};

/** Collect warnings instead of letting them reach the console. */
function collector(): { warnings: ConfigWarning[]; onWarn: (warning: ConfigWarning) => void } {
  const warnings: ConfigWarning[] = [];
  return { warnings, onWarn: (warning) => warnings.push(warning) };
}

describe('DEFAULT_PROACTIVE_CHAT', () => {
  it('exposes the resolved defaults plus deprecated placeholders', () => {
    expect(DEFAULT_PROACTIVE_CHAT).toMatchObject(RESOLVED_DEFAULTS);
    expect(DEFAULT_PROACTIVE_CHAT.checkIntervalMs).toBe(60_000);
    expect(DEFAULT_PROACTIVE_CHAT.idleThresholdMs).toBe(5 * 60_000);
    expect(DEFAULT_PROACTIVE_CHAT.maxInitiationsPerHour).toBe(3);
    expect(DEFAULT_PROACTIVE_CHAT.allowNewSessions).toBe(false);
  });

  it('exposes the interaction-coupling constants', () => {
    expect(DEFAULT_USER_MESSAGE_AROUSAL_BUMP).toBe(0.3);
    expect(DEFAULT_INTERACTION_SOCIAL_NEED_RESET).toBe(0.1);
    expect(DEFAULT_PROACTIVE_CHAT.emotion.userMessageArousalBump).toBe(
      DEFAULT_USER_MESSAGE_AROUSAL_BUMP,
    );
    expect(DEFAULT_PROACTIVE_CHAT.emotion.interactionSocialNeedReset).toBe(
      DEFAULT_INTERACTION_SOCIAL_NEED_RESET,
    );
    expect(DEFAULT_PROACTIVE_CHAT.persistence).toEqual({ enabled: true, saveIntervalTicks: 20 });
  });
});

describe('resolveProactiveChatConfig', () => {
  it('fills every field from defaults for undefined / garbage input', () => {
    const inputs: unknown[] = [undefined, null, 'nope', 42, [], true];
    for (const input of inputs) {
      const { warnings, onWarn } = collector();
      const resolved = resolveProactiveChatConfig(input, { onWarn });
      expect(resolved).toEqual(RESOLVED_DEFAULTS);
      if (input === undefined) {
        expect(warnings).toEqual([]);
      } else {
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]?.field).toBe('proactiveChat');
      }
    }
  });

  it('maps deprecated fields when their replacements are absent', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig(
      {
        checkIntervalMs: 120_000,
        idleThresholdMs: 600_000,
        maxInitiationsPerHour: 4,
      },
      { onWarn },
    );

    expect(resolved.heartbeat.intervalMs).toBe(120_000);
    expect(resolved.decision.noSendAfterActivityMinutes).toBe(10);
    expect(resolved.decision.maxPerHour).toBe(4);
    expect(warnings).toEqual([]);
  });

  it('prefers replacements over deprecated fields and warns that they were ignored', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig(
      {
        checkIntervalMs: 120_000,
        heartbeat: { intervalMs: 30_000 },
        idleThresholdMs: 600_000,
        maxInitiationsPerHour: 4,
        decision: { noSendAfterActivityMinutes: 1, maxPerHour: 9 },
      },
      { onWarn },
    );

    expect(resolved.heartbeat.intervalMs).toBe(30_000);
    expect(resolved.decision.noSendAfterActivityMinutes).toBe(1);
    expect(resolved.decision.maxPerHour).toBe(9);
    expect(warnings.map((warning) => warning.field)).toEqual([
      'checkIntervalMs',
      'idleThresholdMs',
      'maxInitiationsPerHour',
    ]);
  });

  it('parses valid HH:MM clocks and warns before falling back on invalid ones', () => {
    const validResult = collector();
    const valid = resolveProactiveChatConfig(
      { decision: { quietHours: { start: '6:15', end: '22:45' } } },
      { onWarn: validResult.onWarn },
    );
    expect(valid.decision.quietHours).toEqual({ start: '6:15', end: '22:45' });
    expect(validResult.warnings).toEqual([]);

    const invalidResult = collector();
    const invalid = resolveProactiveChatConfig(
      { decision: { quietHours: { start: '25:00', end: 'nope' } } },
      { onWarn: invalidResult.onWarn },
    );
    expect(invalid.decision.quietHours).toEqual({ start: '23:30', end: '07:00' });
    expect(invalidResult.warnings.map((warning) => warning.field)).toEqual([
      'decision.quietHours.start',
      'decision.quietHours.end',
    ]);
  });

  it('falls back for empty or malformed time windows', () => {
    expect(
      resolveProactiveChatConfig({ decision: { timeWindows: [] } }).decision.timeWindows,
    ).toEqual([...DEFAULT_TIME_WINDOWS]);
    expect(
      resolveProactiveChatConfig({ decision: { timeWindows: [{ startMinute: 1, endMinute: 2 }] } })
        .decision.timeWindows,
    ).toEqual([...DEFAULT_TIME_WINDOWS]);

    const custom = [{ startMinute: 60, endMinute: 120, fitness: 0.5 }];
    expect(
      resolveProactiveChatConfig({ decision: { timeWindows: custom } }).decision.timeWindows,
    ).toEqual(custom);
  });

  it('warns about and sanitizes non-numeric emotion fields back to defaults', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig(
      {
        emotion: {
          decayRatePerHour: 'fast',
          arousalFloor: Number.NaN,
          userMessageArousalBump: null,
          interactionSocialNeedReset: 'low',
        },
      },
      { onWarn },
    );
    expect(resolved.emotion.decayRatePerHour).toBe(0.1);
    expect(resolved.emotion.arousalFloor).toBe(0.2);
    expect(resolved.emotion.userMessageArousalBump).toBe(0.3);
    expect(resolved.emotion.interactionSocialNeedReset).toBe(0.1);
    expect(warnings.map((warning) => warning.field)).toEqual([
      'emotion.decayRatePerHour',
      'emotion.arousalFloor',
      'emotion.userMessageArousalBump',
      'emotion.interactionSocialNeedReset',
    ]);
  });

  it('warns about semantically invalid thresholds without rejecting them', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig(
      {
        decision: {
          sendThreshold: 0.1,
          holdThreshold: 0.5,
          maxPerHour: 0,
          maxPerDay: -1,
          cooldownMinutes: 0,
        },
      },
      { onWarn },
    );

    expect(resolved.decision.sendThreshold).toBe(0.1);
    expect(resolved.decision.holdThreshold).toBe(0.5);
    expect(warnings.map((warning) => warning.field)).toEqual([
      'decision.sendThreshold',
      'decision.maxPerHour',
      'decision.maxPerDay',
      'decision.cooldownMinutes',
    ]);
  });

  it('warns about invalid heartbeat and persistence numbers', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig(
      { heartbeat: { intervalMs: 'soon' }, persistence: { saveIntervalTicks: 0 } },
      { onWarn },
    );
    expect(resolved.heartbeat.intervalMs).toBe(60_000);
    expect(resolved.persistence.saveIntervalTicks).toBe(0);
    expect(warnings.map((warning) => warning.field)).toEqual([
      'heartbeat.intervalMs',
      'persistence.saveIntervalTicks',
    ]);
  });

  it('warns about wrong-typed enabled/persistence/persona fields and uses defaults', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig(
      {
        enabled: 'yes',
        persistence: { enabled: 1 },
        persona: { systemPrompt: 42 },
      },
      { onWarn },
    );

    expect(resolved.enabled).toBe(true);
    expect(resolved.persistence.enabled).toBe(true);
    expect(resolved.persona.systemPrompt).toBe(DEFAULT_PERSONA_SYSTEM_PROMPT);
    expect(warnings.map((warning) => warning.field)).toEqual([
      'enabled',
      'persistence.enabled',
      'persona.systemPrompt',
    ]);
  });

  it('emits no warnings for a fully valid config', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig(
      {
        enabled: true,
        heartbeat: { intervalMs: 45_000 },
        decision: {
          sendThreshold: 0.7,
          holdThreshold: 0.3,
          maxPerHour: 3,
          maxPerDay: 9,
          cooldownMinutes: 15,
          noSendAfterActivityMinutes: 4,
          quietHours: { start: '22:00', end: '06:30' },
        },
        emotion: {
          decayRatePerHour: 0.2,
          socialNeedGrowthPerHour: 0.1,
          arousalFloor: 0.1,
          useLlmAssessment: true,
          userMessageArousalBump: 0.4,
          interactionSocialNeedReset: 0.05,
        },
        context: { historyTailMessages: 10 },
        delayedQueue: { maxSize: 5, maxAgeHours: 2 },
        persona: { systemPrompt: 'custom' },
        persistence: { enabled: false, saveIntervalTicks: 5 },
      },
      { onWarn },
    );

    expect(warnings).toEqual([]);
    expect(resolved.heartbeat.intervalMs).toBe(45_000);
    expect(resolved.persistence).toEqual({ enabled: false, saveIntervalTicks: 5 });
  });

  it('resolves delivery.mode and warns on an invalid value', () => {
    expect(resolveProactiveChatConfig({ delivery: { mode: 'delegate' } }).delivery).toEqual({
      mode: 'delegate',
    });

    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig({ delivery: { mode: 'nope' } }, { onWarn });
    expect(resolved.delivery).toEqual({ mode: 'self' });
    expect(warnings.map((warning) => warning.field)).toEqual(['delivery.mode']);
  });
});
