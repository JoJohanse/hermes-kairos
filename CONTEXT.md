# CONTEXT.md — domain glossary

The vocabulary this repo uses for its domain. Architecture reviews and designs
should use these names for modules and seams, not invented synonyms.

## Runtime & hosting

- **Runtime** — the kernel process: owns the event bus, session store,
  scheduler, LLM provider, plugin JSON storage, and the plugin registry.
  Constructed by a composition root (`src/index.ts`, or the bridge entry).
- **Plugin** — a unit of behavior registered with the runtime; receives
  `PluginContext` services at init and is failure-isolated.
- **Bridge** (hermes-bridge) — an HTTP sidecar that hosts the runtime for the
  hermes-agent process: forwards inbound messages, delivers proactive
  outreach to a callback URL, and owns the pidfile.
- **Delivery mode** — who composes a proactive message: `self` (the plugin's
  thought engine writes and sends it) or `delegate` (the plugin emits a
  directive and an external agent composes/speaks it). The bridge's
  `turn`/`verbatim` argv/config values map onto these.

## proactive-chat

- **Heartbeat** — one scheduled tick. The plugin iterates candidate sessions;
  each session goes through the per-session **pipeline** (module:
  `heartbeat.ts`, interface: `tick(session, now)`).
- **Guardrail veto** — a hard precondition that ends the tick for a session
  before any LLM spend: quiet hours, recent activity, cooldown, hourly cap,
  daily cap.
- **Decision** — the deterministic gate that bands a session into `generate`
  / `hold` / `skip` from an arithmetic score over emotion, time-of-day
  fitness, silence, and frequency.
- **Emotion state** — per-session `valence`/`arousal`/`socialNeed` in `[0,1]`,
  evolved by wall-clock dynamics and coupled by user messages (arousal bumps,
  social need resets). Calibration is load-bearing; see AGENTS.md.
- **HOLD band** — scores between hold and send thresholds. Queues a
  **held stub**: a contentless placeholder that costs zero LLM calls.
- **Promotion** — a later tick re-scores held stubs; one whose fresh score
  reaches the send threshold is promoted, and only then is content generated.
  At most one delivery per tick; extra promoted stubs re-enqueue.
- **Thought** — LLM-generated proactive content (or an LLM veto via `SKIP`).
- **Snapshot** — the plugin's persisted state (`proactive-chat.json`):
  emotion states, send timestamps, held stubs. Restores prune and evolve to
  the reload clock.
