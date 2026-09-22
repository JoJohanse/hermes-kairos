import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProactiveChatConfig } from '../builtins/proactive-chat/config.js';
import {
  DEFAULT_HERMES_BRIDGE,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_STORAGE_DATA_DIR,
  loadConfig,
  resolveHermesBridgeConfig,
  type ConfigWarning,
} from './config.js';

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

describe('hermesBridge config', () => {
  it('exposes disabled-by-default bridge defaults', () => {
    expect(DEFAULT_HERMES_BRIDGE).toEqual({
      enabled: false,
      port: 8671,
      host: '127.0.0.1',
      token: '',
      callbackUrl: 'http://127.0.0.1:8672/speak',
      deliveryMode: 'turn',
    });
  });

  it('fills defaults for an empty object and warns for non-object input', () => {
    expect(resolveHermesBridgeConfig({})).toEqual(DEFAULT_HERMES_BRIDGE);

    const { warnings, onWarn } = collector();
    expect(resolveHermesBridgeConfig('nope', { onWarn })).toEqual(DEFAULT_HERMES_BRIDGE);
    expect(warnings.map((warning) => warning.field)).toEqual(['hermesBridge']);
  });

  it('sanitizes malformed fields and warns once per field', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveHermesBridgeConfig(
      { enabled: 'yes', port: 'nope', host: 5, callbackUrl: [], deliveryMode: 'shout' },
      { onWarn },
    );
    expect(resolved).toEqual(DEFAULT_HERMES_BRIDGE);
    expect(warnings.map((warning) => warning.field)).toEqual([
      'hermesBridge.enabled',
      'hermesBridge.port',
      'hermesBridge.host',
      'hermesBridge.callbackUrl',
      'hermesBridge.deliveryMode',
    ]);
  });

  it('accepts a fully valid bridge config with zero warnings', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveHermesBridgeConfig(
      {
        enabled: true,
        port: 9000,
        host: '0.0.0.0',
        token: 'secret',
        callbackUrl: 'http://example.test/speak',
        deliveryMode: 'verbatim',
      },
      { onWarn },
    );
    expect(resolved).toEqual({
      enabled: true,
      port: 9000,
      host: '0.0.0.0',
      token: 'secret',
      callbackUrl: 'http://example.test/speak',
      deliveryMode: 'verbatim',
    });
    expect(warnings).toEqual([]);
  });

  it('warns about an out-of-range port without rejecting it', () => {
    const { warnings, onWarn } = collector();
    const resolved = resolveHermesBridgeConfig({ port: 70000 }, { onWarn });
    expect(resolved.port).toBe(70000);
    expect(warnings.map((warning) => warning.field)).toEqual(['hermesBridge.port']);
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
    // The kernel injects no plugin defaults; the plugin resolves its own.
    expect(config.plugins.proactiveChat).toEqual({});
  });

  it('includes hermesBridge defaults and deep-merges file overrides', () => {
    const base = loadConfig({ configPath: missingConfigPath(), env: {} });
    expect(base.hermesBridge).toEqual(DEFAULT_HERMES_BRIDGE);

    const path = tempConfigPath(
      JSON.stringify({ hermesBridge: { enabled: true, port: 9001, deliveryMode: 'verbatim' } }),
    );
    const config = loadConfig({ configPath: path, env: {} });
    expect(config.hermesBridge).toEqual({
      ...DEFAULT_HERMES_BRIDGE,
      enabled: true,
      port: 9001,
      deliveryMode: 'verbatim',
    });
  });

  it('treats a non-object hermesBridge section as ignored and warns', () => {
    const path = tempConfigPath(JSON.stringify({ hermesBridge: 5 }));
    const { warnings, onWarn } = collector();
    const config = loadConfig({ configPath: path, env: {}, onWarn });
    expect(config.hermesBridge).toEqual(DEFAULT_HERMES_BRIDGE);
    expect(warnings.map((warning) => warning.field)).toEqual(['hermesBridge']);
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

  it('warns on malformed llm fields and falls back to defaults', () => {
    const path = tempConfigPath(
      JSON.stringify({ llm: { baseURL: 42, model: '', apiKey: 7 } }),
    );
    const { warnings, onWarn } = collector();
    const config = loadConfig({ configPath: path, env: {}, onWarn });

    expect(config.llm.baseURL).toBe('https://api.openai.com/v1');
    expect(config.llm.model).toBe('gpt-4o-mini');
    expect(config.llm.apiKey).toBe('');
    expect(warnings.map((warning) => warning.field)).toEqual([
      'llm.baseURL',
      'llm.apiKey',
      'llm.model',
    ]);
  });

  it('accepts a fully valid llm section with zero warnings', () => {
    const path = tempConfigPath(
      JSON.stringify({
        llm: { baseURL: 'http://localhost:1234/v1', apiKey: 'secret', model: 'test-model' },
      }),
    );
    const { warnings, onWarn } = collector();
    const config = loadConfig({ configPath: path, env: {}, onWarn });

    expect(config.llm).toMatchObject({
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'secret',
      model: 'test-model',
    });
    expect(warnings).toEqual([]);
  });

  it('passes partial plugin slices through raw; the plugin resolves them over the defaults', () => {
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

    // Kernel layer: exactly the user's fields, with no injected defaults.
    expect(slice).toEqual({
      decision: { sendThreshold: 0.9 },
      emotion: { useLlmAssessment: true },
    });
    expect(warnings).toEqual([]);

    // Plugin layer: sibling fields inside the same section keep their defaults.
    const resolved = resolveProactiveChatConfig(slice, { onWarn });
    expect(resolved.decision.sendThreshold).toBe(0.9);
    expect(resolved.decision.holdThreshold).toBe(0.3);
    expect(resolved.decision.quietHours).toEqual({ start: '23:30', end: '07:00' });
    expect(resolved.emotion.useLlmAssessment).toBe(true);
    expect(resolved.emotion.arousalFloor).toBe(0.2);
    expect(resolved.enabled).toBe(true);
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
    expect(config.plugins.proactiveChat).toEqual({});
  });

  it('does not emit spurious deprecated warnings for the default slice', () => {
    const config = loadConfig({ configPath: missingConfigPath(), env: {} });
    // No plugin section in the file means no user intent, structurally.
    expect(config.plugins.proactiveChat).toEqual({});
    const { warnings, onWarn } = collector();
    resolveProactiveChatConfig(config.plugins.proactiveChat, { onWarn });
    expect(warnings).toEqual([]);
  });

  it('warns when the file explicitly sets a deprecated field', () => {
    // The "deprecated; ignored" warning fires when the replacement is present:
    // with the kernel no longer injecting defaults, the file must set both.
    const path = tempConfigPath(
      JSON.stringify({
        plugins: {
          proactiveChat: { checkIntervalMs: 120_000, heartbeat: { intervalMs: 30_000 } },
        },
      }),
    );
    const config = loadConfig({ configPath: path, env: {} });
    // The raw slice carries exactly what the file said.
    expect(config.plugins.proactiveChat).toEqual({
      checkIntervalMs: 120_000,
      heartbeat: { intervalMs: 30_000 },
    });
    const { warnings, onWarn } = collector();
    const resolved = resolveProactiveChatConfig(config.plugins.proactiveChat, { onWarn });
    expect(resolved.heartbeat.intervalMs).toBe(30_000);
    expect(warnings.map((warning) => warning.field)).toEqual(['checkIntervalMs']);
    expect(warnings[0]?.reason).toBe('deprecated; ignored because heartbeat.intervalMs is set');
  });

  it('throws a path-qualified error for malformed files', () => {
    const path = tempConfigPath('{ not json');
    expect(() => loadConfig({ configPath: path, env: {} })).toThrow(/failed to parse/);
  });
});
