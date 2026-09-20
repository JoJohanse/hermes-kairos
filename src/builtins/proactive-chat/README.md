# proactive-chat

The first KAIROS plugin: an **agent-initiated** conversation engine. A heartbeat
evaluates each candidate session and decides whether to reach out — and if so,
what to say.

"Should we speak?" is a **two-stage gate**:

1. **Deterministic** (`decision.ts`) — cheap guardrails and a score decide
   whether to *ask*.
2. **LLM** (`thought-engine.ts`) — the model decides *what* to say, and may
   veto with the sentinel `SKIP`.

## Status

| Piece | State |
| --- | --- |
| Plugin identity + lifecycle (`init`/`teardown`) | done |
| Config slice (`plugins.proactiveChat`) | done, deeply defaulted + defensively resolved |
| Heartbeat trigger (`proactive-chat.heartbeat`, default 60s) | done |
| Guardrails + scoring (`decision.ts`) | done |
| Time-driven emotion (`emotion.ts`) | done |
| Delayed queue for HOLD-band thoughts (`delayed-queue.ts`) | done |
| Context bundle (`context.ts`) | done |
| LLM thought generation + `SKIP` veto (`thought-engine.ts`) | done |
| Outbound send path (`ctx.send` → `message:outbound`) | provided by kernel |

## Heartbeat pipeline

Every tick (`config.proactiveChat.heartbeat.intervalMs`, default `60_000`):

1. If `enabled: false`, return immediately.
2. For each session with **≥ 1 user message**:
   1. Evolve the session's emotion state to now (`emotion.ts`). If
      `emotion.useLlmAssessment` is on, one assessment call is merged as
      `evolved*0.4 + llm*0.6`.
   2. Run the deterministic gate (`decide`). Every guardrail is a hard veto,
      checked in this order:
      - **quiet hours** (default `23:30`–`07:00` local, midnight-wrapping),
      - **recent activity** — `< decision.noSendAfterActivityMinutes` (5) since
        the session's last message *of any role*,
      - **cooldown** — `< decision.cooldownMinutes` (30) since this plugin's
        last proactive send to the session,
      - **hourly cap** (`decision.maxPerHour`, 2) and
        **daily cap** (`decision.maxPerDay`, 8) per session.
      On veto → emit `proactive:skipped` and continue.
   3. Re-score queued `ThoughtCandidate`s (`delayed-queue.ts`). Promoted
      candidates are sent; at most one proactive message goes out per tick.
   4. If a candidate is still queued, wait for it rather than generating anew.
   5. If the score bands to **SKIP**, emit `proactive:skipped`
      (`below_threshold`) — no LLM call.
   6. Otherwise generate a thought (`generateThought`). `SKIP`/empty/LLM error
      emits `proactive:skipped`; else:
      - **GENERATE** → `ctx.send(...)`, emit `proactive:thought`.
      - **HOLD** → enqueue for a later tick, emit `proactive:held`.

### Score

```
score = intensity × timeFitness × silenceFactor × frequencyLimit
intensity      = (valence + arousal + socialNeed) / 3
timeFitness    = 07–09:1.0, 09–12:0.8, 12–18:0.7, 18–22:1.0, 22–23:30:0.5, else 0
silenceFactor  = <60min:0.3, 60–360min:0.5, >360min:0.9
frequencyLimit = max(0.1, 1 - sentThisHour / maxPerHour)
```

Banding: `score >= sendThreshold` (0.6) → GENERATE;
`holdThreshold` (0.3) `<= score < sendThreshold` → HOLD; otherwise SKIP. Every
factor (plus the veto reason) is returned in a `DecisionBreakdown` for
observability.

### Emotion

Per session, evolving purely by elapsed wall-clock time:

- `socialNeed += socialNeedGrowthPerHour × hours`, saturated at `1`;
- `arousal *= exp(-decayRatePerHour × hours)`;
- `valence` regresses exponentially toward `0.5`.

States live in an in-memory `Map` (`EmotionStore`) keyed by session id, with an
injectable clock. Pure functions (`evolveEmotion`, `mergeEmotionAssessment`,
`parseEmotionAssessment`) carry the maths.

### Events

| Topic | Payload |
| --- | --- |
| `proactive:thought` | `{ sessionId, content, score, breakdown, stimuli, timestamp }` |
| `proactive:held` | `{ sessionId, content, score, breakdown, queueSize, accepted }` |
| `proactive:skipped` | `{ sessionId, reason }` |

`stimuli` is the list of transcript message ids fed to the model (provenance).

## Configuration

```jsonc
{
  "plugins": {
    "proactiveChat": {
      "enabled": true,
      "heartbeat": { "intervalMs": 60000 },
      "decision": {
        "sendThreshold": 0.6,
        "holdThreshold": 0.3,
        "maxPerHour": 2,
        "maxPerDay": 8,
        "cooldownMinutes": 30,
        "noSendAfterActivityMinutes": 5,
        "quietHours": { "start": "23:30", "end": "07:00" }
      },
      "emotion": {
        "decayRatePerHour": 0.1,
        "socialNeedGrowthPerHour": 0.2,
        "useLlmAssessment": false
      },
      "context": { "historyTailMessages": 20 },
      "delayedQueue": { "maxSize": 10, "maxAgeHours": 4 },
      "persona": { "systemPrompt": "<defaults to prompts.ts>" }
    }
  }
}
```

`resolveProactiveChatConfig` defensively fills every field and also honors the
deprecated placeholders (`checkIntervalMs`, `idleThresholdMs`,
`maxInitiationsPerHour`) when their replacements are absent.

## Module layout

| File | Responsibility |
| --- | --- |
| `types.ts` | Shared shapes (pure, dependency-free) |
| `prompts.ts` | Default prompt/persona string constants |
| `emotion.ts` | Emotion maths + in-memory store |
| `decision.ts` | Guardrails + scoring + banding (pure) |
| `delayed-queue.ts` | Per-session HOLD queue with re-score/expiry/eviction |
| `context.ts` | `ContextBundle` builder from `SessionManager` |
| `thought-engine.ts` | Prompt construction, `SKIP` parsing, candidate creation |
| `index.ts` | `ProactiveChatPlugin`: config, heartbeat, counters, events |

Deterministic modules (`decision`, `emotion`, `delayed-queue`) never import
runtime singletons — all state and clocks are passed in.

## Wiring notes

- `ctx.scheduler.registerTask({ name, intervalMs, run })` is the heartbeat;
  the scheduler skips overlapping runs and uses `unref`'d timers.
- `ctx.send(sessionId, content)` appends an `agent` message and emits
  `message:outbound`; plugins never append messages directly.
- `teardown()` cancels the heartbeat and clears emotion/queue/counter state.
