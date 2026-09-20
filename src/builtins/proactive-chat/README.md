# proactive-chat (placeholder)

The first plugin for the KAIROS kernel: an **agent-initiated** conversation
plugin. This directory currently contains only the lifecycle shell; the
decision logic is deliberately unimplemented pending research.

## Status

| Piece | State |
| --- | --- |
| Plugin identity + lifecycle (`init`/`teardown`) | done |
| Config slice (`llm.plugins.proactiveChat`) | defaulted in `src/config/config.ts` |
| Trigger evaluation loop | **TODO** |
| Throttling / rate limiting | **TODO** |
| Decision gate (should I speak now?) | **TODO** |
| Outbound send path (`ctx.send` → `message:outbound`) | provided by kernel |

## Open design questions

### 1. Trigger types
- Which triggers exist: idle-session timers, scheduled reminders, external
  events on the event bus, calendar/deadline awareness, unanswered questions?
- Are triggers declarative (config) or code-level subscriptions?
- Should triggers be per-session, global, or both?

### 2. Throttling and pacing
- What are the right units: per-session silence window, per-hour cap,
  per-day cap, or token budget?
- How is "too many messages" enforced — drop, defer, or coalesce?
- Quiet hours / timezone handling: whose clock, session metadata or host?
- Backoff after the user ignores an initiation?

### 3. Decision gate
- Does every eligible trigger produce a message, or does the LLM decide
  (`complete()` returns a structured "should speak / what to say")?
- What context goes into the prompt: recent messages, session metadata,
  idle duration, prior initiations?
- How is a "no-op" decision represented and audited?
- What is the failure mode when the LLM call errors or returns garbage?

### 4. Session selection and creation
- Iterate all sessions each tick, or keep an index of eligible sessions?
- May the plugin open a brand-new session unprompted (`allowNewSessions`)?
- How is concurrency with a user reply handled (race: user types while the
  plugin is generating)?

### 5. Observability
- What events should be emitted for audit (`initiation:considered`,
  `initiation:skipped`, `initiation:made`)?
- Do we persist initiation history, or is in-memory enough for v1?

## Wiring notes
- `ctx.scheduler.registerTask({ name, intervalMs, run })` is the intended
  interval source; the scheduler already skips overlapping runs.
- `ctx.send(sessionId, content)` appends an `agent` message and emits
  `message:outbound` — plugins must not append messages directly.
- Config access: `ctx.config.proactiveChat` (see `ProactiveChatConfig`).
