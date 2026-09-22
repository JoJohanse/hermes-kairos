import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  listenWithStalePidRecovery,
  parsePidFile,
  pidFilePath,
  readPidFile,
  removePidFile,
  writePidFile,
  type BindableServer,
  type PidFileFs,
} from './pidfile.js';

/** In-memory {@link PidFileFs} for deterministic pidfile tests. */
class MemoryPidFs implements PidFileFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

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

  mkdir(path: string): void {
    this.dirs.add(path);
  }
}

const quietLogger = { warn: () => {}, error: () => {} };

interface FakeServer extends BindableServer {
  calls: number;
}

function serverFailingFirst(failures: number): FakeServer {
  return {
    calls: 0,
    async listen(): Promise<void> {
      this.calls += 1;
      if (this.calls <= failures) {
        const error = new Error('address in use') as Error & { code?: string };
        error.code = 'EADDRINUSE';
        throw error;
      }
    },
  };
}

describe('sidecar pidfile', () => {
  it('writes and reads back { pid, nonce }', () => {
    const fs = new MemoryPidFs();
    writePidFile(fs, 'data', { pid: 4242, nonce: 'nonce-1' });

    expect(fs.dirs.has('data')).toBe(true);
    expect(fs.files.get(pidFilePath('data'))).toBe('{"pid":4242,"nonce":"nonce-1"}');
    expect(readPidFile(fs, 'data')).toEqual({ pid: 4242, nonce: 'nonce-1' });
  });

  it('tolerates a bare "<pid>" / "<pid> <nonce>" body from another writer', () => {
    expect(parsePidFile('1234')).toEqual({ pid: 1234, nonce: '' });
    expect(parsePidFile('1234 abc')).toEqual({ pid: 1234, nonce: 'abc' });
    expect(parsePidFile('not-a-pid')).toBeUndefined();
    expect(parsePidFile('')).toBeUndefined();
    expect(parsePidFile('{ not json')).toBeUndefined();
  });

  it('readPidFile returns undefined for a missing file and remove is idempotent', () => {
    const fs = new MemoryPidFs();
    expect(readPidFile(fs, 'data')).toBeUndefined();
    expect(() => removePidFile(fs, 'data')).not.toThrow();
  });
});

describe('pidfile body contract (contract.json pidfile.body)', () => {
  interface PidfileContract {
    filename: string;
    writer: string;
    body: { format: string; canonicalExample: string; legacyTolerated: string[] };
  }
  const contractPath = new URL('./contract.json', import.meta.url);
  const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
    pidfile: PidfileContract;
  };

  it('pins the filename and the writer lane', () => {
    expect(contract.pidfile.filename).toBe('sidecar.pid');
    expect(pidFilePath('data').endsWith(contract.pidfile.filename)).toBe(true);
    expect(contract.pidfile.writer).toBe('sidecar');
  });

  it('writes exactly the canonical body shape the contract names', () => {
    const fs = new MemoryPidFs();
    writePidFile(fs, 'data', { pid: 4242, nonce: 'nonce-1' });
    const written = fs.files.get(pidFilePath('data')) as string;

    const canonical = contract.pidfile.body.canonicalExample;
    expect(contract.pidfile.body.format).toBe('json');
    expect(Object.keys(JSON.parse(written)).sort()).toEqual(
      Object.keys(JSON.parse(canonical)).sort(),
    );
    expect(parsePidFile(canonical)).toEqual({ pid: 1234, nonce: '0aff42' });
    expect(parsePidFile(written)).toEqual({ pid: 4242, nonce: 'nonce-1' });
  });

  it('still recovers from every legacy body the contract tolerates', () => {
    for (const legacy of contract.pidfile.body.legacyTolerated) {
      const body = legacy.replace('<pid>', '1234').replace('<nonce>', 'abc');
      expect(parsePidFile(body)).toMatchObject({ pid: 1234 });
    }
  });

  it('is byte-identical to the python-side mirror', () => {
    const mirrorPath = new URL('../../hermes-plugin/kairos/tests/contract.json', import.meta.url);
    expect(readFileSync(mirrorPath).equals(readFileSync(contractPath))).toBe(true);
  });
});

describe('stale-bind recovery (F5)', () => {
  it('kills the recorded live process, waits 1s and retries the bind once', async () => {
    const fs = new MemoryPidFs();
    // `process.pid` is always alive — and the injected killer must keep us safe.
    writePidFile(fs, 'data', { pid: process.pid, nonce: 'n' });
    const server = serverFailingFirst(1);
    const kill = vi.fn(async () => {});
    const wait = vi.fn(async () => {});

    await listenWithStalePidRecovery(server, {
      dataDir: 'data',
      fs,
      killProcess: kill,
      wait,
      logger: quietLogger,
    });

    expect(server.calls).toBe(2);
    expect(kill).toHaveBeenCalledWith(process.pid);
    expect(wait).toHaveBeenCalledWith(1000);
  });

  it('propagates the bind error when no pidfile is recorded', async () => {
    const fs = new MemoryPidFs();
    const server = serverFailingFirst(1);
    const kill = vi.fn(async () => {});

    await expect(
      listenWithStalePidRecovery(server, {
        dataDir: 'data',
        fs,
        killProcess: kill,
        wait: async () => {},
        logger: quietLogger,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });

    expect(server.calls).toBe(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it('propagates the bind error when the recorded pid is not alive', async () => {
    const fs = new MemoryPidFs();
    writePidFile(fs, 'data', { pid: 2_147_483_000, nonce: 'n' });
    const server = serverFailingFirst(1);
    const kill = vi.fn(async () => {});

    await expect(
      listenWithStalePidRecovery(server, {
        dataDir: 'data',
        fs,
        killProcess: kill,
        wait: async () => {},
        logger: quietLogger,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });

    expect(kill).not.toHaveBeenCalled();
  });

  it('does not treat non-EADDRINUSE failures as stale-bind recoverable', async () => {
    const fs = new MemoryPidFs();
    writePidFile(fs, 'data', { pid: process.pid, nonce: 'n' });
    const server: FakeServer = {
      calls: 0,
      async listen(): Promise<void> {
        this.calls += 1;
        throw new Error('permission denied');
      },
    };
    const kill = vi.fn(async () => {});

    await expect(
      listenWithStalePidRecovery(server, {
        dataDir: 'data',
        fs,
        killProcess: kill,
        wait: async () => {},
        logger: quietLogger,
      }),
    ).rejects.toThrow('permission denied');
    expect(kill).not.toHaveBeenCalled();
  });

  it('rethrows when the retry still fails after killing the stale process', async () => {
    const fs = new MemoryPidFs();
    writePidFile(fs, 'data', { pid: process.pid, nonce: 'n' });
    const server = serverFailingFirst(2);
    const kill = vi.fn(async () => {});

    await expect(
      listenWithStalePidRecovery(server, {
        dataDir: 'data',
        fs,
        killProcess: kill,
        wait: async () => {},
        logger: quietLogger,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });

    expect(server.calls).toBe(2);
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
