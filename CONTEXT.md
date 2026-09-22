# CONTEXT.md — domain glossary

The vocabulary this repo uses for its domain. Architecture reviews and designs
should use these names for modules and seams, not invented synonyms.

## Runtime & hosting

- **Runtime** — the kernel process: owns the event bus, session store,
  scheduler, LLM provider, plugin JSON storage, and the plugin registry.
  Constructed by a composition root (`src/index.ts`, or the bridge entry).
- **Speak path** — the one owner of "speak as the agent": append the agent
  message, then emit `message:outbound` (`runtime.send`; plugins receive the
  same module as `ctx.send`). The Bridge's inbound `agent-message` events speak
  through it too — never append agent messages via `sessions.appendMessage`.
- **Plugin** — a unit of behavior registered with the runtime; receives
  `PluginContext` services at init and is failure-isolated.
- **Bridge** (hermes-bridge) — an HTTP sidecar that hosts the runtime for the
  hermes-agent process: forwards inbound messages, delivers proactive
  outreach to a callback URL, and owns the pidfile. Its lifecycle (delivery
  mode mapping, config surgery, bind + stale-pid recovery, pidfile write,
  signal shutdown) lives behind the **Bridge boot** module (`bootBridge`).
- **Pidfile contract** — `<dataDir>/sidecar.pid`; canonical body is JSON
  `{"pid": <positive int>, "nonce": <string>}`, written by the sidecar after a
  successful bind; bare `<pid>` / `<pid> <nonce>` bodies from older writers are
  still honored by both lanes' recovery readers. The wire/pidfile contract is
  the `contract.json` fixture, byte-identical between
  `src/hermes-bridge/contract.json` and
  `hermes-plugin/kairos/tests/contract.json` (identity enforced by tests on
  both lanes).
- **Delivery mode** — who composes a proactive message: `self` (the plugin's
  thought engine writes and sends it) or `delegate` (the plugin emits a
  directive and an external agent composes/speaks it). The mapping from the
  bridge's `turn`/`verbatim` argv/config values onto these is owned by the
  Bridge boot module.

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
- **Send log** — per-session proactive send timestamps (`SendLog`); the
  one-day send window is owned here and pruned in place on every read, so
  guardrail counts, the snapshot, and observability never re-filter raw stamps.
- **Promotion** — a later tick re-scores held stubs; one whose fresh score
  reaches the send threshold is promoted, and only then is content generated.
  At most one delivery per tick; extra promoted stubs re-enqueue.
- **Thought** — LLM-generated proactive content (or an LLM veto via `SKIP`).
- **Snapshot** — the plugin's persisted state (`proactive-chat.json`):
  emotion states, send timestamps, held stubs. Restores prune and evolve to
  the reload clock.
