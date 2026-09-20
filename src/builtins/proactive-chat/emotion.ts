/**
 * Time-driven emotion model for the proactive-chat plugin.
 *
 * All core maths are pure functions over {@link EmotionState}; the
 * {@link EmotionStore} only adds an in-memory `sessionId -> state` map plus an
 * injectable clock. No runtime singletons are imported here.
 */

import type { EmotionState } from './types.js';

/** Emotion dynamics knobs (a subset of the resolved plugin config). */
export interface EmotionDynamicsConfig {
  decayRatePerHour: number;
  socialNeedGrowthPerHour: number;
  /** Floor `arousal` decays toward; never reaches zero. */
  arousalFloor: number;
}

/** Default dynamics matching `ProactiveChatConfig.emotion`. */
export const DEFAULT_EMOTION_DYNAMICS: EmotionDynamicsConfig = {
  decayRatePerHour: 0.1,
  socialNeedGrowthPerHour: 0.2,
  arousalFloor: 0.2,
};

/**
 * Starting state for a freshly observed session.
 *
 * Chosen so that a long-silent session can plausibly cross the default send
 * threshold in the evening, while short silences stay in the HOLD band.
 */
export const DEFAULT_EMOTION_STATE: EmotionState = {
  valence: 0.7,
  arousal: 0.8,
  socialNeed: 0.5,
};

/** Weights applied when merging an LLM assessment into the evolved state. */
export const EMOTION_EVOLVED_WEIGHT = 0.4;
/** Weight of the LLM assessment; complements {@link EMOTION_EVOLVED_WEIGHT}. */
export const EMOTION_ASSESSMENT_WEIGHT = 0.6;

/** Clamp a value to the closed unit interval. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Advance an emotion state by `elapsedMs` of pure wall-clock time.
 *
 * - `socialNeed` grows linearly and saturates at `1`.
 * - `arousal` decays exponentially toward `arousalFloor` (never to zero).
 * - `valence` regresses exponentially toward the `0.5` baseline.
 */
export function evolveEmotion(
  state: EmotionState,
  elapsedMs: number,
  config: EmotionDynamicsConfig = DEFAULT_EMOTION_DYNAMICS,
): EmotionState {
  const hours = Math.max(0, elapsedMs) / 3_600_000;
  if (hours === 0) {
    return { valence: state.valence, arousal: state.arousal, socialNeed: state.socialNeed };
  }
  const decay = Math.exp(-config.decayRatePerHour * hours);
  const floor = clamp01(config.arousalFloor);
  return {
    valence: clamp01(0.5 + (state.valence - 0.5) * decay),
    arousal: clamp01(floor + (state.arousal - floor) * decay),
    socialNeed: clamp01(state.socialNeed + config.socialNeedGrowthPerHour * hours),
  };
}

/** Coupling knobs applied when the user messages the agent. */
export interface UserMessageCouplingConfig {
  /** Amount added to `arousal` (result clamped to `[0, 1]`). */
  userMessageArousalBump: number;
  /** `socialNeed` is capped to this value (never raised). */
  interactionSocialNeedReset: number;
}

/**
 * Apply the "user just messaged us" coupling to an already-evolved state.
 *
 * Rationale (mirrors hermes-active): a present user satisfies the agent's urge
 * to reach out, so `socialNeed` drops, while excitement (`arousal`) rises.
 * Pure: callers evolve to now first, then apply, then store.
 */
export function applyUserMessageCoupling(
  state: EmotionState,
  config: UserMessageCouplingConfig,
): EmotionState {
  return {
    valence: state.valence,
    arousal: clamp01(state.arousal + config.userMessageArousalBump),
    socialNeed: Math.min(clamp01(state.socialNeed), clamp01(config.interactionSocialNeedReset)),
  };
}

/** Blend an evolved state with an LLM assessment (`evolved*0.4 + llm*0.6`). */
export function mergeEmotionAssessment(
  evolved: EmotionState,
  assessment: EmotionState,
  evolvedWeight: number = EMOTION_EVOLVED_WEIGHT,
  assessmentWeight: number = EMOTION_ASSESSMENT_WEIGHT,
): EmotionState {
  return {
    valence: clamp01(evolved.valence * evolvedWeight + assessment.valence * assessmentWeight),
    arousal: clamp01(evolved.arousal * evolvedWeight + assessment.arousal * assessmentWeight),
    socialNeed: clamp01(
      evolved.socialNeed * evolvedWeight + assessment.socialNeed * assessmentWeight,
    ),
  };
}

/**
 * Parse an LLM emotion assessment. Accepts a JSON object with numeric
 * `valence` / `arousal` / `socialNeed` fields (optionally wrapped in prose).
 * Returns `undefined` when no valid assessment can be extracted.
 */
export function parseEmotionAssessment(text: string): EmotionState | undefined {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const valence = record['valence'];
  const arousal = record['arousal'];
  const socialNeed = record['socialNeed'];
  if (
    typeof valence !== 'number' ||
    typeof arousal !== 'number' ||
    typeof socialNeed !== 'number' ||
    !Number.isFinite(valence) ||
    !Number.isFinite(arousal) ||
    !Number.isFinite(socialNeed)
  ) {
    return undefined;
  }
  return { valence: clamp01(valence), arousal: clamp01(arousal), socialNeed: clamp01(socialNeed) };
}

/** Options for {@link EmotionStore}. */
export interface EmotionStoreOptions {
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
  /** Dynamics applied on every evolution step. */
  config?: EmotionDynamicsConfig;
  /** State assigned to a session the first time it is observed. */
  initialState?: EmotionState;
}

/**
 * In-memory per-session emotion store. `get()` lazily captures the initial
 * state and evolves it to the current clock time on every read.
 */
export class EmotionStore {
  readonly #states = new Map<string, { state: EmotionState; updatedAt: number }>();
  readonly #now: () => number;
  readonly #config: EmotionDynamicsConfig;
  readonly #initial: EmotionState;

  constructor(options: EmotionStoreOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#config = options.config ?? DEFAULT_EMOTION_DYNAMICS;
    this.#initial = options.initialState ?? DEFAULT_EMOTION_STATE;
  }

  /** Number of tracked sessions. */
  get size(): number {
    return this.#states.size;
  }

  /** Ids of every tracked session. */
  sessions(): string[] {
    return [...this.#states.keys()];
  }

  /** Evolve the session state to `now()` and return a copy. */
  get(sessionId: string): EmotionState {
    const now = this.#now();
    const entry = this.#states.get(sessionId);
    if (!entry) {
      const state = { ...this.#initial };
      this.#states.set(sessionId, { state, updatedAt: now });
      return { ...state };
    }
    const evolved = evolveEmotion(entry.state, now - entry.updatedAt, this.#config);
    this.#states.set(sessionId, { state: evolved, updatedAt: now });
    return { ...evolved };
  }

  /** Read the stored state without evolving it. */
  peek(sessionId: string): EmotionState | undefined {
    const entry = this.#states.get(sessionId);
    return entry ? { ...entry.state } : undefined;
  }

  /** Overwrite the stored state (e.g. after an LLM assessment merge). */
  set(sessionId: string, state: EmotionState): void {
    this.#states.set(sessionId, { state: { ...state }, updatedAt: this.#now() });
  }

  /** Forget all tracked sessions. */
  clear(): void {
    this.#states.clear();
  }
}
