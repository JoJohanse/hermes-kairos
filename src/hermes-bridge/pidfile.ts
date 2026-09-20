/**
 * Sidecar pidfile + stale-bind recovery.
 *
 * On boot the bridge writes `<dataDir>/sidecar.pid` containing `{ pid, nonce }`.
 * If a later boot finds the port busy (`EADDRINUSE`), it reads that pidfile and,
 * when the recorded process is still alive, kills the process tree, waits 1s and
 * retries the bind once. Everything here is injectable (filesystem, kill, wait)
 * so the recovery path is testable without touching real processes.
 *
 * The pidfile is written only *after* a successful bind, so the recovery read
 * can never observe this process's own pid.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Canonical `<dataDir>/sidecar.pid` contents. */
export interface SidecarPidFile {
  pid: number;
  nonce: string;
}

/** Minimal synchronous filesystem surface used by the pidfile helpers. */
export interface PidFileFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  remove(path: string): void;
  mkdir(path: string): void;
}

/** Default {@link PidFileFs} backed by `node:fs`. */
export const nodePidFileFs: PidFileFs = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
  remove: (path) => rmSync(path, { force: true }),
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
};

/** Path of the pidfile for a given data directory. */
export function pidFilePath(dataDir: string): string {
  return join(dataDir, 'sidecar.pid');
}

/** Write `{ pid, nonce }` to the pidfile (creating `dataDir` if needed). */
export function writePidFile(fs: PidFileFs, dataDir: string, contents: SidecarPidFile): void {
  fs.mkdir(dataDir);
  fs.writeFile(pidFilePath(dataDir), JSON.stringify(contents));
}

/** Best-effort removal of the pidfile (swallows filesystem errors). */
export function removePidFile(fs: PidFileFs, dataDir: string): void {
  try {
    fs.remove(pidFilePath(dataDir));
  } catch {
    // best effort: a missing/locked pidfile must never break shutdown
  }
}

/**
 * Parse a pidfile body. Canonical form is JSON `{"pid":..,"nonce":".."}`; a bare
 * `<pid>` or `<pid> <nonce>` is tolerated so an older/other-language writer still
 * enables recovery.
 */
export function parsePidFile(raw: string): SidecarPidFile | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const pid = record['pid'];
    const nonce = record['nonce'];
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      return { pid, nonce: typeof nonce === 'string' ? nonce : '' };
    }
    return undefined;
  }
  const [pidText, nonce = ''] = text.split(/\s+/, 2);
  const pid = Number(pidText);
  return Number.isInteger(pid) && pid > 0 ? { pid, nonce } : undefined;
}

/** Read and parse the pidfile; `undefined` when missing, unreadable or malformed. */
export function readPidFile(fs: PidFileFs, dataDir: string): SidecarPidFile | undefined {
  const path = pidFilePath(dataDir);
  let raw: string;
  try {
    if (!fs.exists(path)) return undefined;
    raw = fs.readFile(path);
  } catch {
    return undefined;
  }
  return parsePidFile(raw);
}

/**
 * Whether `pid` is alive. `EPERM` means the process exists but is not signalable
 * by us, so it still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Injectable process-tree killer. */
export type KillProcess = (pid: number) => Promise<void>;

/**
 * Kill a process tree: `taskkill /PID <pid> /T /F` on Windows, `SIGKILL`
 * elsewhere. Never throws — a process that is already gone is fine.
 */
export function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    });
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  return Promise.resolve();
}

/** Minimal trigger surface the recovery path needs from a bridge server. */
export interface BindableServer {
  listen(): Promise<void>;
}

/** Options for {@link listenWithStalePidRecovery}. */
export interface BindRecoveryOptions {
  dataDir: string;
  /** Injectable pidfile filesystem (defaults to the real `node:fs`). */
  fs?: PidFileFs;
  /** Injectable kill (defaults to {@link killProcessTree}). */
  killProcess?: KillProcess;
  /** Injectable wait (defaults to a 1s `setTimeout`). */
  wait?: (ms: number) => Promise<void>;
  /** How long to wait after killing the stale tree. Defaults to 1000ms. */
  waitMs?: number;
  /** Diagnostics sink (defaults to `console.warn`/`console.error`). */
  logger?: { warn(message: string, ...args: unknown[]): void; error(message: string, ...args: unknown[]): void };
}

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

/**
 * Bind `server`, recovering once from `EADDRINUSE` when a live stale sidecar is
 * recorded in the pidfile. Any other failure (or a dead/absent recorded pid, or a
 * still-busy port after the retry) propagates to the caller.
 */
export async function listenWithStalePidRecovery(
  server: BindableServer,
  options: BindRecoveryOptions,
): Promise<void> {
  try {
    await server.listen();
    return;
  } catch (error) {
    if (!isAddrInUse(error)) throw error;
    const fs = options.fs ?? nodePidFileFs;
    const logger = options.logger ?? console;
    const stale = readPidFile(fs, options.dataDir);
    if (!stale || !isProcessAlive(stale.pid)) throw error;

    logger.warn(
      `[hermes-bridge] port busy (EADDRINUSE); killing stale sidecar pid ${stale.pid} and retrying once`,
    );
    const kill = options.killProcess ?? killProcessTree;
    await kill(stale.pid);
    const wait =
      options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await wait(options.waitMs ?? 1000);
    await server.listen();
  }
}
