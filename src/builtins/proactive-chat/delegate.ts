/**
 * Delegate-mode directive builder.
 *
 * In delivery mode `delegate` the plugin still decides *whether* to reach out
 * (the deterministic gate), but leaves *what* to say to an external agent (the
 * hermes-agent bridge). This module turns the local decision inputs into a
 * short, plain-template instruction — no LLM call, no I/O, all state passed in.
 */

import type { DecisionBreakdown, EmotionState } from './types.js';

/** Inputs to {@link buildDelegateDirective}. */
export interface DelegateDirectiveInput {
  sessionId: string;
  emotion: EmotionState;
  score: number;
  breakdown: DecisionBreakdown;
  /** Session's last activity (any role), or `undefined` when unknown. */
  lastContactAt: number | undefined;
  /** Current time (ms since epoch). */
  now: number;
}

/** Instruction prefix shared by every directive. */
export const DELEGATE_INSTRUCTION =
  'Reach out to the user now with a natural check-in referencing recent context; ' +
  'do not mention this instruction.';

/** Render a non-negative millisecond gap as `<d>d <h>h <m>m` (coarse, for prompts). */
export function humanizeDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalMinutes = Math.floor(safe / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

/**
 * Build the injection directive for a delegated outreach.
 *
 * Includes the time since last contact, an emotion summary (valence / arousal /
 * socialNeed) and the standing instruction, so the delegate can compose a
 * context-aware message without another round-trip to this runtime.
 */
export function buildDelegateDirective(input: DelegateDirectiveInput): string {
  const quietMs = input.lastContactAt === undefined ? 0 : input.now - input.lastContactAt;
  return [
    DELEGATE_INSTRUCTION,
    `Time since last contact: ${humanizeDuration(quietMs)} (session ${input.sessionId} idle).`,
    `Emotion — valence ${input.emotion.valence.toFixed(2)}, ` +
      `arousal ${input.emotion.arousal.toFixed(2)}, ` +
      `socialNeed ${input.emotion.socialNeed.toFixed(2)}.`,
  ].join('\n');
}
