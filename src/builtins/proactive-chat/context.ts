/**
 * Context-bundle builder for the thought engine.
 *
 * Reads a session from the {@link SessionManager} and packages the transcript
 * tail, prior proactive messages, the emotion state and a time-of-day label.
 * No external memory service is used in v1.
 */

import type { SessionManager } from '../../core/session-manager.js';
import type { Message } from '../../core/types.js';
import type { EmotionState } from './types.js';

/** Everything the thought engine serializes into the LLM prompt. */
export interface ContextBundle {
  sessionId: string;
  /** Last `historyTailMessages` messages, oldest first. */
  tailMessages: Message[];
  /** Ids of {@link tailMessages}, used as provenance/stimuli. */
  stimuli: string[];
  /** Most recent agent (proactive) messages, for de-duplication. */
  recentProactive: Message[];
  emotion: EmotionState;
  /** Human-readable time-of-day label. */
  timeOfDay: string;
}

/** Options for {@link buildContextBundle}. */
export interface ContextBundleOptions {
  /** Number of transcript messages to include. Defaults to `20`. */
  historyTailMessages?: number;
  /** Number of recent proactive messages to include. Defaults to `3`. */
  recentProactiveLimit?: number;
}

/** Default number of transcript messages fed to the model. */
export const DEFAULT_HISTORY_TAIL_MESSAGES = 20;
/** Default number of prior proactive messages fed to the model. */
export const DEFAULT_RECENT_PROACTIVE_LIMIT = 3;

/** Coarse local time-of-day label derived from `nowMs`. */
export function timeOfDayLabel(nowMs: number): string {
  const hour = new Date(nowMs).getHours();
  if (hour < 5) return 'late night';
  if (hour < 9) return 'early morning';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

/**
 * Build a {@link ContextBundle} for a session.
 * @returns `undefined` when the session is unknown.
 */
export function buildContextBundle(
  sessions: SessionManager,
  sessionId: string,
  emotion: EmotionState,
  now: number,
  options: ContextBundleOptions = {},
): ContextBundle | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  const tailLimit = options.historyTailMessages ?? DEFAULT_HISTORY_TAIL_MESSAGES;
  const proactiveLimit = options.recentProactiveLimit ?? DEFAULT_RECENT_PROACTIVE_LIMIT;

  // In v1 the only producer of `agent` messages is this plugin's `ctx.send`.
  const recentProactive = session.messages.filter((message) => message.role === 'agent');
  const tailMessages = session.messages.slice(-Math.max(0, tailLimit));

  return {
    sessionId,
    tailMessages,
    stimuli: tailMessages.map((message) => message.id),
    recentProactive: recentProactive.slice(-Math.max(0, proactiveLimit)),
    emotion,
    timeOfDay: timeOfDayLabel(now),
  };
}
