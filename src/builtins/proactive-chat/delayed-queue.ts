/**
 * In-memory delayed queue for HOLD-band thoughts.
 *
 * Held candidates are re-scored on every heartbeat; they are promoted (and
 * removed) once their score reaches the send threshold, and dropped when they
 * expire or when a full queue must make room for a higher-scoring newcomer.
 */

import type { ThoughtCandidate } from './types.js';

/** Options for {@link DelayedQueue}. */
export interface DelayedQueueOptions {
  /** Maximum candidates held per session. Defaults to `10`. */
  maxSize?: number;
  /** Age after which a candidate is dropped. Defaults to `4` hours. */
  maxAgeHours?: number;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
}

/** Outcome of a re-score pass. */
export interface RescoreResult {
  /** Candidates whose score reached the threshold; removed from the queue. */
  promoted: ThoughtCandidate[];
  /** Candidates dropped because they aged out. */
  expired: ThoughtCandidate[];
  /** Candidates still below the threshold; retained. */
  queued: ThoughtCandidate[];
}

const HOUR_MS = 3_600_000;

/** Per-session queue of held {@link ThoughtCandidate}s. */
export class DelayedQueue {
  readonly #queues = new Map<string, ThoughtCandidate[]>();
  readonly #maxSize: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;

  constructor(options: DelayedQueueOptions = {}) {
    this.#maxSize = Math.max(1, options.maxSize ?? 10);
    this.#maxAgeMs = Math.max(0, (options.maxAgeHours ?? 4) * HOUR_MS);
    this.#now = options.now ?? (() => Date.now());
  }

  /** Number of candidates held for a session. */
  size(sessionId: string): number {
    return this.#queues.get(sessionId)?.length ?? 0;
  }

  /** Snapshot of the candidates held for a session. */
  entries(sessionId: string): readonly ThoughtCandidate[] {
    return this.#queues.get(sessionId) ?? [];
  }

  /** Session ids with at least one held candidate. */
  sessions(): string[] {
    return [...this.#queues.keys()];
  }

  /**
   * Attempt to hold a candidate.
   *
   * Expired candidates are pruned first. If the queue is still full, the
   * lowest-scoring entry is evicted only when the newcomer outscores it;
   * otherwise the newcomer is rejected.
   * @returns whether the candidate was accepted.
   */
  enqueue(candidate: ThoughtCandidate): boolean {
    const now = this.#now();
    const fresh = this.#freshEntries(candidate.sessionId, now);
    if (fresh.length >= this.#maxSize) {
      let lowestIndex = 0;
      for (let i = 1; i < fresh.length; i += 1) {
        const entry = fresh[i];
        const lowest = fresh[lowestIndex];
        if (entry && lowest && entry.score < lowest.score) lowestIndex = i;
      }
      const lowest = fresh[lowestIndex];
      if (lowest !== undefined && lowest.score >= candidate.score) {
        this.#store(candidate.sessionId, fresh);
        return false;
      }
      fresh.splice(lowestIndex, 1);
    }
    fresh.push(candidate);
    this.#store(candidate.sessionId, fresh);
    return true;
  }

  /**
   * Re-score every held candidate for a session.
   *
   * @param scoreOf Current score for a candidate.
   * @param sendThreshold Score at or above which a candidate is promoted.
   */
  rescore(
    sessionId: string,
    scoreOf: (candidate: ThoughtCandidate) => number,
    sendThreshold: number,
  ): RescoreResult {
    const now = this.#now();
    const held = this.#queues.get(sessionId) ?? [];
    const promoted: ThoughtCandidate[] = [];
    const expired: ThoughtCandidate[] = [];
    const queued: ThoughtCandidate[] = [];

    for (const candidate of held) {
      if (now - candidate.createdAt > this.#maxAgeMs) {
        expired.push(candidate);
        continue;
      }
      const score = scoreOf(candidate);
      const rescored: ThoughtCandidate = { ...candidate, score };
      if (score >= sendThreshold) promoted.push(rescored);
      else queued.push(rescored);
    }

    this.#store(sessionId, queued);
    return { promoted, expired, queued };
  }

  /** Drop all candidates for one session, or for every session when omitted. */
  clear(sessionId?: string): void {
    if (sessionId === undefined) this.#queues.clear();
    else this.#queues.delete(sessionId);
  }

  #freshEntries(sessionId: string, now: number): ThoughtCandidate[] {
    const held = this.#queues.get(sessionId) ?? [];
    return held.filter((candidate) => now - candidate.createdAt <= this.#maxAgeMs);
  }

  #store(sessionId: string, entries: ThoughtCandidate[]): void {
    if (entries.length === 0) this.#queues.delete(sessionId);
    else this.#queues.set(sessionId, entries);
  }
}
