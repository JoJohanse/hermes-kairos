import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type HermesConfig } from '../config/config.js';
import { MockProvider } from '../llm/mock.js';
import type { ProactiveDeliveryPayload } from '../builtins/proactive-chat/types.js';
import {
  bootBridge,
  BridgeDisabledError,
  createDeliveryHandler,
  type BridgeBootProcess,
  type BridgeFetch,
} from './main.js';
import { pidFilePath, type PidFileFs } from './pidfile.js';

/** `loadConfig` with no file and no env, so tests are hermetic. */
function hermeticConfig(): HermesConfig {
  return loadConfig({ configPath: join(tmpdir(), `no-such-${randomUUID()}.json`), env: {} });
}

function bootConfig(overrides: Partial<HermesConfig['hermesBridge']> = {}): HermesConfig {
  const config = hermeticConfig();
  return {
    ...config,
    storage: { dataDir: join(tmpdir(), `kairos-boot-${randomUUID()}`) },
    hermesBridge: {
      ...config.hermesBridge,
      enabled: true,
      port: 0,
      ...overrides,
    },
  };
}

class FakeBootProcess implements BridgeBootProcess {
  readonly pid = 4242;
  exitCode: number | null = null;
  readonly signals = new Map<string, Array<() => void>>();

  onSignal(signal: string, handler: () => void): void {
    const handlers = this.signals.get(signal) ?? [];
    handlers.push(handler);
    this.signals.set(signal, handlers);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  emit(signal: string): void {
    for (const handler of this.signals.get(signal) ?? []) handler();
  }
}

/** In-memory {@link PidFileFs} mirroring the pidfile tests. */
class MemoryPidFs implements PidFileFs {
  readonly files = new Map<string, string>();
  exists(path: string): boolean {
    return this.files.has(path);
  }
  readFile(path: string): string {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }
  writeFile(path: string, data: string): void {
    this.files.set(path, data);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  mkdir(): void {}
}

function recordingLogger(): {
  lines: Array<{ level: string; message: string }>;
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
} {
  const lines: Array<{ level: string; message: string }> = [];
  const record =
    (level: string) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  return { lines, logger: { info: record('info'), warn: record('warn'), error: record('error') } };
}

const okFetch: BridgeFetch = async () => ({ ok: true, status: 200 });

describe('bootBridge', () => {
  const dataDirs: string[] = [];

  afterEach(() => {
    while (dataDirs.length > 0) {
      const dir = dataDirs.pop() as string;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function trackDataDir(config: HermesConfig): HermesConfig {
    dataDirs.push(config.storage.dataDir);
    return config;
  }

  it('throws BridgeDisabledError and never binds when hermesBridge is disabled', async () => {
    const config = hermeticConfig();
    await expect(
      bootBridge({ config, llm: new MockProvider(), process: new FakeBootProcess() }),
    ).rejects.toBeInstanceOf(BridgeDisabledError);
  });

  it('boots end to end: binds, writes the pidfile, registers shutdown signals', async () => {
    const config = trackDataDir(bootConfig({ deliveryMode: 'turn' }));
    const pidFs = new MemoryPidFs();
    const proc = new FakeBootProcess();
    const { lines, logger } = recordingLogger();

    const handle = await bootBridge({
      argv: ['--nonce', 'boot-nonce'],
      config,
      llm: new MockProvider(),
      fetchImpl: okFetch,
      logger,
      pidFs,
      process: proc,
    });

    // turn → delegate mapping is owned by the boot module.
    expect(handle.deliveryMode).toBe('delegate');
    expect(handle.plugin.config?.delivery.mode).toBe('delegate');
    expect(pidFs.files.get(pidFilePath(config.storage.dataDir))).toBe(
      '{"pid":4242,"nonce":"boot-nonce"}',
    );
    expect(proc.signals.get('SIGINT')?.length).toBe(1);
    expect(lines.some((line) => line.message.includes('listening on http://'))).toBe(true);

    await handle.stop();
    expect(handle.runtime.started).toBe(false);
    expect(pidFs.files.has(pidFilePath(config.storage.dataDir))).toBe(false);
  });

  it('signal-driven stop shuts the server down and removes the pidfile', async () => {
    const config = trackDataDir(bootConfig());
    const pidFs = new MemoryPidFs();
    const proc = new FakeBootProcess();

    const handle = await bootBridge({
      config,
      llm: new MockProvider(),
      fetchImpl: okFetch,
      logger: recordingLogger().logger,
      pidFs,
      process: proc,
    });

    proc.emit('SIGTERM');
    // The handler is fire-and-forget; give the shutdown a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handle.runtime.started).toBe(false);
    expect(pidFs.files.has(pidFilePath(config.storage.dataDir))).toBe(false);
    expect(proc.exitCode).toBeNull();
  });

  it('stop() is idempotent: a second call does nothing', async () => {
    const config = trackDataDir(bootConfig());
    const pidFs = new MemoryPidFs();
    const proc = new FakeBootProcess();

    const handle = await bootBridge({
      config,
      llm: new MockProvider(),
      fetchImpl: okFetch,
      logger: recordingLogger().logger,
      pidFs,
      process: proc,
    });

    await handle.stop();
    await handle.stop();
    expect(handle.runtime.started).toBe(false);
  });

  it('stops the runtime before rejecting when the port cannot be bound', async () => {
    const config = trackDataDir(bootConfig({ port: 8671, host: '127.0.0.1' }));
    const pidFs = new MemoryPidFs();
    const proc = new FakeBootProcess();
    const { lines, logger } = recordingLogger();

    const first = await bootBridge({
      config,
      llm: new MockProvider(),
      fetchImpl: okFetch,
      logger,
      pidFs,
      process: proc,
    });

    await expect(
      bootBridge({
        config: { ...config, storage: { dataDir: config.storage.dataDir } },
        llm: new MockProvider(),
        fetchImpl: okFetch,
        logger,
        pidFs: new MemoryPidFs(),
        process: new FakeBootProcess(),
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });

    // The failed boot must not leave a started runtime behind.
    expect(lines.some((line) => line.message.includes('failed to bind'))).toBe(true);
    await first.stop();
  });
});

describe('createDeliveryHandler', () => {
  const injectPayload: ProactiveDeliveryPayload = {
    kind: 'inject',
    sessionId: 's1',
    directive: 'Reach out',
    score: 0.7,
    breakdown: {},
  };

  it('POSTs via the injected transport with the bearer token', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl: BridgeFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200 };
    };

    const handler = createDeliveryHandler({
      callbackUrl: 'http://callback.test/speak',
      token: 'tok',
      fetchImpl,
      logger: recordingLogger().logger,
    });

    await handler(injectPayload);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://callback.test/speak');
    expect(calls[0]?.headers['authorization']).toBe('Bearer tok');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ kind: 'inject', sessionId: 's1' });
  });

  it('throws on an unsupported payload instead of POSTing', async () => {
    let called = 0;
    const fetchImpl: BridgeFetch = async () => {
      called += 1;
      return { ok: true, status: 200 };
    };
    const handler = createDeliveryHandler({
      callbackUrl: 'http://callback.test/speak',
      token: '',
      fetchImpl,
      logger: recordingLogger().logger,
    });

    await expect(
      handler({ kind: 'send', sessionId: 's1', score: 0.5, breakdown: {} }),
    ).rejects.toThrow('unsupported delivery payload');
    expect(called).toBe(0);
  });
});
