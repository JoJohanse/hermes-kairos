# kairos — hermes native plugin

Bridges [hermes-agent](https://github.com/) to the **KAIROS** proactive-chat sidecar.
The sidecar decides *when* the agent should reach out first; this plugin feeds it
conversation activity and delivers its decisions back into hermes.

- Native hermes directory-plugin: `plugin.yaml` + `__init__.py` exposing `register(ctx)`.
- **Stdlib only** (`urllib`, `http.server`, `subprocess`, `threading`, `json`). No pip deps.
- **Fail-open**: every hook / network / subprocess error is logged and swallowed — the
  plugin can never break the host.
- **The plugin launches and owns the sidecar.** You do not hand-run it, and you do not
  pass any flags yourself — the plugin builds the argv from your settings.

---

## Prerequisites

- **Node >= 20** on `PATH` (runs the sidecar).
- The kairos repo built:

  ```bash
  cd /path/to/hermes-kairos
  npm install
  npm run build          # tsc -> dist/hermes-bridge/main.js
  # `npm run bridge` runs the same entrypoint in dev (tsx)
  ```

- hermes-agent (Python >= 3.11).

## Install

Copy the plugin directory into the user plugin dir (`~/.hermes/plugins/`):

```bash
cp -r hermes-plugin/kairos ~/.hermes/plugins/kairos
```

The plugin resolves the sidecar relative to its own location as
`<plugin_dir>/../../dist/hermes-bridge/main.js`. So either:

- **Copy from inside the repo** (recommended): `~/.hermes/plugins/kairos/../../dist/...`
  must point at the built `dist/`. If you copy the plugin elsewhere, set `KAIROS_DIST`
  (env) or `sidecarCommand` (config) to the absolute `main.js` path.
- **Clone + copy**:

  ```bash
  git clone <kairos-repo> ~/kairos
  cd ~/kairos && npm install && npm run build
  cp -r ~/kairos/hermes-plugin/kairos ~/.hermes/plugins/kairos
  # then point the plugin at the build:
  export KAIROS_DIST="$HOME/kairos/dist/hermes-bridge/main.js"
  ```

Then enable it:

```bash
hermes plugins enable kairos
hermes plugins list        # confirm kairos is loaded/enabled
```

## Configuration

Settings live at `plugins.entries.kairos.settings` in `~/.hermes/config.yaml`:

```yaml
plugins:
  entries:
    kairos:
      # Required for gateway (non-CLI) injection. CLI sessions are always allowed.
      allow_gateway_injection: true
      settings:
        # Default: ["node", "<plugin_dir>/../../dist/hermes-bridge/main.js"]
        # sidecarCommand: ["node", "/home/me/kairos/dist/hermes-bridge/main.js"]
        port: 8671                 # sidecar HTTP port
        callbackPort: 8672         # this plugin's /speak listener port
        # token: "none"            # omit entirely -> an ephemeral token is generated per register()
        # token: "shared-secret"   # explicit shared bearer token (sidecar <-> plugin)
        deliveryMode: turn         # "turn" | "verbatim"
        hermesSendTarget: ""       # required for verbatim mode, e.g. "telegram:me"
        dataDir: ""                # default ~/.hermes/kairos-data (or <HERMES_HOME>/kairos-data)
        startTimeoutSec: 15        # health-poll budget for sidecar startup
```

### Authentication (default ON, generated)

If `token` is **absent or empty**, the plugin generates a fresh
`secrets.token_urlsafe(24)` on every `register()` and uses it for BOTH the sidecar
`--token` and this plugin's `/speak` check. The log notes that a generated token is
in use. All routes except `GET /health` then require
`authorization: Bearer <token>`; both sides treat an empty token as "auth off".

To deliberately run **auth-off**, set `token: "none"` (the literal string). An explicit
non-empty token is used verbatim.

### dataDir

The plugin computes a stable data directory and passes it to the sidecar as
`--data-dir`, then sets the subprocess cwd to it and propagates `HERMES_HOME`:

- `settings.dataDir` if set (absolute, `~` expanded);
- else `<HERMES_HOME>/kairos-data` when `HERMES_HOME` is set;
- else `~/.hermes/kairos-data`.

The sidecar writes its `.hermes-data` state there and a pidfile at
`<dataDir>/sidecar.pid` (used to reap an orphaned previous run).

### Env override

`KAIROS_DIST=/abs/path/to/main.js` forces the sidecar entrypoint.

## How the sidecar is launched

You never run the sidecar by hand; the plugin spawns it with this argv (contract):

```
node <plugin_dir>/../../dist/hermes-bridge/main.js \
  --port 8671 \
  --token <token|generated> \
  --callback-url http://127.0.0.1:8672/speak \
  --delivery-mode turn|verbatim \
  --data-dir <dataDir> \
  --nonce <per-boot nonce>
```

- `--host` is supported by the sidecar but not sent (the sidecar default `127.0.0.1` is used).
- `--nonce` pins the health handshake to THIS boot: the plugin requires
  `GET /health` to answer `{"ok": true, "nonce": <expected>}`. A mismatch (stale
  sidecar on the port) counts as unhealthy.
- On Windows the child is spawned with `CREATE_NEW_PROCESS_GROUP`; shutdown asks it to
  exit with `CTRL_BREAK_EVENT`, then TerminateProcess after 5 s. On POSIX: SIGTERM →
  SIGKILL after 5 s.
- If the initial health probe fails while `<dataDir>/sidecar.pid` names a live pid, the
  plugin kills that orphan tree (`taskkill /PID <pid> /T /F` on Windows; TERM→KILL on
  POSIX), waits 1 s, and retries health once (EADDRINUSE recovery).

## Delivery modes and routing

| Mode       | Sidecar callback          | Plugin action                                             | When to use |
|------------|---------------------------|-----------------------------------------------------------|-------------|
| `turn`     | `{kind:"inject", directive, sessionId, score}` | `ctx.inject_message(directive, role="user", session_key=<mapped>)` — the agent re-enters the conversation and writes its own reply | Agent should *think* before speaking (default). |
| `verbatim` | `{kind:"send", content, sessionId, score}` | `hermes send --to <hermesSendTarget> <content>` — deliver the exact text | Fire-and-forget outbound where the sidecar already produced the final message. Requires `hermesSendTarget`. |

### Routing truth (session_id vs session_key)

hermes exposes **two different** identifiers:

- **`session_id`** — the internal agent/transcript id. Every lifecycle hook
  (`pre_llm_call`, `on_session_end`) exposes only this, so it is the id the plugin
  forwards to the sidecar as `sessionId`.
- **`session_key`** — the gateway routing key (`agent:<profile>:<platform>:...`).
  `inject_message(session_key=...)` routes through `SessionStore.lookup_by_session_key`,
  a *different* key space.

So that gateway delivery can work, the plugin also registers the
`pre_gateway_dispatch` hook. On every inbound message it derives the real
`session_key` (from `gateway._session_key_for_source(event.source)`, fallback
`session_store._generate_session_key`) and the internal `session_id` (from
`session_store.lookup_by_session_key(...)`, fallbacks `peek_session_id`, the live
agent's `session_id`, and event metadata), and records `{session_id: session_key}`.

What this means in practice:

- **CLI delivery works out of the box.** With no mapping, `inject_message` is called
  without `session_key` and lands in the CLI queue.
- **Gateway delivery requires the mapping to have observed the session** — i.e. an
  inbound message on that platform first. `pre_gateway_dispatch` runs *before* the
  session row is created, so a brand-new conversation's first message cannot be mapped
  yet; the mapping is recorded on its next inbound message. Until then, callbacks for
  that id fall back to CLI-style injection and log a one-time hint:
  `no session_key observed for <id>; gateway delivery needs an inbound message first`.
- A mapped id calls `inject_message(..., session_key=<real key>)`. `True` means the
  gateway **accepted** the injection for async dispatch, not that delivery completed.
  A never-seen session logs `Plugin message injection was not routed` — expected.
- A user-visible gateway delivery therefore requires: a configured platform session,
  `allow_gateway_injection: true`, and a working LLM key for the follow-up turn.

## Verification

1. **Plugin loads** — `hermes plugins list` shows `kairos`; `hermes plugins doctor ~/.hermes/plugins/kairos`
   validates discovery + registration.
2. **Sidecar is up** — the plugin polls `GET http://127.0.0.1:8671/health` and checks
   the per-boot nonce; watch the hermes log for `[kairos] sidecar is healthy` (or a
   "did not report healthy" warning).
3. **Make the gate fire quickly** — set a low `persistence.saveIntervalTicks` in the kairos
   config so the engine evaluates often.
4. **Unit tests** (no hermes, no network):

   ```bash
   python -m pytest hermes-plugin/kairos/tests/ -q
   ```

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `sidecar did not report healthy within Ns` | Node missing, `dist/hermes-bridge/main.js` not built, or wrong path. Run `npm run build`; set `KAIROS_DIST` / `sidecarCommand`. Probe `curl http://127.0.0.1:8671/health`. |
| Health never passes after a crash | Stale sidecar on the port: its `nonce` no longer matches. The plugin kills the pid in `<dataDir>/sidecar.pid` and retries once; otherwise kill it manually (`taskkill /PID <pid> /T /F`). |
| `could not start callback listener on port 8672` | Port in use. Change `callbackPort` (the sidecar `--callback-url` is derived from it). |
| Sidecar port conflict on `8671` (EADDRINUSE) | An orphaned sidecar is holding the port. Check `<dataDir>/sidecar.pid`; the plugin's orphan-kill path handles a live pid, otherwise kill it manually and restart the plugin. |
| `inject_message -> False` + unmapped hint | Gateway (non-CLI) injection needs `plugins.entries.kairos.allow_gateway_injection: true` **and** a mapped session (an inbound message on that platform first). CLI sessions always work. |
| `415 unsupported media type` in logs | A caller POSTed to `/speak` with a non-`application/json` content-type. Send `Content-Type: application/json`. |
| `413 payload too large` in logs | A `/speak` (or `/events`) body exceeded 1 MiB. Keep payloads small. |
| `401 unauthorized` in logs | Token mismatch. Both sides must use the same token; if you left `token` unset, read the generated token from the startup log, or set an explicit token. |
| `verbatim delivery requested but hermesSendTarget is not configured` | Set `hermesSendTarget` (e.g. `telegram:me`); list targets with `hermes send --list`. |
| `hermes send failed: ... WinError 193` | On Windows the resolver prefers `hermes.exe` over the npm `hermes.cmd` shim, which CreateProcess cannot launch directly. Install/keep a real `hermes.exe` on `PATH` (or wrap the `.cmd` via `cmd /c` in a custom setup). |
| No events reach the sidecar | Check the `[kairos] event forward failed` logs. Forwards are 0.5 s-timeout best-effort; after 5 consecutive failures they pause for 60 s, then retry. |
| Injection weirdness after config change | Unload/reload plugins (`hermes plugins disable kairos && hermes plugins enable kairos`); `on_unload` stops the sidecar and the listener. |

## Layout

```
kairos/
  plugin.yaml          # manifest (name/version/description/hooks)
  __init__.py          # thin: re-exports register(ctx)
  bridge.py            # all logic (stdlib-only): settings, sidecar, callback, hooks
  tests/
    test_kairos_plugin.py
    test_contract.py
    contract.json      # golden cross-process contract (mirrored by the sidecar)
  README.md
```
