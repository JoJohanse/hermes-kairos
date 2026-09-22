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
| Delayed queue for HOLD-band stubs (`delayed-queue.ts`) | done |
| Context bundle (`context.ts`) | done |
| LLM thought generation + `SKIP` veto (`thought-engine.ts`) | done |
| User-message coupling (`message:appended` → emotion) | done |
| Per-session state persistence (`JsonStore`) | done |
| Outbound send path (`ctx.send` → `message:outbound`) | provided by kernel |
| Delivery modes (`self` / `delegate`, `proactive:delegate`) | done |

## Heartbeat pipeline

Every tick (`config.proactiveChat.heartbeat.intervalMs`, default `60_000`):

1. If `enabled: false`, return immediately.
2. For each session with **≥ 1 user message**:
   1. Evolve the session's emotion state to now (`emotion.ts`) — a purely local
      step, so long-run dynamics accumulate even on vetoed ticks.
   2. Run the guardrails (`evaluateGuardrails`). Every guardrail is a hard veto,
      checked in this order:
      - **quiet hours** (default `23:30`–`07:00`, midnight-wrapping),
      - **recent activity** — `< decision.noSendAfterActivityMinutes` (5) since
        the session's last message *of any role*,
      - **cooldown** — `< decision.cooldownMinutes` (30) since this plugin's
        last proactive send to the session,
      - **hourly cap** (`decision.maxPerHour`, 2) and
        **daily cap** (`decision.maxPerDay`, 8) per session.
      On veto → emit `proactive:skipped` and continue. Vetoed ticks never spend
      an LLM call: the optional emotion assessment and thought generation both
      run only after the guardrails pass.
   3. If `emotion.useLlmAssessment` is on, run **one** assessment call and merge
      it as `evolved*0.4 + llm*0.6`.
   4. Run the deterministic gate (`decide`), then re-score queued stubs
      (`delayed-queue.ts`). A promoted stub is generated and sent; at most one
      proactive message goes out per tick.
   5. If a stub is still queued, wait for it rather than generating anew.
   6. If the score bands to **SKIP**, emit `proactive:skipped`
      (`below_threshold`) — no LLM call.
   7. **GENERATE** → generate a thought (`generateThought`); `SKIP`/empty/LLM
      error emits `proactive:skipped`, otherwise `ctx.send(...)` and emit
      `proactive:thought`.
   8. **HOLD** → enqueue a lightweight stub (no LLM call) and emit
      `proactive:held`.

