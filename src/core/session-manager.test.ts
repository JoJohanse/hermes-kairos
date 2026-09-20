import { describe, expect, it } from 'vitest';
import { SessionManager } from './session-manager.js';

describe('SessionManager', () => {
  it('creates sessions with generated ids and empty history', () => {
    const manager = new SessionManager();
    const session = manager.create({ topic: 'demo' });

    expect(session.id).toBeTruthy();
    expect(session.messages).toEqual([]);
    expect(session.metadata).toEqual({ topic: 'demo' });
    expect(manager.get(session.id)).toBe(session);
  });

  it('getOrCreate returns the same session for a repeated id', () => {
    const manager = new SessionManager();
    const first = manager.getOrCreate('session-1');
    const second = manager.getOrCreate('session-1');

    expect(second).toBe(first);
    expect(manager.list()).toHaveLength(1);
  });

  it('appendMessage updates lastActivityAt and idleDurationMs grows', () => {
    let now = 1_000;
    const manager = new SessionManager({ now: () => now });
    const session = manager.create();

    expect(manager.idleDurationMs(session.id)).toBe(0);

    now = 2_500;
    const message = manager.appendMessage(session.id, 'user', 'hello');

    expect(message.role).toBe('user');
    expect(message.content).toBe('hello');
    expect(message.sessionId).toBe(session.id);
    expect(session.lastActivityAt).toBe(2_500);
    expect(manager.idleDurationMs(session.id)).toBe(0);

    now = 7_500;
    expect(manager.idleDurationMs(session.id)).toBe(5_000);
  });

  it('appendMessage throws for an unknown session', () => {
    const manager = new SessionManager();
    expect(() => manager.appendMessage('missing', 'user', 'hi')).toThrow(/unknown session/);
  });

  it('returns undefined idle duration for an unknown session', () => {
    const manager = new SessionManager();
    expect(manager.idleDurationMs('missing')).toBeUndefined();
  });
});
