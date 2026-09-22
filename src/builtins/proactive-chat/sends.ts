/**
 * Per-session log of proactive send timestamps.
 *
 * The send window (one day) has exactly one owner: this module. Every read
 * prunes in place, so the guardrail hour/day counts, snapshot persistence and
 * the plugin's observability hook all observe the same invariant instead of
 * re-filtering the raw map at each call site. Timestamps arrive as parameters —
 * the clock stays at the edges.
 */

import { ONE_DAY_MS } from './decision.js';

/** In-memory send log backing the guardrail caps and the snapshot. */
export class SendLog {
  readonly #entries = new Map<string, number[]>();

  /**
   * Timestamps for a session within the window, pruned in place. The returned
   * array is live: {@link record} pushes into the array this method returns.
   */
  recent(sessionId: string, now: number): number[] {
    const existing = this.#entries.get(sessionId) ?? [];
    const recent = existing.filter((at) => now - at < ONE_DAY_MS);
    if (recent.length === 0) this.#entries.delete(sessionId);
    else this.#entries.set(sessionId, recent);
    return recent;
  }

  /** Record one send at `atMs`, pruning first. */
  record(sessionId: string, atMs: number): void {
    const recent = this.recent(sessionId, atMs);
    recent.push(atMs);
    this.#entries.set(sessionId, recent);
  }

  /** Restore persisted stamps, dropping non-finite and out-of-window ones. */
  restore(sessionId: string, stamps: readonly unknown[], now: number): void {
    const valid = stamps.filter(
      (at): at is number => typeof at === 'number' && Number.isFinite(at) && now - at < ONE_DAY_MS,
    );
    if (valid.length > 0) this.#entries.set(sessionId, valid);
  }

  /** Ids of sessions with entries (possibly stale — pruning happens on read). */
  sessionIds(): string[] {
    return [...this.#entries.keys()];
  }

  /** Forget everything. */
  clear(): void {
    this.#entries.clear();
  }
}
