import { describe, expect, it } from 'vitest';
import { MockProvider } from '../../llm/mock.js';
import type { LLMProvider } from '../../llm/types.js';
import type { ContextBundle } from './context.js';
import { SKIP_SENTINEL, THOUGHT_INSTRUCTION } from './prompts.js';
import { buildThoughtRequest, generateThought, serializeContext } from './thought-engine.js';
import type { ThoughtEngineInput } from './thought-engine.js';
import type { DecisionBreakdown } from './types.js';

const BREAKDOWN: DecisionBreakdown = {
  valence: 0.7,
  arousal: 0.8,
  socialNeed: 0.5,
  intensity: 0.67,
  timeFitness: 1,
  silenceFactor: 0.9,
  frequencyLimit: 1,
  silenceMinutes: 420,
  sentThisHour: 0,
  sentToday: 0,
  score: 0.7,
};

function makeBundle(stimuli: string[] = ['m1', 'm2']): ContextBundle {
  return {
    sessionId: 's1',
    tailMessages: stimuli.map((id, index) => ({
      id,
      sessionId: 's1',
      role: index === 0 ? 'user' : 'agent',
      content: `message-${id}`,
      timestamp: index,
    })),
    stimuli,
    recentProactive: [],
    emotion: { valence: 0.7, arousal: 0.8, socialNeed: 0.5 },
    timeOfDay: 'morning',
  };
}

function makeInput(overrides: Partial<ThoughtEngineInput> = {}): ThoughtEngineInput {
  return {
    sessionId: 's1',
    bundle: makeBundle(),
    score: 0.7,
    breakdown: BREAKDOWN,
    persona: { systemPrompt: 'You are a test persona.' },
    now: 12_345,
    ...overrides,
  };
}

describe('generateThought', () => {
  it('vetoes an exact SKIP response (case-insensitive)', async () => {
    const llm = new MockProvider({ response: 'SKIP' });
    const result = await generateThought(llm, makeInput());

    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toBe('skip_sentinel');
  });

  it('vetoes a lowercase/padded skip response', async () => {
    const llm = new MockProvider({ response: '  skip \n' });
    const result = await generateThought(llm, makeInput());
    expect(result.kind === 'skipped' && result.reason === 'skip_sentinel').toBe(true);
  });

  it('vetoes empty and whitespace-only responses', async () => {
    const empty = await generateThought(new MockProvider({ response: '' }), makeInput());
    const blank = await generateThought(new MockProvider({ response: '   ' }), makeInput());
    expect(empty.kind === 'skipped' && empty.reason === 'empty_response').toBe(true);
    expect(blank.kind === 'skipped' && blank.reason === 'empty_response').toBe(true);
  });

  it('returns a thought candidate carrying provenance and timing', async () => {
    const llm = new MockProvider({ response: '  Hey, how did the launch go?  ' });
    const input = makeInput();
    const result = await generateThought(llm, input);

    expect(result.kind).toBe('thought');
    if (result.kind !== 'thought') return;
    expect(result.candidate.content).toBe('Hey, how did the launch go?');
    expect(result.candidate.sessionId).toBe('s1');
    expect(result.candidate.score).toBeCloseTo(0.7);
    expect(result.candidate.breakdown).toEqual(BREAKDOWN);
    expect(result.candidate.stimuli).toEqual(['m1', 'm2']);
    expect(result.candidate.createdAt).toBe(12_345);
  });

  it('sends the persona and transcript in the system prompt, plus the instruction', async () => {
    const llm = new MockProvider({ response: 'Hello.' });
    const input = makeInput();
    await generateThought(llm, input);

    const request = llm.requests[0];
    expect(request?.system).toContain('You are a test persona.');
    expect(request?.system).toContain('user: message-m1');
    expect(request?.system).toContain('agent: message-m2');
    expect(request?.messages).toEqual([{ role: 'user', content: THOUGHT_INSTRUCTION }]);
  });

  it('reports an llm_error rather than throwing', async () => {
    const failing: LLMProvider = {
      complete: async () => {
        throw new Error('boom');
      },
    };
    const result = await generateThought(failing, makeInput());
    expect(result.kind === 'skipped' && result.reason === 'llm_error').toBe(true);
  });
});

describe('serializeContext / buildThoughtRequest', () => {
  it('includes the time of day and emotional summary', () => {
    const serialized = serializeContext(makeBundle());
    expect(serialized).toContain('morning');
    expect(serialized).toContain('valence 0.70');
  });

  it('notes an empty transcript explicitly', () => {
    const request = buildThoughtRequest(makeInput({ bundle: makeBundle([]) }));
    expect(request.system).toContain('(no prior messages)');
  });

  it('exposes the skip sentinel as an exported constant', () => {
    expect(SKIP_SENTINEL).toBe('SKIP');
  });
});
