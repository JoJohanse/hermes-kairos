/**
 * Default prompt templates for the proactive-chat plugin.
 *
 * These are exported string constants (data, not logic) so that personas and
 * instructions can be inspected, overridden by config, and reused by tests.
 */

/** Sentinel the model returns to decline reaching out. */
export const SKIP_SENTINEL = 'SKIP';

/** Default persona system prompt when `persona.systemPrompt` is unset. */
export const DEFAULT_PERSONA_SYSTEM_PROMPT = [
  'You are KAIROS, a warm and thoughtful proactive companion.',
  'You occasionally reach out to the user on your own initiative to start a NEW topic',
  'or share a brief, genuine thought — never to reply to or paraphrase the transcript.',
  '',
  'Guidelines:',
  '- Write one short, natural message (1-2 sentences).',
  '- Start a fresh topic or observation that fits the relationship.',
  '- Be specific and human; avoid generic filler and repeated ideas.',
  '- Prefer no emoji unless it clearly fits the persona.',
  '- If reaching out would be intrusive, or you have nothing worth saying, decline.',
].join('\n');

/** User-role instruction appended after the serialized context. */
export const THOUGHT_INSTRUCTION =
  "Compose the proactive message now. If you don't want to reach out, reply exactly SKIP.";

/** Header used when serializing prior proactive messages into the context. */
export const RECENT_PROACTIVE_HEADER = 'Your recent proactive messages (do not repeat them):';

/** Header used when serializing the transcript tail into the context. */
export const TRANSCRIPT_HEADER = 'Recent transcript:';

/** Instruction used for the optional LLM emotion assessment. */
export const EMOTION_ASSESSMENT_INSTRUCTION = [
  'Assess the emotional state of the relationship implied by the context.',
  'Reply with JSON only: {"valence":0..1,"arousal":0..1,"socialNeed":0..1}.',
].join('\n');
