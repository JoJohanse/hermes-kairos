# hermes-kairos

![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square) ![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square) ![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-orange?style=flat-square)

**English** | [中文](README_zh.md)

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
