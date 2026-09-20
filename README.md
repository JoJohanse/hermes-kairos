# hermes-kairos

**KAIROS** — the Kernel for Autonomous Initiative and Response Orchestration System — is a small, dependency-free agent runtime for building agents that can *start* conversations rather than only answer them; it provides the shared services an autonomous agent needs (a typed event bus, in-memory session/message storage, an interval scheduler with overlap protection, a pluggable LLM provider, and a failure-isolated plugin registry) while delegating all behavior to plugins, the first of which is a **proactive-conversation** plugin that decides when the agent should speak up on its own. The kernel is intentionally lean: zero runtime dependencies, LLM access through the global `fetch`, and no opinion about persistence, transport, or UI — those are additions a deployment (or a later plugin) can layer on.

## Architecture

```
hermes-kairos/
├── src/
│   ├── index.ts                     # bootstrap: loadConfig → runtime → plugins → start → SIGINT shutdown
│   ├── config/
│   │   └── config.ts                # loadConfig(): env defaults + optional hermes.config.json
│   ├── core/
│   │   ├── types.ts                 # Message, Session, MessageRole
│   │   ├── event-bus.ts             # typed pub/sub (on/once/off/emit/clear)
│   │   ├── session-manager.ts       # in-memory sessions + message history + idle tracking
│   │   └── runtime.ts               # HermesRuntime: wires bus, sessions, scheduler, llm, plugins
│   ├── llm/
│   │   ├── types.ts                 # LLMProvider / CompletionRequest / CompletionResult
│   │   ├── openai-compatible.ts     # fetch-based OpenAI /chat/completions provider
│   │   └── mock.ts                  # deterministic provider for tests
│   ├── plugins/
│   │   ├── types.ts                 # Plugin, PluginContext (incl. send)
│   │   └── registry.ts              # PluginRegistry: failure-isolated init/teardown
│   ├── scheduler/
│   │   └── scheduler.ts             # setInterval tasks, skips overlapping runs
│   └── builtins/
│       └── proactive-chat/
│           ├── index.ts             # placeholder plugin (lifecycle only, TODO internals)
│           └── README.md            # open design questions for the plugin
├── package.json
├── tsconfig.json
└── .gitignore
```

### Lifecycle

1. `loadConfig()` resolves LLM settings from env (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) and merges an optional `hermes.config.json` at the repo root.
2. `new HermesRuntime({ config, llm })` creates the event bus, session manager, scheduler and plugin registry.
3. `runtime.register(plugin)` adds plugins (built-in placeholders included).
4. `runtime.start()` starts the scheduler, then runs `init(ctx)` for each plugin in order; a throwing plugin is logged and skipped without blocking the rest.
5. `runtime.stop()` tears plugins down in reverse order and stops the scheduler.

`PluginContext.send(sessionId, content)` is the only sanctioned way for a plugin to speak: it appends an `agent`-role message and emits `message:outbound` on the bus.

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

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API root |
| `LLM_API_KEY` | *(empty)* | Bearer token |
| `LLM_MODEL` | `gpt-4o-mini` | Model id |

Optional `hermes.config.json` at the repo root overrides any of the above and the
plugin defaults, e.g.:

```json
{
  "llm": { "model": "gpt-4.1-mini" },
  "plugins": { "proactiveChat": { "enabled": true, "idleThresholdMs": 300000 } }
}
```
