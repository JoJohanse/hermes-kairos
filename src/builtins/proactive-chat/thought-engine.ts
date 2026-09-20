/**
 * LLM-backed thought generation.
 *
 * The model only produces (or vetoes) content; whether to *ask* is decided by
 * the deterministic gate in `decision.ts`. A response of `SKIP`
 * (case-insensitive) or an empty response vetoes the outreach.
 */

import type { CompletionRequest, LLMProvider } from '../../llm/types.js';
import type { ContextBundle } from './context.js';
import { RECENT_PROACTIVE_HEADER, SKIP_SENTINEL, THOUGHT_INSTRUCTION, TRANSCRIPT_HEADER } from './prompts.js';
import type { DecisionBreakdown, ProactivePersonaConfig, ThoughtCandidate } from './types.js';

/** Reasons a generated thought was vetoed or could not be produced. */
export type ThoughtVetoReason = 'skip_sentinel' | 'empty_response' | 'llm_error';

/** Inputs to {@link generateThought}. */
export interface ThoughtEngineInput {
  sessionId: string;
  bundle: ContextBundle;
  score: number;
  breakdown: DecisionBreakdown;
  persona: ProactivePersonaConfig;
  now: number;
}

/** Outcome of {@link generateThought}. */
export type ThoughtEngineResult =
  | { kind: 'thought'; candidate: ThoughtCandidate; request: CompletionRequest }
  | { kind: 'skipped'; reason: ThoughtVetoReason; detail?: string; request: CompletionRequest };

/** Serialize a context bundle into a stable, human-readable block. */
export function serializeContext(bundle: ContextBundle): string {
  const lines: string[] = [];
  lines.push(`Local time of day: ${bundle.timeOfDay}.`);
  lines.push(
    `Emotion — valence ${bundle.emotion.valence.toFixed(2)}, ` +
      `arousal ${bundle.emotion.arousal.toFixed(2)}, ` +
      `social need ${bundle.emotion.socialNeed.toFixed(2)}.`,
  );

  if (bundle.recentProactive.length > 0) {
    lines.push('', RECENT_PROACTIVE_HEADER);
    for (const message of bundle.recentProactive) {
      lines.push(`- ${message.content}`);
    }
  }

  lines.push('', TRANSCRIPT_HEADER);
  if (bundle.tailMessages.length === 0) {
    lines.push('(no prior messages)');
  } else {
    for (const message of bundle.tailMessages) {
      lines.push(`${message.role}: ${message.content}`);
    }
  }
  return lines.join('\n');
}

/** Build the completion request used for thought generation. */
export function buildThoughtRequest(input: ThoughtEngineInput): CompletionRequest {
  const system = [input.persona.systemPrompt, '', serializeContext(input.bundle)].join('\n');
  return {
    system,
    messages: [{ role: 'user', content: THOUGHT_INSTRUCTION }],
    temperature: 0.8,
  };
}

/**
 * Ask the LLM for a proactive message.
 *
 * @returns a `thought` candidate, or a `skipped` veto with a reason.
 */
export async function generateThought(
  llm: LLMProvider,
  input: ThoughtEngineInput,
): Promise<ThoughtEngineResult> {
  const request = buildThoughtRequest(input);

  let content: string;
  try {
    const result = await llm.complete(request);
    content = result.content;
  } catch (error) {
    return {
      kind: 'skipped',
      reason: 'llm_error',
      detail: error instanceof Error ? error.message : String(error),
      request,
    };
  }

  const trimmed = content.trim();
  if (trimmed === '') return { kind: 'skipped', reason: 'empty_response', request };
  if (trimmed.toUpperCase() === SKIP_SENTINEL) {
    return { kind: 'skipped', reason: 'skip_sentinel', request };
  }

  return {
    kind: 'thought',
    request,
    candidate: {
      sessionId: input.sessionId,
      content: trimmed,
      score: input.score,
      breakdown: input.breakdown,
      stimuli: [...input.bundle.stimuli],
      createdAt: input.now,
    },
  };
}
