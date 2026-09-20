# kairos — hermes native plugin

Bridges [hermes-agent](https://github.com/) to the **KAIROS** proactive-chat sidecar.
The sidecar decides *when* the agent should reach out first; this plugin feeds it
conversation activity and delivers its decisions back into hermes.

- Native hermes directory-plugin: `plugin.yaml` + `__init__.py` exposing `register(ctx)`.
- **Stdlib only** (`urllib`, `http.server`, `subprocess`, `threading`, `json`). No pip deps.
- **Fail-open**: every hook / network / subprocess error is logged and swallowed — the
  plugin can never break the host.

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
        token: ""                  # optional shared bearer token (sidecar <-> plugin)
        deliveryMode: turn         # "turn" | "verbatim"
        hermesSendTarget: ""       # required for verbatim mode, e.g. "telegram:me"
        startTimeoutSec: 15        # health-poll budget for sidecar startup
```

Env override: `KAIROS_DIST=/abs/path/to/main.js` forces the sidecar entrypoint.

### Delivery modes

| Mode       | Sidecar callback          | Plugin action                                             | When to use |
|------------|---------------------------|-----------------------------------------------------------|-------------|
| `turn`     | `{kind:"inject", directive, sessionId, score}` | `ctx.inject_message(directive, role="user", session_key=sessionId)` — the agent re-enters the conversation and writes its own reply | Agent should *think* before speaking (default). CLI always works; gateway needs `allow_gateway_injection: true`. |
| `verbatim` | `{kind:"send", content, sessionId, score}` | `hermes send --to <hermesSendTarget> <content>` — deliver the exact text | Fire-and-forget outbound where the sidecar already produced the final message. Requires `hermesSendTarget`. |

## How it works

```
 hermes session
   │
   │  hooks (fail-open, signature-inspected)
   │    on_session_start ─────────────────────────────┐  (no message text → skipped)
   │    pre_llm_call      ── last user text ──┐        │
   │    on_session_end    ── agent activity ──┤        │
   │                                          ▼        ▼
   │                             POST /events {type, sessionId, content, ts}
   │                                          │
   │                                          ▼
   │                                   KAIROS  sidecar  (127.0.0.1:8671)
   │                                   guardrail → score → emotion gate
   │                                          │
   │                                          │  POST <callbackUrl> = 127.0.0.1:8672/speak
   │                                          ▼
   │                             CallbackServer.dispatch()
   │                                    │
   │                    turn mode: ctx.inject_message(directive, "user", session_key)
   │                    verbatim:  hermes send --to <target> <content>
   │                                    │
   └────────────────────────────────────┘  (new turn / outbound message)
```

The default sidecar command is launched by the plugin:

```
node <plugin_dir>/../../dist/hermes-bridge/main.js \
  --port 8671 --token <token> \
  --callback-url http://127.0.0.1:8672/speak \
  --delivery-mode turn|verbatim
```

## Verification

1. **Plugin loads** — `hermes plugins list` shows `kairos`; `hermes plugins doctor ~/.hermes/plugins/kairos`
   validates discovery + registration.
2. **Sidecar is up** — the plugin polls `GET http://127.0.0.1:8671/health`; watch the hermes
   log for `[kairos] sidecar is healthy` (or a "did not report healthy" warning).
3. **Make the gate fire quickly** — set a low `persistence.saveIntervalTicks` in the kairos
   config so the engine evaluates often.
4. **Force an evaluation**:

   ```bash
   curl -X POST http://127.0.0.1:8671/trigger -H "Authorization: Bearer <token>"
   ```

   In `turn` mode expect `[kairos] inject_message -> True` in the log and the agent to
   re-enter the conversation. In `verbatim` mode expect `[kairos] verbatim send -> True`
   and the message to arrive on the configured target.
5. **Unit tests** (no hermes, no network):

   ```bash
   python -m pytest hermes-plugin/kairos/tests/ -q
   ```

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `sidecar did not report healthy within Ns` | Node missing, `dist/hermes-bridge/main.js` not built, or wrong path. Run `npm run build`; set `KAIROS_DIST` / `sidecarCommand`. Probe `curl http://127.0.0.1:8671/health`. |
| `inject_message -> False` | Gateway (non-CLI) injection needs `plugins.entries.kairos.allow_gateway_injection: true` in `~/.hermes/config.yaml`. CLI sessions are always allowed. The log line prints the exact hint. |
| `could not start callback listener on port 8672` | Port in use. Change `callbackPort` (and ensure the sidecar's `--callback-url` matches — it is derived from this value). |
| Sidecar port conflict on `8671` | Another sidecar/instance is running. Change `port`; the plugin will only listen, the sidecar must be started on the same value. |
| `verbatim delivery requested but hermesSendTarget is not configured` | Set `hermesSendTarget` (e.g. `telegram:me`); list targets with `hermes send --list`. |
| No events reach the sidecar | Check the `[kairos] event forward failed` logs. Events are 2s-timeout best-effort and intentionally dropped rather than blocking a hook. |
| Injection weirdness after config change | Unload/reload plugins (`hermes plugins disable kairos && hermes plugins enable kairos`); `on_unload` terminates the sidecar (SIGTERM, then SIGKILL after 5s) and shuts the listener down. |

## Layout

```
kairos/
  plugin.yaml          # manifest (name/version/description/hooks)
  __init__.py          # thin: re-exports register(ctx)
  bridge.py            # all logic (stdlib-only): settings, sidecar, callback, hooks
  tests/
    test_kairos_plugin.py
  README.md
```
