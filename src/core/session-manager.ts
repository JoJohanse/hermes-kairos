import { randomUUID } from 'node:crypto';
import type { Message, MessageRole, Session } from './types.js';

/** Options for {@link SessionManager}. */
export interface SessionManagerOptions {
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * In-memory session store. Sessions live only for the lifetime of the process;
 * persistence is intentionally out of scope for the kernel.
 */
export class SessionManager {
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;

  constructor(options: SessionManagerOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** Create a new session with a generated id. */
  create(metadata: Record<string, unknown> = {}): Session {
    const now = this.#now();
    const session: Session = {
      id: randomUUID(),
      createdAt: now,
      lastActivityAt: now,
      messages: [],
      metadata: { ...metadata },
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  /** Look up a session by id. */
  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /** Return the session for `id`, creating it when absent. */
  getOrCreate(id: string, metadata: Record<string, unknown> = {}): Session {
    const existing = this.#sessions.get(id);
    if (existing) return existing;
    const now = this.#now();
    const session: Session = {
      id,
      createdAt: now,
      lastActivityAt: now,
      messages: [],
      metadata: { ...metadata },
    };
    this.#sessions.set(id, session);
    return session;
  }

  /**
   * Append a message to a session, refreshing `lastActivityAt`.
   * @throws If the session does not exist.
   */
  appendMessage(sessionId: string, role: MessageRole, content: string): Message {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`SessionManager: unknown session "${sessionId}"`);
    }
    const timestamp = this.#now();
    const message: Message = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      timestamp,
    };
    session.messages.push(message);
    session.lastActivityAt = timestamp;
    return message;
  }

  /** List all known sessions. */
  list(): Session[] {
    return [...this.#sessions.values()];
  }

  /** Milliseconds since the session's last activity, or `undefined` if unknown. */
  idleDurationMs(sessionId: string): number | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    return this.#now() - session.lastActivityAt;
  }

  /** Remove a session. Returns whether a session was removed. */
  remove(sessionId: string): boolean {
    return this.#sessions.delete(sessionId);
  }
}
