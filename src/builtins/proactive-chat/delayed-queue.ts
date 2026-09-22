/**
 * In-memory delayed queue for HOLD-band stubs.
 *
 * HOLD-band work is queued as a lightweight {@link HeldStub} (no LLM content).
 * Stubs are re-scored on every heartbeat; once a fresh score reaches the send
 * threshold the stub is promoted and the plugin generates content. Stubs are
 * dropped when they expire or when a full queue must make room for a
 * higher-scoring newcomer.
 */

import type { HeldStub } from './types.js';

/** Options for {@link DelayedQueue}. */
export interface DelayedQueueOptions {
  /** Maximum stubs held per session. Defaults to `10`. */
  maxSize?: number;
  /** Age after which a stub is dropped. Defaults to `4` hours. */
  maxAgeHours?: number;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
}

/** Outcome of a re-score pass. */
export interface RescoreResult {
  /** Stubs whose score reached the threshold; removed from the queue. */
  promoted: HeldStub[];
  /** Stubs dropped because they aged out. */
  expired: HeldStub[];
  /** Stubs still below the threshold; retained. */
  queued: HeldStub[];
}

const HOUR_MS = 3_600_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Whether a value is a well-formed {@link HeldStub} (e.g. restored from a snapshot). */
export function isHeldStub(value: unknown): value is HeldStub {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['sessionId'] === 'string' &&
    isFiniteNumber(record['enqueuedAt']) &&
    isFiniteNumber(record['scoreAtEnqueue']) &&
    typeof record['breakdown'] === 'object' &&
    record['breakdown'] !== null
  );
}

/** Per-session queue of held {@link HeldStub}s. */
export class DelayedQueue {
  readonly #queues = new Map<string, HeldStub[]>();
  readonly #maxSize: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;

  constructor(options: DelayedQueueOptions = {}) {
    this.#maxSize = Math.max(1, options.maxSize ?? 10);
    this.#maxAgeMs = Math.max(0, (options.maxAgeHours ?? 4) * HOUR_MS);
    this.#now = options.now ?? (() => Date.now());
  }

  /** Number of stubs held for a session. */
  size(sessionId: string): number {
    return this.#queues.get(sessionId)?.length ?? 0;
  }

  /** Snapshot of the stubs held for a session. */
  entries(sessionId: string): readonly HeldStub[] {
    return this.#queues.get(sessionId) ?? [];
  }

  /** Session ids with at least one held stub. */
  sessions(): string[] {
    return [...this.#queues.keys()];
  }

  /**
   * Attempt to hold a stub.
   *
   * Expired stubs are pruned first. If the queue is still full, the
   * lowest-scoring entry is evicted only when the newcomer outscores it;
   * otherwise the newcomer is rejected.
   * @returns whether the stub was accepted.
   */
  enqueue(stub: HeldStub): boolean {
    const now = this.#now();
    const fresh = this.#freshEntries(stub.sessionId, now);
    if (fresh.length >= this.#maxSize) {
      let lowestIndex = 0;
      for (let i = 1; i < fresh.length; i += 1) {
        const entry = fresh[i];
        const lowest = fresh[lowestIndex];
        if (entry && lowest && entry.scoreAtEnqueue < lowest.scoreAtEnqueue) lowestIndex = i;
      }
      const lowest = fresh[lowestIndex];
      if (lowest !== undefined && lowest.scoreAtEnqueue >= stub.scoreAtEnqueue) {
        this.#store(stub.sessionId, fresh);
        return false;
      }
      fresh.splice(lowestIndex, 1);
    }
    fresh.push(stub);
    this.#store(stub.sessionId, fresh);
    return true;
  }

  /**
   * Replace a session's queue with restored stubs, pruned to current rules:
   * malformed stubs are dropped, stubs older than `maxAgeHours` are dropped,
   * and the queue is capped at `maxSize`, keeping the highest-scoring stubs
   * (matching eviction order).
   */
  restore(sessionId: string, stubs: readonly unknown[]): void {
    const now = this.#now();
    const fresh = stubs
      .filter(isHeldStub)
      .filter((stub) => now - stub.enqueuedAt <= this.#maxAgeMs);
    const trimmed = [...fresh]
      .sort((a, b) => b.scoreAtEnqueue - a.scoreAtEnqueue)
      .slice(0, this.#maxSize);
    this.#store(sessionId, trimmed);
  }

  /**
   * Re-score every held stub for a session against the session's one current
   * decision score — a stub belongs to a session, so a tick scores them all
   * alike.
   *
   * @param score The session's current decision score.
   * @param sendThreshold Score at or above which a stub is promoted.
   */
  rescore(sessionId: string, score: number, sendThreshold: number): RescoreResult {
    const now = this.#now();
    const held = this.#queues.get(sessionId) ?? [];
    const promoted: HeldStub[] = [];
    const expired: HeldStub[] = [];
    const queued: HeldStub[] = [];

    for (const stub of held) {
      if (now - stub.enqueuedAt > this.#maxAgeMs) {
        expired.push(stub);
        continue;
      }
      const rescored: HeldStub = { ...stub, scoreAtEnqueue: score };
      if (score >= sendThreshold) promoted.push(rescored);
      else queued.push(rescored);
    }

    this.#store(sessionId, queued);
    return { promoted, expired, queued };
  }

  /** Drop all stubs for one session, or for every session when omitted. */
  clear(sessionId?: string): void {
    if (sessionId === undefined) this.#queues.clear();
    else this.#queues.delete(sessionId);
  }

  #freshEntries(sessionId: string, now: number): HeldStub[] {
    const held = this.#queues.get(sessionId) ?? [];
    return held.filter((stub) => now - stub.enqueuedAt <= this.#maxAgeMs);
  }

  #store(sessionId: string, entries: HeldStub[]): void {
    if (entries.length === 0) this.#queues.delete(sessionId);
    else this.#queues.set(sessionId, entries);
  }
}
