# AGENTS.md

## Commands

- `npm test` — vitest, all colocated `src/**/*.test.ts`
- Single file: `npx vitest run src/builtins/proactive-chat/decision.test.ts`; single case: add `-t "name"`
- `npm run build` — `tsc` → `dist/`
- `npm run dev` — boot runtime via tsx; Ctrl+C triggers graceful SIGINT shutdown
- `npx tsc -p tsconfig.test.json` — **required after touching test files**: `tsconfig.json` excludes `src/**/*.test.ts`, so `npm run build` does NOT typecheck tests
- No lint/format tooling configured; don't add config implicitly

## Hard constraints

- **Zero runtime dependencies.** LLM access via global `fetch`; storage via injectable `node:fs`. Dev deps only (typescript, vitest, tsx, @types/node)
- Strict TS, ESM (`"type": "module"`) with NodeNext resolution — relative imports need `.js` extensions
- Node >= 20; no bun requirement

## Architecture (what filenames don't tell you)

- All behavior lives in plugins (`src/builtins/`); the kernel only provides services. A plugin receives `PluginContext` = `{eventBus, sessions, scheduler, llm, storage, config, send}`
- `ctx.send(sessionId, content)` is the only sanctioned way for a plugin to speak: it appends the agent message AND emits `message:outbound`. Hosts (the bridge) speak through `runtime.send` — the same module behind `ctx.send`. Never call `sessions.appendMessage` with role `'agent'` directly
- `SessionManager` emits `message:appended` for every appended role (when the runtime injected its bus); `PluginRegistry` is failure-isolated — a throwing `init()` is logged and skipped, later plugins still initialize; teardown runs in reverse order
- Scheduler tasks are `setInterval`-based, skip a tick while the previous run of the same task is in flight, and timers are `unref()`'d (don't keep the event loop alive)
- The bridge entry's lifecycle (delivery-mode mapping, config surgery, bind + stale-pid recovery, pidfile write, signal shutdown) lives behind `bootBridge` in `src/hermes-bridge/main.ts`; `main()` only maps boot failures onto the exit code. The proactive delivery transport is injected (`createDeliveryHandler`), never hardcoded
- The Bridge ↔ hermes-agent contract is `src/hermes-bridge/contract.json`, byte-identical to `hermes-plugin/kairos/tests/contract.json` (identity enforced by tests on both lanes — edit both together). The pidfile body is canonical JSON `{pid, nonce}`; both lanes' recovery readers also tolerate bare `<pid>` / `<pid> <nonce>`

## proactive-chat plugin (src/builtins/proactive-chat/ — full reference in its README.md)

- Two-stage gate per heartbeat: guardrail vetoes first (quiet hours = **server-local timezone**, wraps midnight; cooldown; hourly/daily caps; recent-activity) → deterministic score → only then the LLM. A vetoed tick must make **zero** LLM calls (pinned by tests)
- The per-session pipeline (vetoes → assessment → decision → hold/promote/deliver) lives in `heartbeat.ts` behind one `tick(session, now)` interface with injected deps — its ordering invariants (veto ⇒ zero LLM calls, HOLD stays LLM-free, one delivery per tick with mode-specific extras re-enqueue, re-read emotion after the assessment await) are pinned in `heartbeat.test.ts` without booting the runtime. `plugin.test.ts` stays untouched as the wiring-level oracle — keep it green
- HOLD band queues contentless stubs; the LLM generates content only on promotion. Never generate at enqueue time
- Emotion defaults are calibrated: long-run score ceiling 0.666 vs `sendThreshold` 0.6, pinned by a 48h default-threshold e2e test. Changing `DEFAULT_EMOTION_STATE`, the dynamics constants (single production copy: `emotion.ts`), or the intensity formula can silently kill the feature — keep that test green
- Plugin state persists to `<storage.dataDir>/proactive-chat.json` (default `.hermes-data/`, git-ignored): snapshots prune to live sessions, corrupt files → warn + fresh start, `persistence.enabled: false` opts out. Kernel sessions/messages are in-memory only
- The one-day send window is owned by `SendLog` (`sends.ts`): every read prunes in place, so guardrail counts, the snapshot, and `sendTimestamps()` never re-filter raw stamps
- `DelayedQueue.rescore` takes the session's single current decision score — a held stub belongs to a session, so a tick scores all of a session's stubs alike
- Re-init must be idempotent: clear stale counters and unsubscribe before re-subscribing

## Config

- Env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`; optional root `hermes.config.json` deep-merges over defaults
- Ownership: kernel `loadConfig` resolves llm/storage/hermesBridge but passes `plugins.proactiveChat` through as **raw user data** — the plugin owns its slice: defaults + one resolution pass live in `src/builtins/proactive-chat/config.ts` and run at plugin init. `src/config/` must not import from `src/builtins/`; shared field/warning helpers live in `src/config/fields.ts`
- Invalid fields never throw — they warn via injectable `onWarn` (default `[config]` console.warn) and fall back to defaults. New config fields must get the same instrumentation, and the owning resolver's test file must assert both "warning fires on bad input" and "zero warnings on valid config" (kernel resolvers: `src/config/config.test.ts`; plugin resolver: `src/builtins/proactive-chat/config.test.ts`)
- Deprecated fields (`checkIntervalMs`, `idleThresholdMs`, `maxInitiationsPerHour`) still map to their replacements when the replacements are absent — since the resolver sees only user data, a file-set deprecated field is honored (not masked by injected defaults)

## Testing conventions

- Determinism via injectable `now()` clocks and fake timers — use `vi.advanceTimersByTimeAsync` (the sync variant doesn't flush microtasks and will produce phantom failures)
- No network: `MockProvider` (src/llm/mock.ts) for LLM, injectable `fetchImpl`, MemoryFs-style stubs for `JsonStore`
- Pure modules (decision/emotion/queue math) take all state via parameters — keep clock/IO at the edges (index.ts, runtime)
