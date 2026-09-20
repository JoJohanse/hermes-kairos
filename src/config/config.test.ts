import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIME_WINDOWS } from '../builtins/proactive-chat/decision.js';
import { DEFAULT_PERSONA_SYSTEM_PROMPT } from '../builtins/proactive-chat/prompts.js';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_PROACTIVE_CHAT,
  DEFAULT_STORAGE_DATA_DIR,
  loadConfig,
  resolveProactiveChatConfig,
  type ConfigWarning,
} from './config.js';

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
};

/** Collect warnings instead of letting them reach the console. */
function collector(): { warnings: ConfigWarning[]; onWarn: (warning: ConfigWarning) => void } {
  const warnings: ConfigWarning[] = [];
  return { warnings, onWarn: (warning) => warnings.push(warning) };
}

const tempDirs: string[] = [];

function tempConfigPath(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'hermes.config.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

function missingConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-config-'));
  tempDirs.push(dir);
  return join(dir, 'absent.json');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('DEFAULT_PROACTIVE_CHAT', () => {
  it('exposes the resolved defaults plus deprecated placeholders', () => {
    expect(DEFAULT_PROACTIVE_CHAT).toMatchObject(RESOLVED_DEFAULTS);
    expect(DEFAULT_PROACTIVE_CHAT.checkIntervalMs).toBe(60_000);
    expect(DEFAULT_PROACTIVE_CHAT.idleThresholdMs).toBe(5 * 60_000);
    expect(DEFAULT_PROACTIVE_CHAT.maxInitiationsPerHour).toBe(3);
    expect(DEFAULT_PROACTIVE_CHAT.allowNewSessions).toBe(false);
  });

  it('exposes the interaction-coupling constants', () => {
    expect(DEFAULT_PROACTIVE_CHAT.emotion.userMessageArousalBump).toBe(0.3);
    expect(DEFAULT_PROACTIVE_CHAT.emotion.interactionSocialNeedReset).toBe(0.1);
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
});

describe('loadConfig', () => {
  it('returns environment/default config when no file exists', () => {
    const config = loadConfig({ configPath: missingConfigPath(), env: {} });

    expect(config.llm.baseURL).toBe('https://api.openai.com/v1');
    expect(config.llm.model).toBe('gpt-4o-mini');
    expect(config.llm.apiKey).toBe('');
    expect(config.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(config.storage.dataDir).toBe(DEFAULT_STORAGE_DATA_DIR);
    expect(config.plugins.proactiveChat.decision.sendThreshold).toBe(0.6);
  });

  it('parses the request timeout from the environment with a safe fallback', () => {
    expect(
      loadConfig({ configPath: missingConfigPath(), env: { LLM_REQUEST_TIMEOUT_MS: '5000' } }).llm
        .requestTimeoutMs,
    ).toBe(5000);

    const { warnings, onWarn } = collector();
    const fallback = loadConfig({
      configPath: missingConfigPath(),
      env: { LLM_REQUEST_TIMEOUT_MS: 'nope' },
      onWarn,
    });
    expect(fallback.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(warnings.map((warning) => warning.field)).toEqual(['llm.requestTimeoutMs']);
  });

  it('deep-merges partial plugin slices over the defaults', () => {
    const path = tempConfigPath(
      JSON.stringify({
        plugins: {
          proactiveChat: {
            decision: { sendThreshold: 0.9 },
            emotion: { useLlmAssessment: true },
          },
        },
      }),
    );

    const { warnings, onWarn } = collector();
    const config = loadConfig({ configPath: path, env: {}, onWarn });
    const slice = config.plugins.proactiveChat;

    expect(slice.decision.sendThreshold).toBe(0.9);
    // Sibling fields inside the same section keep their defaults.
    expect(slice.decision.holdThreshold).toBe(0.3);
    expect(slice.decision.quietHours).toEqual({ start: '23:30', end: '07:00' });
    expect(slice.emotion.useLlmAssessment).toBe(true);
    expect(slice.emotion.arousalFloor).toBe(0.2);
    expect(slice.enabled).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('overrides the LLM request timeout from the config file', () => {
    const path = tempConfigPath(JSON.stringify({ llm: { requestTimeoutMs: 1234 } }));

    const config = loadConfig({ configPath: path, env: {} });
    expect(config.llm.requestTimeoutMs).toBe(1234);
  });

  it('honors a valid storage.dataDir and warns about invalid ones', () => {
    const validPath = tempConfigPath(JSON.stringify({ storage: { dataDir: 'custom-data' } }));
    expect(loadConfig({ configPath: validPath, env: {} }).storage.dataDir).toBe('custom-data');

    const invalidPath = tempConfigPath(JSON.stringify({ storage: { dataDir: 42 } }));
    const { warnings, onWarn } = collector();
    const config = loadConfig({ configPath: invalidPath, env: {}, onWarn });
    expect(config.storage.dataDir).toBe(DEFAULT_STORAGE_DATA_DIR);
    expect(warnings.map((warning) => warning.field)).toEqual(['storage.dataDir']);
  });

  it('warns when a file supplies an invalid request timeout', () => {
    const path = tempConfigPath(JSON.stringify({ llm: { requestTimeoutMs: -5 } }));
    const { warnings, onWarn } = collector();
    const config = loadConfig({ configPath: path, env: {}, onWarn });
    expect(config.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(warnings.map((warning) => warning.field)).toEqual(['llm.requestTimeoutMs']);
  });

  it('warns when file sections are present but not objects', () => {
    const path = tempConfigPath(JSON.stringify({ plugins: 5, llm: 'x', storage: [] }));
    const { warnings, onWarn } = collector();
    const config = loadConfig({ configPath: path, env: {}, onWarn });

    expect(warnings.map((warning) => warning.field)).toEqual(['plugins', 'llm', 'storage']);
    expect(warnings.every((warning) => warning.reason === 'not an object; section ignored')).toBe(
      true,
    );
    // The malformed sections are ignored wholesale; defaults still apply.
    expect(config.storage.dataDir).toBe(DEFAULT_STORAGE_DATA_DIR);
    expect(config.plugins.proactiveChat.decision.sendThreshold).toBe(0.6);
  });

  it('does not emit spurious deprecated warnings for the default slice', () => {
    const config = loadConfig({ configPath: missingConfigPath(), env: {} });
    const { warnings, onWarn } = collector();
    resolveProactiveChatConfig(config.plugins.proactiveChat, { onWarn });
    expect(warnings).toEqual([]);
  });

  it('warns when the file explicitly sets a deprecated field', () => {
    const path = tempConfigPath(
      JSON.stringify({ plugins: { proactiveChat: { checkIntervalMs: 120_000 } } }),
    );
    const config = loadConfig({ configPath: path, env: {} });
    const { warnings, onWarn } = collector();
    resolveProactiveChatConfig(config.plugins.proactiveChat, { onWarn });
    expect(warnings.map((warning) => warning.field)).toEqual(['checkIntervalMs']);
  });

  it('throws a path-qualified error for malformed files', () => {
    const path = tempConfigPath('{ not json');
    expect(() => loadConfig({ configPath: path, env: {} })).toThrow(/failed to parse/);
  });
});
