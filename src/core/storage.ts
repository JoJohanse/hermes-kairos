/**
 * Tiny JSON-backed key/value store for kernel and plugin state.
 *
 * `JsonStore` is deliberately synchronous and dependency-free: persistence is a
 * best-effort edge concern, so I/O failures are logged and swallowed rather than
 * propagated into heartbeat loops. The backing filesystem is injectable so tests
 * can supply an in-memory stub.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal synchronous filesystem surface used by {@link JsonStore}. */
export interface JsonStoreFs {
  /** Whether `path` exists. */
  exists(path: string): boolean;
  /** Read a UTF-8 text file (may throw when missing/unreadable). */
  readFile(path: string): string;
  /** Write a UTF-8 text file (overwrites). */
  writeFile(path: string, data: string): void;
  /** Rename `from` onto `to`, replacing any existing file. */
  rename(from: string, to: string): void;
  /** Create a directory and any missing parents. */
  mkdir(path: string): void;
}

/** Default {@link JsonStoreFs} backed by `node:fs`. */
export const nodeJsonStoreFs: JsonStoreFs = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
  rename: (from, to) => renameSync(from, to),
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
};

/** Options for {@link JsonStore}. */
export interface JsonStoreOptions {
  /** Directory holding the JSON files. Created lazily on first write. */
  dataDir: string;
  /** Injectable filesystem. Defaults to the real `node:fs`. */
  fs?: JsonStoreFs;
  /** Injectable clock, exposed to callers that stamp snapshots. */
  now?: () => number;
}

/** Result of a successful {@link JsonStore.read}. */
export interface JsonStoreReadResult {
  data: unknown;
}

const JSON_SUFFIX = '.json';
const TMP_SUFFIX = '.json.tmp';

/**
 * A JSON file per name under `dataDir`.
 *
 * - {@link read} returns `undefined` for a missing, unreadable or corrupt file;
 *   corruption is logged via `console.warn`.
 * - {@link write} is atomic: it writes `<name>.json.tmp` then renames it over
 *   `<name>.json`, so a crash mid-write never leaves a half-written snapshot.
 */
export class JsonStore {
  readonly dataDir: string;
  readonly now: () => number;
  readonly #fs: JsonStoreFs;
  #dirReady = false;

  constructor(options: JsonStoreOptions) {
    this.dataDir = options.dataDir;
    this.#fs = options.fs ?? nodeJsonStoreFs;
    this.now = options.now ?? (() => Date.now());
  }

  /** Absolute-or-relative path backing `name`. */
  pathFor(name: string): string {
    return join(this.dataDir, `${name}${JSON_SUFFIX}`);
  }

  /** Read and parse `name`. Returns `undefined` when missing or unparseable. */
  read(name: string): JsonStoreReadResult | undefined {
    const path = this.pathFor(name);
    if (!this.#fs.exists(path)) return undefined;

    let text: string;
    try {
      text = this.#fs.readFile(path);
    } catch (error) {
      console.warn(`[storage] failed to read "${path}"; ignoring:`, error);
      return undefined;
    }

    try {
      return { data: JSON.parse(text) };
    } catch (error) {
      console.warn(`[storage] corrupt JSON in "${path}"; ignoring:`, error);
      return undefined;
    }
  }

  /** Atomically write `data` under `name`. Throws only if the filesystem fails. */
  write(name: string, data: unknown): void {
    const path = this.pathFor(name);
    const tmpPath = this.#tmpPathFor(name);
    const serialized = JSON.stringify(data);
    this.#ensureDir();
    this.#fs.writeFile(tmpPath, serialized);
    this.#fs.rename(tmpPath, path);
  }

  #tmpPathFor(name: string): string {
    return join(this.dataDir, `${name}${TMP_SUFFIX}`);
  }

  #ensureDir(): void {
    if (this.#dirReady) return;
    this.#fs.mkdir(this.dataDir);
    this.#dirReady = true;
  }
}
