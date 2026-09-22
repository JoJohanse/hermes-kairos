# hermes-kairos

![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square) ![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square) ![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-orange?style=flat-square)

**English** | [中文](README_zh.md)

![KAIROS — Think · Memory · Conversation](docs/images/banner-en.jpg)

**KAIROS** (Kernel for Autonomous Initiative and Response Orchestration System) is a small, dependency-free agent runtime for building agents that *start* conversations rather than only answer them. The kernel supplies the shared services an autonomous agent needs — a typed event bus, in-memory session/message storage, an interval scheduler with overlap protection, a pluggable LLM provider, and a failure-isolated plugin registry — and delegates all behavior to plugins; the first of them is a **proactive-conversation** plugin that decides when the agent should speak up on its own.

## Contents

- [Architecture](#architecture)
  - [Lifecycle](#lifecycle)
- [Requirements](#requirements)
- [Install](#install)
- [Run](#run)
- [Test](#test)
- [Install as a hermes-agent plugin](#install-as-a-hermes-agent-plugin)
  - [Delivery modes](#delivery-modes)
  - [Prerequisites](#prerequisites)
  - [Steps](#steps)
  - [Verify](#verify)
  - [Notes](#notes)
- [Configuration](#configuration)
- [How send timing is computed](#how-send-timing-is-computed)

---

## Architecture

```
hermes-kairos/
├── src/
│   ├── config/               # loadConfig(): env defaults + optional hermes.config.json
│   ├── core/                 # types, typed event bus, session manager, JsonStore, runtime
│   ├── hermes-bridge/        # HTTP sidecar entry used by the hermes-agent plugin
│   ├── llm/                  # fetch-based OpenAI-compatible provider + deterministic mock
│   ├── plugins/              # Plugin / PluginContext types, failure-isolated registry
│   ├── scheduler/            # setInterval tasks, skips overlapping runs
│   └── builtins/
│       └── proactive-chat/   # the proactive-conversation plugin (internals: its own README)
└── hermes-plugin/kairos/     # native hermes-agent plugin (bridges to the sidecar)
```

> The kernel is intentionally lean: zero runtime dependencies, LLM access through the global `fetch`, and no opinion about persistence, transport, or UI — those are additions a deployment (or a later plugin) can layer on. The proactive-chat plugin's internals are documented in [`src/builtins/proactive-chat/README.md`](src/builtins/proactive-chat/README.md).

### Lifecycle

1. `loadConfig()` resolves LLM settings from env (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) and merges an optional `hermes.config.json` at the repo root.
2. `new HermesRuntime({ config, llm })` creates the event bus, session manager (wired to the bus for `message:appended`), scheduler, `JsonStore` and plugin registry.
3. `runtime.register(plugin)` adds plugins (the built-in proactive-chat plugin is registered by the bootstrap).
4. `runtime.start()` starts the scheduler, then runs `init(ctx)` for each plugin in order; a throwing plugin is logged and skipped without blocking the rest.
5. `runtime.stop()` tears plugins down in reverse order and stops the scheduler.

`PluginContext.send(sessionId, content)` is the only sanctioned way for a plugin to speak: it appends an `agent`-role message and emits `message:outbound` on the bus. Every message appended through the session store (any role) also emits `message:appended`, and plugins receive a `PluginContext.storage` (`JsonStore`) for durable JSON state under `storage.dataDir`.

## Requirements

- Node.js >= 20 (developed on v24) — no bun requirement
- npm (any version bundled with Node 20+)

## Install

```bash
npm install
```

## Run

```bash
npm run dev      # tsx src/index.ts — boots the runtime, logs "hermes-kairos runtime started"
npm run build    # tsc → dist/   (run with: node dist/index.js)
```

Press `Ctrl+C` to stop; the SIGINT/SIGTERM handler stops the runtime gracefully.

## Test

```bash
npm test         # vitest run (colocated *.test.ts)
```

---

## Install as a hermes-agent plugin

This repo ships a native [hermes-agent](https://github.com/NousResearch/hermes-agent) plugin (`hermes-plugin/kairos/`) that exposes the proactive-conversation capability through the official hermes plugin contract: the plugin spawns and supervises the kairos sidecar (`src/hermes-bridge/`), feeds hermes session activity into the KAIROS gate, and at the right moment calls `ctx.inject_message()` so hermes starts a conversation on its own.

### See it in action

A real session from our hermes-agent test environment — you talk about ONE OK ROCK in the evening…

| …and the next morning, kairos opens the conversation itself |
| --- |
| ![Evening: a conversation about ONE OK ROCK](docs/images/chat-conversation.png) |
| ![Next morning: the proactive reach-out](docs/images/chat-proactive.png) |

*(The morning message remembers yesterday's topic, recommends tracks from the 《DETOX》 album, and adds a market note — authored by hermes's LLM, triggered by the KAIROS gate.)*

> 中文安装指南见 [README_zh.md](README_zh.md)。

### Delivery modes

The `deliveryMode` setting decides who writes the proactive message:

|  | `turn` *(default)* | `verbatim` |
| --- | --- | --- |
| Who authors the message | hermes — the agent re-enters the conversation and writes its own reply | kairos — the sidecar has already produced the final text |
| Delivery path | `ctx.inject_message()` | `hermes send --to <hermesSendTarget>` |
| Best for | When the agent should *think* before speaking | Fire-and-forget outbound; requires `hermesSendTarget` |

### Prerequisites

- A working hermes-agent install (Python >= 3.11) with the `hermes` command available
- Node.js >= 20 + npm (sidecar runtime)
- A usable LLM configured in hermes (the `model:` section of `~/.hermes/config.yaml`)

### Steps

1. Build this repo (produces `dist/hermes-bridge/main.js`):

   ```bash
   npm install && npm run build
   ```

2. Copy the plugin directory into hermes:

   ```bash
   # Linux / macOS
   cp -r hermes-plugin/kairos ~/.hermes/plugins/kairos
   # Windows (PowerShell)
   Copy-Item -Recurse hermes-plugin/kairos "$env:USERPROFILE\.hermes\plugins\kairos"
   ```

3. Point the plugin at the sidecar — set the environment variable (must be set before hermes starts; put it in your system env or hermes `.env`):

   ```bash
   KAIROS_DIST="<absolute path to this repo>/dist/hermes-bridge/main.js"
   ```

   > [!IMPORTANT]
   > Once the plugin is copied to `~/.hermes/plugins/`, the default relative path `~/.hermes/dist/...` does not exist — **setting `KAIROS_DIST` is mandatory**. Alternatively configure a `sidecarCommand` array under `plugins.entries.kairos.settings`.

4. Enable the plugin and allow injection in `~/.hermes/config.yaml` (required for gateway mode):

   ```yaml
   plugins:
     enabled:
       - kairos
     entries:
       kairos:
         allow_gateway_injection: true   # required for proactive injection in gateway mode
         settings:
           deliveryMode: turn            # turn=hermes authors the message; verbatim=kairos content via hermes send
           port: 8671
           callbackPort: 8672
           # leave token empty = a random token is generated at every start (recommended)
   ```

### Verify

1. Check registration:

   ```bash
   hermes plugins list            # kairos should show enabled
   hermes plugins doctor kairos   # should show registration passed, 3 hook(s)
   ```

2. Start `hermes gateway` (or a CLI session). Successful install looks like:

   ```text
   [kairos] sidecar is healthy
   [kairos] kairos plugin ready
   ```

3. Trigger check — on any inbound user message, the kairos hooks forward the activity to the sidecar and the heartbeat gate (every 60s by default) evaluates whether to reach out; in `turn` mode the plugin calls `ctx.inject_message()` so hermes starts a new topic itself. After one exchange with hermes you can force an evaluation:

   ```bash
   curl -X POST http://127.0.0.1:8671/trigger -H "authorization: Bearer <token>"
   ```

   Log proof: `[kairos] inject_message -> True` means the proactive message was accepted by hermes.

### Notes

> [!WARNING]
> In `turn` mode proactive messages only route to **existing** sessions (the platform/channel must have seen an inbound message before); brand-new sessions log a `no session_key observed` hint.

> [!CAUTION]
> The sidecar binds to `127.0.0.1` only; a token is generated automatically by default — set `token: "none"` explicitly to disable auth (**not recommended**).

- The plugin's own state (emotion / HOLD queue / cooldown counters) persists under `storage.dataDir` (default `.hermes-data/`) and survives restarts.
- Full reference (routing details, verbatim mode, troubleshooting table): [`hermes-plugin/kairos/README.md`](hermes-plugin/kairos/README.md)

---

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API root |
| `LLM_API_KEY` | *(empty)* | Bearer token |
| `LLM_MODEL` | `gpt-4o-mini` | Model id |

`storage.dataDir` (default `.hermes-data`) is where plugins persist JSON state;
it is created lazily on first write and is git-ignored.

Optional `hermes.config.json` at the repo root overrides any of the above and the
plugin defaults, e.g.:

```json
{
  "llm": { "model": "gpt-4.1-mini", "requestTimeoutMs": 30000 },
  "plugins": {
    "proactiveChat": {
      "enabled": true,
      "decision": { "noSendAfterActivityMinutes": 5 }
    }
  }
}
```

Sessions/messages remain in-memory in the kernel (persistence is a deployment
concern). The proactive-chat plugin, however, snapshots its own per-session
state (emotion, HOLD stubs, send timestamps) to `storage.dataDir`, so it
survives restarts. See
[`src/builtins/proactive-chat/README.md`](src/builtins/proactive-chat/README.md)
for the full plugin behavior, persistence semantics and configuration
reference.

## How send timing is computed

When does a proactive message actually go out? The gate is a single score:

```
score = intensity × timeFitness × silenceFactor × frequencyLimit
intensity      = (valence + arousal + 3 × socialNeed) / 5
timeFitness    = 07–09:1.0, 09–12:0.8, 12–18:0.7, 18–22:1.0, 22–23:30:0.5, else 0
silenceFactor  = <60min:0.3, 60–360min:0.5, >360min:0.9
frequencyLimit = max(0.1, 1 - sentThisHour / maxPerHour)
```

A send fires when `score >= sendThreshold` (default 0.6); all four factors
vary dynamically over time. The numbers below were measured by driving the
real `decide()` / `evolveEmotion()` code paths (not hand math), starting from
the state right after a user reply (`valence 0.7, arousal 1.0, socialNeed
0.1`).

**Mechanism 1 — the silence ladder dominates first sends.** `silenceFactor`
is a step function of silence duration (hardcoded constants, not config):
`< 1h` → 0.3, `1–6h` → 0.5, `> 6h` → 0.9. Because it multiplies the whole
score, hours 1–6 of silence are capped regardless of tuning:

| Window fitness | In-band peak (1–6h silence) | Peak at |
| --- | --- | --- |
| 1.0 (07–09, 18–22) | ≈ 0.40 | ~4h silence |
| 0.8 / 0.9 | ≈ 0.32–0.36 | — |
| 0.7 | ≈ 0.28 | — |

With the default threshold of 0.6, **a first send during hours 1–6 of silence
is impossible**. First sends land after the 6-hour ladder step: `score ≈
0.73–0.76` at ≥ 6h silence inside a fitness-1.0 window, and the first tick in
such a window after the 6h mark wins. Practical shape: chat ends at noon →
first outreach ≈ 6.25h later at the next 1.0-fitness window (18:15); chat
ends after 16:00 → the silence carries into the next morning window (07:00).

**Mechanism 2 — repeat sends are not ladder-reset.** The `silenceMs` axis is
*time since the session's last message of any role* — the plugin's own sends
do **not** reset it. After a first send the session is already in the 0.9
ladder band, so later sends are paced only by `cooldownMinutes` and
`frequencyLimit` (`1 − sentThisHour / maxPerHour`): roughly one per hour with
defaults, or every ~20–40 minutes with `cooldown 20 + maxPerHour 4` inside a
1.0-fitness window until the hourly cap zeroes `frequencyLimit` (it resumes
next hour).

**Mechanism 3 — user replies reset the emotional clock.** A user message
bumps arousal and drops `socialNeed` to its reset value (0.1), so the score
collapses to near zero right after a conversation and rebuilds over hours —
proactive outreach never fires while a conversation is "warm" (the
`noSendAfterActivityMinutes` guardrail enforces this too).

**Tuning guide.** For *first* sends, `sendThreshold` and the emotion knobs
matter little (the ladder dominates). The levers that actually move timing:

1. **`decision.timeWindows`** — which hours have a high enough fitness. First
   sends land at the first high-fitness window after the 6h ladder step.
2. **`emotion.socialNeedGrowthPerHour`** — the only knob that lifts the
   in-band peak (1–6h silence): 0.2 → 0.4 raises the peak from ≈ 0.40 to
   ≈ 0.45, which together with a lower `sendThreshold` (e.g. 0.45) makes
   2–6h-silence first sends possible for the first time.
3. **`decision.maxPerHour` / `cooldownMinutes`** — repeat-send density after
   the first send.
4. **`decision.maxPerDay`** — the hard daily ceiling; a tight budget gets
   front-loaded into high-fitness windows and the plugin goes silent once
   exhausted.

For reference, one measured 48h trace (chat ends 09:00, no user replies,
tuned config `sendThreshold 0.45 / maxPerHour 4 / maxPerDay 16 / cooldown
20`): first send 15:05 (6.1h silence), 11 sends across the afternoon and
evening windows on day 1, then 5 more the next morning after quiet hours
lift — 16 total, vs 8 total under default parameters (first send 18:00, one
per hour through the evening window).
