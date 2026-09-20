import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIME_WINDOWS } from '../builtins/proactive-chat/decision.js';
import { DEFAULT_PERSONA_SYSTEM_PROMPT } from '../builtins/proactive-chat/prompts.js';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_PROACTIVE_CHAT,
  loadConfig,
  resolveProactiveChatConfig,
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
  },
  context: { historyTailMessages: 20 },
  delayedQueue: { maxSize: 10, maxAgeHours: 4 },
  persona: { systemPrompt: DEFAULT_PERSONA_SYSTEM_PROMPT },
};

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
});

describe('resolveProactiveChatConfig', () => {
  it('fills every field from defaults for undefined / garbage input', () => {
    const inputs: unknown[] = [undefined, null, 'nope', 42, [], true];
    for (const input of inputs) {
      expect(resolveProactiveChatConfig(input)).toEqual(RESOLVED_DEFAULTS);
    }
  });

  it('maps deprecated fields when their replacements are absent', () => {
    const resolved = resolveProactiveChatConfig({
      checkIntervalMs: 120_000,
      idleThresholdMs: 600_000,
      maxInitiationsPerHour: 4,
    });

    expect(resolved.heartbeat.intervalMs).toBe(120_000);
    expect(resolved.decision.noSendAfterActivityMinutes).toBe(10);
    expect(resolved.decision.maxPerHour).toBe(4);
  });

  it('prefers replacements over deprecated fields when both are present', () => {
    const resolved = resolveProactiveChatConfig({
      checkIntervalMs: 120_000,
      heartbeat: { intervalMs: 30_000 },
      idleThresholdMs: 600_000,
      maxInitiationsPerHour: 4,
      decision: { noSendAfterActivityMinutes: 1, maxPerHour: 9 },
    });

    expect(resolved.heartbeat.intervalMs).toBe(30_000);
    expect(resolved.decision.noSendAfterActivityMinutes).toBe(1);
    expect(resolved.decision.maxPerHour).toBe(9);
  });

  it('parses valid HH:MM clocks and falls back on invalid ones', () => {
    const valid = resolveProactiveChatConfig({
      decision: { quietHours: { start: '6:15', end: '22:45' } },
    });
    expect(valid.decision.quietHours).toEqual({ start: '6:15', end: '22:45' });

    const invalid = resolveProactiveChatConfig({
      decision: { quietHours: { start: '25:00', end: 'nope' } },
    });
    expect(invalid.decision.quietHours).toEqual({ start: '23:30', end: '07:00' });
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

  it('sanitizes non-numeric emotion fields back to defaults', () => {
    const resolved = resolveProactiveChatConfig({
      emotion: { decayRatePerHour: 'fast', arousalFloor: Number.NaN },
    });
    expect(resolved.emotion.decayRatePerHour).toBe(0.1);
    expect(resolved.emotion.arousalFloor).toBe(0.2);
  });
});

describe('loadConfig', () => {
  it('returns environment/default config when no file exists', () => {
    const config = loadConfig({ configPath: missingConfigPath(), env: {} });

    expect(config.llm.baseURL).toBe('https://api.openai.com/v1');
    expect(config.llm.model).toBe('gpt-4o-mini');
    expect(config.llm.apiKey).toBe('');
    expect(config.llm.requestTimeoutMs).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
    expect(config.plugins.proactiveChat.decision.sendThreshold).toBe(0.6);
  });

  it('parses the request timeout from the environment with a safe fallback', () => {
    expect(
      loadConfig({ configPath: missingConfigPath(), env: { LLM_REQUEST_TIMEOUT_MS: '5000' } }).llm
        .requestTimeoutMs,
    ).toBe(5000);
    expect(
      loadConfig({ configPath: missingConfigPath(), env: { LLM_REQUEST_TIMEOUT_MS: 'nope' } }).llm
        .requestTimeoutMs,
    ).toBe(DEFAULT_LLM_REQUEST_TIMEOUT_MS);
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

    const config = loadConfig({ configPath: path, env: {} });
    const slice = config.plugins.proactiveChat;

    expect(slice.decision.sendThreshold).toBe(0.9);
    // Sibling fields inside the same section keep their defaults.
    expect(slice.decision.holdThreshold).toBe(0.3);
    expect(slice.decision.quietHours).toEqual({ start: '23:30', end: '07:00' });
    expect(slice.emotion.useLlmAssessment).toBe(true);
    expect(slice.emotion.arousalFloor).toBe(0.2);
    expect(slice.enabled).toBe(true);
  });

  it('overrides the LLM request timeout from the config file', () => {
    const path = tempConfigPath(JSON.stringify({ llm: { requestTimeoutMs: 1234 } }));

    const config = loadConfig({ configPath: path, env: {} });
    expect(config.llm.requestTimeoutMs).toBe(1234);
  });

  it('throws a path-qualified error for malformed files', () => {
    const path = tempConfigPath('{ not json');
    expect(() => loadConfig({ configPath: path, env: {} })).toThrow(/failed to parse/);
  });
});