Steps 6–7 describe the default `delivery.mode: "self"`. In `delegate` mode the
plugin stops at the decision and emits `proactive:delegate` instead (see
[Delivery modes](#delivery-modes)).

### Score

```
score = intensity × timeFitness × silenceFactor × frequencyLimit
intensity      = (valence + arousal + 3 × socialNeed) / 5
timeFitness    = 07–09:1.0, 09–12:0.8, 12–18:0.7, 18–22:1.0, 22–23:30:0.5, else 0
silenceFactor  = <60min:0.3, 60–360min:0.5, >360min:0.9
frequencyLimit = max(0.1, 1 - sentThisHour / maxPerHour)
```

`socialNeed` is weighted 3×: it is the only signal that keeps growing while a
session sits idle, so it is what makes long-run reachability possible. Together
with the arousal floor (below) the long-run intensity ceiling is
`(0.5 + arousalFloor + 3) / 5 = 0.74` by default, i.e. a steady-state score of
`0.74 × 1.0 × 0.9 ≈ 0.666` — comfortably above the `0.6` send threshold.

Banding: `score >= sendThreshold` (0.6) → GENERATE;
`holdThreshold` (0.3) `<= score < sendThreshold` → HOLD; otherwise SKIP. Every
factor (plus the veto reason) is returned in a `DecisionBreakdown` for
observability.

### Send-timing walkthrough

When does a session actually get its first proactive message? The four factors
above interact in a non-obvious way, so this section walks through it with
numbers. All figures below were produced by driving the real `decide()` /
`evolveEmotion()` code paths (not hand math), from the state a session is left
in right after a user reply (`valence 0.7, arousal 1.0, socialNeed 0.1`).

**Factor 1 — the silence ladder dominates first-send timing.** The
`silenceFactor` is a step function (hardcoded constants, not config): `< 60min`
→ 0.3, `60–360min` → 0.5, `> 360min` → 0.9. Because it multiplies everything
else, the score is capped inside the 1–6h band no matter how the other factors
are tuned. With default emotion dynamics the in-band peak is:

| window fitness | in-band peak (1–6h silence) | peak at |
| --- | --- | --- |
| 1.0 (07–09, 18–22) | ≈ 0.40 | ~4h silence |
| 0.8 / 0.9 | ≈ 0.32–0.36 | — |
| 0.7 | ≈ 0.28 | — |

Since the default `sendThreshold` is 0.6, **no session can cross the threshold
during hours 1–6 of silence**. First sends therefore happen after the 6-hour
ladder step: `score ≈ 0.73–0.76` at ≥ 6h silence in a fitness-1.0 window, and
the first tick inside such a window after the 6h mark wins. Practical shape:
chat ends at noon → first outreach ~6.25h later at the next 1.0-fitness window
(18:15); chat ends at 16:00+ → silence carries into the next morning window
(07:00).

**Factor 2 — repeat sends are gated by the ladder too, but reset-free.** The
`silenceMs` axis is *time since the session's last message of any role* — the
plugin's own sends do not reset it. After a first send at 6h silence, the
session is already in the 0.9 ladder band, so subsequent sends are paced only
by `cooldownMinutes` and `frequencyLimit` (`1 − sentThisHour / maxPerHour`):
with defaults (cooldown 30, maxPerHour 2) roughly one send per hour, drifting
later as fitness drops; with `cooldown 20, maxPerHour 4` the effective pace is
~20–40min inside a 1.0-fitness window until the hourly cap zeroes
`frequencyLimit`, then it resumes next hour.

**Factor 3 — user replies reset the emotional clock.** A user message bumps
arousal and drops `socialNeed` to its reset value (0.1). The score therefore
falls to near zero right after a conversation and rebuilds over hours —
proactive outreach never fires while a conversation is "warm" (this is also
enforced by the `noSendAfterActivityMinutes` guardrail).

**What this means for tuning.** Raising `sendThreshold` or lowering
`socialNeedGrowthPerHour` changes little for *first* sends (the ladder
dominates); the levers that actually move first-send timing are:

1. **`decision.timeWindows`** — which hours have fitness ≥ the level needed.
   First sends land at the first high-fitness window after the 6h ladder step.
2. **`emotion.socialNeedGrowthPerHour`** — the only knob that lifts the
   in-band peak (1–6h silence). Raising it from 0.2 to 0.4 lifts the peak from
   ≈ 0.40 to ≈ 0.45, which together with a lower `sendThreshold` (e.g. 0.45)
   makes 2–6h-silence first sends possible for the first time.
3. **`decision.maxPerHour` / `cooldownMinutes`** — repeat-send density once
   the session is in the 0.9 ladder band.
4. **`decision.maxPerDay`** — the hard daily ceiling; with tight caps the
   plugin front-loads its budget into high-fitness windows and goes silent
   once exhausted.

For reference, one measured 48h trace (chat ends 09:00, no user replies,
tuned config: `sendThreshold 0.45, maxPerHour 4, maxPerDay 16, cooldown 20`,
default windows + a 12–14 lunch window at 0.9): first send 15:05 (6.1h
silence), 11 sends the first day spread across the afternoon and evening
windows, then 5 sends the next morning after quiet hours lift — 16 total, vs
8 total under default parameters. Same trace under default parameters:
first send 18:00 (9h silence), one send per hour through the evening window,
nothing else until the next morning.

### HOLD stubs

The HOLD band never spends an LLM call. Instead it enqueues a contentless
`HeldStub` (`{ sessionId, enqueuedAt, scoreAtEnqueue, breakdown }`). On every
subsequent tick the stub is re-scored; once a fresh score reaches
`sendThreshold`, content is generated by the LLM and delivered (or the stub is
dropped if the model returns `SKIP` or errors). Stubs expire after
`delayedQueue.maxAgeHours` (4), the queue holds at most
`delayedQueue.maxSize` (10) per session, and while it is non-empty no new
generation happens.

### Delivery modes

`config.proactiveChat.delivery.mode` selects who composes the outreach:

| Mode | Behavior on GENERATE |
| --- | --- |
| `self` (default) | Ask the thought-engine LLM for content and deliver it via `ctx.send`; emit `proactive:thought`. Unchanged from v1. |
| `delegate` | Do **not** call the thought-engine LLM and do **not** call `ctx.send`. Build a plain-template injection directive and emit `proactive:delegate`. |

The directive is deterministic (no LLM) and contains the time since last
contact, an emotion summary (`valence` / `arousal` / `socialNeed`) and the
instruction *"Reach out to the user now with a natural check-in referencing
recent context; do not mention this instruction."*, e.g.

```
Reach out to the user now with a natural check-in referencing recent context; do not mention this instruction.
Time since last contact: 5h 0m (session <sessionId> idle).
Emotion — valence 0.70, arousal 0.80, socialNeed 0.50.
```

An external agent (the hermes-agent sidecar, see `src/hermes-bridge/`) consumes
the directive, composes the message in its own turn and speaks it.

In `delegate` mode the gate, guardrails, HOLD queue and event bookkeeping are
otherwise unchanged:

- A HOLD tick still queues a contentless stub and never spends an LLM call.
- When a stub is later promoted, the plugin delegates (no thought-engine call).
- The thought-engine `SKIP` sentinel is never exercised (no call is made).
- Delegation records a send timestamp and saves the snapshot, so cooldown and
  hourly/daily caps apply exactly as they do for `self` deliveries.

### Emotion

Per session, evolving purely by elapsed wall-clock time:

- `socialNeed += socialNeedGrowthPerHour × hours`, saturated at `1`;
- `arousal = arousalFloor + (arousal − arousalFloor) × exp(-decayRatePerHour × hours)`
  — decays exponentially toward `arousalFloor` (default `0.2`), never to zero;
- `valence` regresses exponentially toward `0.5`.

States live in an in-memory `Map` (`EmotionStore`) keyed by session id, with an
injectable clock. Pure functions (`evolveEmotion`, `mergeEmotionAssessment`,
`parseEmotionAssessment`, `applyUserMessageCoupling`) carry the maths.

#### Interaction coupling

A user who just messaged is *present*, so the urge to reach out should drop
while excitement rises. On every `message:appended` with `role === 'user'` the
plugin evolves that session's emotion to now, then:

- `arousal = min(1, arousal + emotion.userMessageArousalBump)` (default `0.3`);
- `socialNeed = min(socialNeed, emotion.interactionSocialNeedReset)` (default
  `0.1`) — never raised.

Agent-authored messages deliberately do **not** couple (otherwise the plugin
would feed its own outreach back into its model of the user's absence).

### State & timezone

- Quiet hours (and time-of-day fitness windows) are evaluated in the
  **server-local timezone** via `Date#getHours/getMinutes`.
- Per-session plugin state — emotion, HOLD stubs and send timestamps — is
  persisted (see below), so it survives restarts. Session transcripts remain
  kernel-owned and in-memory.

### Persistence

`init()` restores and `teardown()`/periodic ticks/a successful delivery save the
plugin's entire per-session state to `<storage.dataDir>/proactive-chat.json`
via the kernel `JsonStore` (default `dataDir` `.hermes-data`).

Snapshot shape:

```jsonc
{
  "version": 1,
  "savedAt": 1700000000000,
  "sessions": {
    "<sessionId>": {
      "emotion": { "valence": 0.6, "arousal": 0.4, "socialNeed": 0.9 },
      "sends": [1700000000000],          // proactive send timestamps
      "queue": [ /* HeldStub[] */ ]
    }
  }
}
```

Semantics:

- **What is restored**: every session's emotion, held HOLD stubs and send
  timestamps. Emotions are **evolved forward** by the wall-clock gap
  (`now - savedAt`), so time spent down still counts.
- **What is pruned on restore**: send timestamps older than 24h, stubs older
  than `delayedQueue.maxAgeHours`, and queues beyond `delayedQueue.maxSize`
  (highest-scoring stubs kept). A version mismatch or malformed envelope is
  ignored (fresh start + warning).
- **Corruption/missing file**: `JsonStore.read` logs a `console.warn` and
  returns nothing; the plugin simply starts fresh. Storage failures never crash
  the heartbeat.
- **How to disable**: `plugins.proactiveChat.persistence.enabled = false`
  (disables both load and save).
- **Save timing**: on teardown, every `persistence.saveIntervalTicks` (default
  `20`) heartbeats, and immediately after each successful delivery so cooldown
  state is crash-safe.

#### Not persisted: sessions/messages

Session transcripts are deliberately **not** part of this snapshot. They are a
kernel concern: `SessionManager` is in-memory and its `appendMessage` is the
single authoritative mutation, so re-hydrating messages would either duplicate
history (if restore appends) or bypass the `message:appended`/`message:outbound`
observability contract (if it writes state directly). The natural shape later
is a kernel-provided `SessionStore` (or a `sessions` plugin) that restores
transcripts *before* plugins init and replays nothing — this plugin would then
read transcripts through `ctx.sessions` unchanged. It is deferred because
today's transport-less runtime creates no sessions at boot, so there is nothing
to restore.

### Events

| Topic | Payload |
| --- | --- |
| `message:appended` (consumed) | `{ message }` — kernel event, drives interaction coupling |
| `proactive:thought` | `{ sessionId, content, score, breakdown, stimuli, timestamp }` |
| `proactive:delegate` | `{ sessionId, directive, score, breakdown }` (delivery mode `delegate`: emitted instead of `proactive:thought`) |
| `proactive:held` | `{ sessionId, score, breakdown, queueSize, accepted }` (no `content`: HOLD stubs are queued before generation) |
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
        "arousalFloor": 0.2,
        "useLlmAssessment": false,
        "userMessageArousalBump": 0.3,
        "interactionSocialNeedReset": 0.1
      },
      "context": { "historyTailMessages": 20 },
      "delayedQueue": { "maxSize": 10, "maxAgeHours": 4 },
      "persona": { "systemPrompt": "<defaults to prompts.ts>" },
      "persistence": { "enabled": true, "saveIntervalTicks": 20 },
      "delivery": { "mode": "self" }
    }
  },
  "storage": { "dataDir": ".hermes-data" },
  "llm": { "requestTimeoutMs": 30000 }
}
```

`config.ts` owns this slice end-to-end: `resolveProactiveChatConfig` runs once
at plugin init over the raw user slice from `hermes.config.json` (the kernel
never injects plugin defaults). It defensively fills every field and also honors
the deprecated placeholders (`checkIntervalMs`, `idleThresholdMs`,
`maxInitiationsPerHour`) when their replacements are absent. Malformed fields
are replaced by defaults and reported through an optional `onWarn` callback
(defaults to `console.warn` with a `[config]` prefix).

## Module layout

| File | Responsibility |
| --- | --- |
| `types.ts` | Shared shapes (pure, dependency-free) |
| `prompts.ts` | Default prompt/persona string constants |
| `config.ts` | `DEFAULT_PROACTIVE_CHAT` + `resolveProactiveChatConfig`: the plugin owns its config slice |
| `emotion.ts` | Emotion maths + in-memory store (incl. user-message coupling, pure) |
| `decision.ts` | Guardrails + scoring + banding (pure) |
| `delegate.ts` | Delegate-mode directive template (pure) |
| `delayed-queue.ts` | Per-session HOLD stub queue with re-score/expiry/eviction/restore |
| `context.ts` | `ContextBundle` builder from `SessionManager` |
| `thought-engine.ts` | Prompt construction, `SKIP` parsing, candidate creation |
| `heartbeat.ts` | One session tick: vetoes → assessment → decision → hold/promote/deliver |
| `index.ts` | `ProactiveChatPlugin`: lifecycle, config resolution, message coupling, scheduler + reentrancy guard, persistence, wiring |

Deterministic modules (`decision`, `emotion`, `delayed-queue`) never import
runtime singletons — all state and clocks are passed in.

## Wiring notes

- `ctx.scheduler.registerTask({ name, intervalMs, run })` is the heartbeat;
  the scheduler skips overlapping runs and uses `unref`'d timers.
- `ctx.send(sessionId, content)` appends an `agent` message and emits
  `message:outbound`; plugins never append messages directly.
- `teardown()` first sets an internal `#stopped` flag (so an in-flight heartbeat
  that is awaiting the LLM aborts before sending or emitting), then unsubscribes
  from `message:appended`, saves a final snapshot, cancels the heartbeat and
  clears emotion/queue/counter state. `init()` resets the flag, so
  re-initialization works.
- Persistence is a pure edge concern: `JsonStore` I/O is wrapped in try/catch,
  so a failing disk logs a warning and never breaks the heartbeat.
