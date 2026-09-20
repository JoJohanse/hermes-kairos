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
│   │   ├── storage.ts               # JsonStore: atomic, injectable-fs JSON file store
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
│           ├── index.ts             # ProactiveChatPlugin: heartbeat, counters, events
│           ├── decision.ts          # guardrails + score + banding (pure)
│           ├── emotion.ts           # time-driven emotion + in-memory store (pure maths)
│           ├── delayed-queue.ts     # per-session HOLD stub queue (pure)
│           ├── context.ts           # ContextBundle builder from SessionManager
│           ├── thought-engine.ts    # prompt construction + SKIP parsing
│           ├── prompts.ts           # default persona/instruction strings
│           ├── types.ts             # shared shapes (dependency-free)
│           └── README.md            # plugin behavior + on-disk/serialized context docs
├── package.json
├── tsconfig.json
└── .gitignore
```

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
