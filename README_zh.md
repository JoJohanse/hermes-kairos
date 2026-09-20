# hermes-kairos

[English](README.md) | **中文**

**KAIROS**（Autonomous Initiative and Response Orchestration System 内核）是一个小型、零依赖的 agent 运行时，用于构建能**主动发起**对话而不仅是被动应答的智能体。它提供自治 agent 所需的共享服务（类型化事件总线、内存态会话/消息存储、带重叠保护的间隔调度器、可插拔 LLM Provider、故障隔离的插件注册表），而把所有行为委托给插件。首个内置插件是**主动性对话**插件——决定 agent 何时应该主动开口。内核刻意保持精简：零运行时依赖、通过全局 `fetch` 访问 LLM，对持久化、传输、UI 不做任何假设——这些都可以由部署环境（或后续插件）按需叠加。

## 架构

```
hermes-kairos/
├── src/
│   ├── index.ts                     # 启动引导：loadConfig → runtime → plugins → start → SIGINT 优雅退出
│   ├── config/
│   │   └── config.ts                # loadConfig()：环境变量默认值 + 可选 hermes.config.json
│   ├── core/
│   │   ├── types.ts                 # Message, Session, MessageRole
│   │   ├── event-bus.ts             # 类型化发布/订阅（on/once/off/emit/clear）
│   │   ├── session-manager.ts       # 内存态会话 + 消息历史 + 空闲跟踪
│   │   ├── storage.ts               # JsonStore：原子写、可注入 fs 的 JSON 文件存储
│   │   └── runtime.ts               # HermesRuntime：装配 bus、sessions、scheduler、llm、plugins
│   ├── hermes-bridge/               # 供 hermes-agent 插件使用的 HTTP sidecar 入口
│   ├── llm/
│   │   ├── types.ts                 # LLMProvider / CompletionRequest / CompletionResult
│   │   ├── openai-compatible.ts     # 基于 fetch 的 OpenAI /chat/completions provider
│   │   └── mock.ts                  # 测试用确定性 provider
│   ├── plugins/
│   │   ├── types.ts                 # Plugin、PluginContext（含 send）
│   │   └── registry.ts              # PluginRegistry：故障隔离的 init/teardown
│   ├── scheduler/
│   │   └── scheduler.ts             # setInterval 任务，跳过重叠执行
│   └── builtins/
│       └── proactive-chat/
│           ├── index.ts             # ProactiveChatPlugin：心跳、计数器、事件
│           ├── decision.ts          # 守卫规则 + 评分 + 分档（纯函数）
│           ├── emotion.ts           # 时间驱动情绪 + 内存存储（纯数学）
│           ├── delayed-queue.ts     # 每会话 HOLD stub 队列（纯函数）
│           ├── context.ts           # 基于 SessionManager 的 ContextBundle 构建器
│           ├── thought-engine.ts    # prompt 构建 + SKIP 解析
│           ├── prompts.ts           # 默认 persona/指令字符串
│           ├── types.ts             # 共享类型（零依赖）
│           └── README.md            # 插件行为 + 落盘/序列化上下文文档
├── hermes-plugin/kairos/            # hermes-agent 原生插件（桥接 sidecar）
├── package.json
├── tsconfig.json
└── .gitignore
```

### 生命周期

1. `loadConfig()` 从环境变量（`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`）解析 LLM 配置，并合并仓库根目录可选的 `hermes.config.json`。
2. `new HermesRuntime({ config, llm })` 创建事件总线、会话管理器（接入总线以发布 `message:appended`）、调度器、`JsonStore` 与插件注册表。
3. `runtime.register(plugin)` 注册插件（引导脚本会注册内置的 proactive-chat 插件）。
4. `runtime.start()` 启动调度器，然后按顺序执行各插件的 `init(ctx)`；某个插件抛错会被记录并跳过，不影响其他插件。
5. `runtime.stop()` 按相反顺序卸载插件并停止调度器。

`PluginContext.send(sessionId, content)` 是插件发声的唯一合法通道：追加 `agent` 角色消息并向总线发布 `message:outbound`。任何角色经会话存储追加的消息都会发布 `message:appended`；插件还会拿到 `PluginContext.storage`（`JsonStore`），用于把 JSON 状态持久化到 `storage.dataDir`。

## 环境要求

- Node.js >= 20（开发环境为 v24）——不依赖 bun
- npm（Node 20+ 自带任意版本即可）

## 安装

```bash
npm install
```

## 运行

```bash
npm run dev      # tsx src/index.ts —— 启动运行时，输出 "hermes-kairos runtime started"
npm run build    # tsc → dist/   （运行：node dist/index.js）
```

按 `Ctrl+C` 停止；SIGINT/SIGTERM 处理器会优雅停机。

## 测试

```bash
npm test         # vitest run（测试与源码同目录，*.test.ts）
```

## 在 hermes-agent 中安装本插件（安装引导）

本仓库自带一个 [hermes-agent](https://github.com/NousResearch/hermes-agent) 原生插件（`hermes-plugin/kairos/`），把 proactive-chat 的主动性对话能力以 hermes 插件形式接入：插件自动拉起并监管 kairos sidecar（`src/hermes-bridge/`），把 hermes 的会话活动喂给 KAIROS 门控，在合适时机通过 `ctx.inject_message()` 主动发起对话。

> English guide: [README.md](README.md#install-as-a-hermes-agent-plugin)。

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

## 配置

环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API 根地址 |
| `LLM_API_KEY` | *（空）* | Bearer 令牌 |
| `LLM_MODEL` | `gpt-4o-mini` | 模型名 |

`storage.dataDir`（默认 `.hermes-data`）是插件持久化 JSON 状态的目录；首次写入时懒创建，已被 git 忽略。

仓库根目录可选的 `hermes.config.json` 可覆盖以上任意默认值以及插件默认值，例如：

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

会话/消息保留在内核内存中（持久化属于部署层面的事）。但 proactive-chat 插件会把自身的会话状态（情绪、HOLD stub、发送时间戳）快照到 `storage.dataDir`，重启后自动恢复。完整的插件行为、持久化语义与配置参考见
[`src/builtins/proactive-chat/README.md`](src/builtins/proactive-chat/README.md)。
