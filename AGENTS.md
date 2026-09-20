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
- `ctx.send(sessionId, content)` is the only sanctioned way to speak: it appends the agent message AND emits `message:outbound`. Never append agent messages directly
- `SessionManager` emits `message:appended` for every appended role (when the runtime injected its bus); `PluginRegistry` is failure-isolated — a throwing `init()` is logged and skipped, later plugins still initialize; teardown runs in reverse order
- Scheduler tasks are `setInterval`-based, skip a tick while the previous run of the same task is in flight, and timers are `unref()`'d (don't keep the event loop alive)

## proactive-chat plugin (src/builtins/proactive-chat/ — full reference in its README.md)

- Two-stage gate per heartbeat: guardrail vetoes first (quiet hours = **server-local timezone**, wraps midnight; cooldown; hourly/daily caps; recent-activity) → deterministic score → only then the LLM. A vetoed tick must make **zero** LLM calls (pinned by tests)
- HOLD band queues contentless stubs; the LLM generates content only on promotion. Never generate at enqueue time
- Emotion defaults are calibrated: long-run score ceiling 0.666 vs `sendThreshold` 0.6, pinned by a 48h default-threshold e2e test. Changing `DEFAULT_EMOTION_STATE`, decay constants, or the intensity formula can silently kill the feature — keep that test green
- Plugin state persists to `<storage.dataDir>/proactive-chat.json` (default `.hermes-data/`, git-ignored): snapshots prune to live sessions, corrupt files → warn + fresh start, `persistence.enabled: false` opts out. Kernel sessions/messages are in-memory only
- Re-init must be idempotent: clear stale counters and unsubscribe before re-subscribing

## Config

- Env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`; optional root `hermes.config.json` deep-merges over defaults
- Invalid fields never throw — they warn via injectable `onWarn` (default `[config]` console.warn) and fall back to defaults. New config fields must get the same instrumentation, and `config.test.ts` must assert both "warning fires on bad input" and "zero warnings on valid config"
- Deprecated fields (`checkIntervalMs`, `idleThresholdMs`, `maxInitiationsPerHour`) still map to their replacements when the replacements are absent

## Testing conventions

- Determinism via injectable `now()` clocks and fake timers — use `vi.advanceTimersByTimeAsync` (the sync variant doesn't flush microtasks and will produce phantom failures)
- No network: `MockProvider` (src/llm/mock.ts) for LLM, injectable `fetchImpl`, MemoryFs-style stubs for `JsonStore`
- Pure modules (decision/emotion/queue math) take all state via parameters — keep clock/IO at the edges (index.ts, runtime)
