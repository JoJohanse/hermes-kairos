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

## 在 hermes-agent 中安装本插件（安装引导）

本仓库自带一个 [hermes-agent](https://github.com/NousResearch/hermes-agent) 原生插件（`hermes-plugin/kairos/`），把 proactive-chat 的主动性对话能力以 hermes 插件形式接入：插件自动拉起并监管 kairos sidecar（`src/hermes-bridge/`），把 hermes 的会话活动喂给 KAIROS 门控，在合适时机通过 `ctx.inject_message()` 主动发起对话。

### 前置要求

- hermes-agent（Python >= 3.11）已安装且 `hermes` 命令可用
- Node.js >= 20 + npm（sidecar 运行时）
- hermes 已配置可用的 LLM（`~/.hermes/config.yaml` 的 `model:` 段）

### 安装步骤

1. 构建本仓库（产出 `dist/hermes-bridge/main.js`）：

   ```bash
   npm install && npm run build
   ```

2. 拷贝插件目录到 hermes：

   ```bash
   # Linux / macOS
   cp -r hermes-plugin/kairos ~/.hermes/plugins/kairos
   # Windows (PowerShell)
   Copy-Item -Recurse hermes-plugin/kairos "$env:USERPROFILE\.hermes\plugins\kairos"
   ```

3. 告诉插件 sidecar 的位置 —— 设置环境变量（启动 hermes 前生效，推荐写进系统环境变量或 hermes 的 `.env`）：

   ```bash
   KAIROS_DIST="<本仓库绝对路径>/dist/hermes-bridge/main.js"
   ```

   > 插件拷贝到 `~/.hermes/plugins/` 后，默认的相对路径 `~/.hermes/dist/...` 并不存在，**这一步必须做**；也可以改为在 `plugins.entries.kairos.settings` 里配置 `sidecarCommand` 数组。

4. 在 `~/.hermes/config.yaml` 中启用并放行注入（gateway 模式必需）：

   ```yaml
   plugins:
     enabled:
       - kairos
     entries:
       kairos:
         allow_gateway_injection: true   # gateway 模式主动注入必需
         settings:
           deliveryMode: turn            # turn=hermes 组织语言; verbatim=kairos 生成内容经 hermes send 直投
           port: 8671
           callbackPort: 8672
           # token 留空 = 每次启动自动生成随机 token（推荐）
   ```

5. 验证安装：

   ```bash
   hermes plugins list            # kairos 应显示 enabled
   hermes plugins doctor kairos   # 应显示 registration passed、3 hook(s)
   ```

6. 启动 `hermes gateway`（或进入 CLI 会话），日志出现以下内容即安装成功：

   ```text
   [kairos] sidecar is healthy
   [kairos] kairos plugin ready
   ```

### 触发与验证

- 任意平台收到用户消息后，kairos hook 会把活动转发给 sidecar，心跳门控（默认 60s 一次）自动评估是否主动开口；`turn` 模式下通过 `ctx.inject_message()` 让 hermes 主动发起新话题
- 快速自测：与 hermes 对话一轮后，强制一次评估——

  ```bash
  curl -X POST http://127.0.0.1:8671/trigger -H "authorization: Bearer <token>"
  ```

- 日志确认：`[kairos] inject_message -> True` 表示主动消息已被 hermes 接受

### 注意事项

- `turn` 模式的主动消息只会路由到**已存在**的会话（该平台/渠道此前有过入站消息）；对从未聊过的全新会话会记录 `no session_key observed` 提示
- sidecar 默认只绑定 `127.0.0.1`；token 默认自动生成，显式设 `token: "none"` 才会关闭鉴权（不推荐）
- 插件自身状态（情绪 / HOLD 队列 / 冷却计数）持久化在 `storage.dataDir`（默认 `.hermes-data/`），重启自动恢复
- 完整参考（路由细节、verbatim 模式、故障排查表）：[`hermes-plugin/kairos/README.md`](hermes-plugin/kairos/README.md)

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
