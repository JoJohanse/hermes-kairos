import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonStore, type JsonStoreFs } from './storage.js';

/** Minimal in-memory filesystem for exercising JsonStore without touching disk. */
class MemoryFs implements JsonStoreFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  exists(path: string): boolean {
    return this.files.has(path);
  }

  readFile(path: string): string {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return data;
  }

  writeFile(path: string, data: string): void {
    this.files.set(path, data);
  }

  rename(from: string, to: string): void {
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.files.set(to, data);
  }

  mkdir(path: string): void {
    this.dirs.add(path);
  }
}

const tempDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-storage-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('JsonStore', () => {
  it('returns undefined when the file is missing', () => {
    const store = new JsonStore({ dataDir: 'unused', fs: new MemoryFs() });
    expect(store.read('missing')).toBeUndefined();
  });

  it('round-trips data through a real directory', () => {
    const dir = tempDataDir();
    const store = new JsonStore({ dataDir: dir });

    store.write('state', { hello: 'world', count: 3 });

    expect(existsSync(join(dir, 'state.json'))).toBe(true);
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
    expect(store.read('state')).toEqual({ data: { hello: 'world', count: 3 } });
  });

  it('writes atomically via a temporary file then a rename', () => {
    const fs = new MemoryFs();
    const store = new JsonStore({ dataDir: 'data', fs });
    store.write('state', { value: 1 });

    expect(fs.files.has(join('data', 'state.json.tmp'))).toBe(false);
    expect(fs.files.get(join('data', 'state.json'))).toBe('{"value":1}');
    expect(fs.dirs.has('data')).toBe(true);
  });

  it('logs and returns undefined for corrupt JSON', () => {
    const fs = new MemoryFs();
    const store = new JsonStore({ dataDir: 'data', fs });
    fs.files.set(join('data', 'state.json'), '{ not json');

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(store.read('state')).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('corrupt JSON');
    } finally {
      spy.mockRestore();
    }
  });

  it('logs and returns undefined when reading throws', () => {
    const store = new JsonStore({
      dataDir: 'data',
      fs: {
        exists: () => true,
        readFile: () => {
          throw new Error('permission denied');
        },
        writeFile: () => {},
        rename: () => {},
        mkdir: () => {},
      },
    });

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(store.read('state')).toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('failed to read');
    } finally {
      spy.mockRestore();
    }
  });

  it('overwrites an existing file and only ensures the directory once', () => {
    const fs = new MemoryFs();
    let mkdirCalls = 0;
    const counting: JsonStoreFs = {
      exists: (path) => fs.exists(path),
      readFile: (path) => fs.readFile(path),
      writeFile: (path, data) => fs.writeFile(path, data),
      rename: (from, to) => fs.rename(from, to),
      mkdir: (path) => {
        mkdirCalls += 1;
        fs.mkdir(path);
      },
    };
    const store = new JsonStore({ dataDir: 'data', fs: counting });

    store.write('a', 1);
    store.write('b', 2);

    expect(mkdirCalls).toBe(1);
    expect(store.read('a')).toEqual({ data: 1 });
    expect(store.read('b')).toEqual({ data: 2 });
  });
});
