"""All KAIROS bridge logic for the ``kairos`` hermes plugin.

This module is intentionally free of hermes imports so it is importable — and
unit-testable — without hermes on ``sys.path``. ``__init__.py`` stays thin and
just re-exports :func:`register`.

Layout expected in production::

    <kairos repo>/
      dist/hermes-bridge/main.js        <- built by `npm run build`
      hermes-plugin/kairos/             <- this directory, copied to
        plugin.yaml                        ~/.hermes/plugins/kairos
        __init__.py
        bridge.py
        tests/

The default sidecar command is ``node <plugin_dir>/../../dist/hermes-bridge/main.js``
(override with the ``KAIROS_DIST`` env var or the ``sidecarCommand`` setting).

Runtime shape::

    hermes hooks --> HookForwarder --> POST /events --> kairos sidecar
                                                            |
                                    (proactive gate + emotion score)
                                                            |
                            POST <callback>/speak  <--------+
                                    |
                 turn mode:     ctx.inject_message(directive, role="user", session_key=...)
                 verbatim mode: hermes send --to <target> <content>

Every hook / network / subprocess failure is swallowed and logged: a plugin must
never break the host it is attached to.
"""

from __future__ import annotations

import hmac
import http.server
import json
import os
import shlex
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

__all__ = [
    "Settings",
    "load_settings",
    "default_dist_path",
    "SidecarProcess",
    "CallbackServer",
    "HookForwarder",
    "build_event",
    "extract_text",
    "extract_last_user_message",
    "forward_event",
    "make_forward",
    "make_inject_fn",
    "make_send_fn",
    "register",
    "DEFAULT_PORT",
    "DEFAULT_CALLBACK_PORT",
    "DEFAULT_START_TIMEOUT_SEC",
]

DEFAULT_PORT = 8671
DEFAULT_CALLBACK_PORT = 8672
DEFAULT_START_TIMEOUT_SEC = 15.0
DIST_RELPATH = ("..", "..", "dist", "hermes-bridge", "main.js")

LogFn = Callable[[str], None]
MappingLike = Dict[str, Any]


def _default_log(message: str) -> None:
    """Default logger: ``print`` with the ``[kairos]`` prefix, flushed immediately."""
    print(f"[kairos] {message}", flush=True)


def _resolve_log(log: Optional[LogFn]) -> LogFn:
    return log if log is not None else _default_log


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------


@dataclass
class Settings:
    """Resolved plugin settings (settings live at ``plugins.entries.kairos.settings``)."""

    sidecar_command: List[str]
    dist_path: str
    port: int = DEFAULT_PORT
    callback_port: int = DEFAULT_CALLBACK_PORT
    token: str = ""
    delivery_mode: str = "turn"
    hermes_send_target: str = ""
    start_timeout_sec: float = DEFAULT_START_TIMEOUT_SEC
    plugin_dir: str = ""
    # raw values as read from config, handy for diagnostics/tests
    raw: Dict[str, Any] = field(default_factory=dict)


def default_dist_path(plugin_dir: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> str:
    """Resolve the built ``main.js`` path.

    ``KAIROS_DIST`` (env) wins; otherwise ``<plugin_dir>/../../dist/hermes-bridge/main.js``
    resolved to an absolute path. The expected layout (kairos repo built, plugin dir
    copied to ``~/.hermes/plugins/kairos``) puts ``dist/`` two levels above the plugin.
    """
    environ = os.environ if env is None else env
    override = str(environ.get("KAIROS_DIST") or "").strip()
    if override:
        return os.path.abspath(override)
    base = Path(plugin_dir) if plugin_dir else Path(__file__).resolve().parent
    dist = base.resolve().joinpath(*DIST_RELPATH)
    return str(dist.resolve())


def _cfg(ctx: Any, key: str, default: Any) -> Any:
    """Read one plugin-relative setting, never raising (fail-open)."""
    if ctx is None:
        return default
    try:
        value = ctx.get_config(key, default)
    except Exception:
        return default
    return default if value is None else value


def _cfg_int(ctx: Any, key: str, default: int) -> int:
    try:
        return int(_cfg(ctx, key, default))
    except (TypeError, ValueError):
        return default


def _cfg_float(ctx: Any, key: str, default: float) -> float:
    try:
        return float(_cfg(ctx, key, default))
    except (TypeError, ValueError):
        return default


def load_settings(ctx: Any, *, plugin_dir: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> Settings:
    """Build :class:`Settings` from ``ctx.get_config`` with sane defaults.

    Never raises: a broken/missing ``get_config`` (or a plugin loaded outside hermes,
    as in the tests) falls back to defaults.
    """
    environ = os.environ if env is None else env
    pdir = str(Path(plugin_dir).resolve()) if plugin_dir else str(Path(__file__).resolve().parent)
    dist = default_dist_path(pdir, environ)

    raw_command = _cfg(ctx, "sidecarCommand", None)
    if isinstance(raw_command, str) and raw_command.strip():
        command = shlex.split(raw_command, posix=(os.name != "nt"))
    elif isinstance(raw_command, (list, tuple)) and raw_command:
        command = [str(part) for part in raw_command]
    else:
        command = ["node", dist]

    delivery_mode = str(_cfg(ctx, "deliveryMode", "turn") or "turn").strip().lower() or "turn"
    if delivery_mode not in ("turn", "verbatim"):
        delivery_mode = "turn"

    return Settings(
        sidecar_command=command,
        dist_path=dist,
        port=_cfg_int(ctx, "port", DEFAULT_PORT),
        callback_port=_cfg_int(ctx, "callbackPort", DEFAULT_CALLBACK_PORT),
        token=str(_cfg(ctx, "token", "") or ""),
        delivery_mode=delivery_mode,
        hermes_send_target=str(_cfg(ctx, "hermesSendTarget", "") or ""),
        start_timeout_sec=_cfg_float(ctx, "startTimeoutSec", DEFAULT_START_TIMEOUT_SEC),
        plugin_dir=pdir,
        raw={
            "sidecarCommand": raw_command,
            "port": _cfg(ctx, "port", DEFAULT_PORT),
            "callbackPort": _cfg(ctx, "callbackPort", DEFAULT_CALLBACK_PORT),
            "token": _cfg(ctx, "token", ""),
            "deliveryMode": _cfg(ctx, "deliveryMode", "turn"),
            "hermesSendTarget": _cfg(ctx, "hermesSendTarget", ""),
            "startTimeoutSec": _cfg(ctx, "startTimeoutSec", DEFAULT_START_TIMEOUT_SEC),
        },
    )


# ---------------------------------------------------------------------------
# sidecar subprocess
# ---------------------------------------------------------------------------


class SidecarProcess:
    """Owns the ``node dist/hermes-bridge/main.js`` subprocess and its health."""

    def __init__(
        self,
        command: Sequence[str],
        port: int,
        token: str = "",
        *,
        log: Optional[LogFn] = None,
        popen_factory: Optional[Callable[..., Any]] = None,
        health_probe: Optional[Callable[[], bool]] = None,
        env: Optional[Dict[str, str]] = None,
        health_timeout: float = 1.0,
    ) -> None:
        self.command = [str(part) for part in (command or [])]
        self.port = int(port)
        self.token = token or ""
        self.log = _resolve_log(log)
        self._popen_factory = popen_factory or subprocess.Popen
        self._health_probe = health_probe
        self._env = env
        self._health_timeout = float(health_timeout)
        self._proc: Any = None
        self._threads: List[threading.Thread] = []

    # -- lifecycle -----------------------------------------------------------
    def start(self) -> bool:
        """Spawn the sidecar; return False (never raise) when it cannot be spawned."""
        if not self.command:
            self.log("no sidecar command configured; not spawning")
            return False
        try:
            self._proc = self._popen_factory(
                self.command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=self._env,
            )
        except Exception as exc:  # FileNotFoundError, OSError, ...
            self.log(f"failed to spawn sidecar ({' '.join(self.command)!r}): {exc}")
            self._proc = None
            return False
        for stream, name in (
            (getattr(self._proc, "stdout", None), "stdout"),
            (getattr(self._proc, "stderr", None), "stderr"),
        ):
            if stream is None:
                continue
            thread = threading.Thread(target=self._pump, args=(stream, name), name=f"kairos-sidecar-{name}", daemon=True)
            thread.start()
            self._threads.append(thread)
        self.log(f"sidecar started pid={getattr(self._proc, 'pid', '?')} port={self.port}")
        return True

    def _pump(self, stream: Any, name: str) -> None:
        """Drain one subprocess stream line-by-line onto the plugin log."""
        try:
            for line in iter(stream.readline, ""):
                line = str(line).rstrip("\r\n")
                if line:
                    self.log(f"sidecar {name}: {line}")
        except Exception as exc:
            self.log(f"sidecar {name} reader stopped: {exc}")
        finally:
            try:
                stream.close()
            except Exception:
                pass

    def stop(self, grace: float = 5.0) -> None:
        """Terminate, then SIGKILL after ``grace`` seconds; join reader threads."""
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=grace)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
            except Exception as exc:
                self.log(f"sidecar stop error: {exc}")
        for thread in self._threads:
            try:
                thread.join(timeout=1.0)
            except Exception:
                pass
        self._threads = []
        self.log("sidecar stopped")

    # -- health --------------------------------------------------------------
    @property
    def proc(self) -> Any:
        return self._proc

    def health_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/health"

    def is_healthy(self) -> bool:
        """GET /health → True on 2xx. Any failure is False, never an exception."""
        if self._health_probe is not None:
            try:
                return bool(self._health_probe())
            except Exception:
                return False
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        request = urllib.request.Request(self.health_url(), headers=headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=self._health_timeout) as response:
                return 200 <= int(getattr(response, "status", 200)) < 300
        except Exception:
            return False

    def wait_for_health(self, timeout: float, interval: float = 0.25) -> bool:
        """Poll :meth:`is_healthy` until success or ``timeout`` seconds elapse."""
        timeout = float(timeout)
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            if self.is_healthy():
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(interval, remaining))


# ---------------------------------------------------------------------------
# callback listener (/speak)
# ---------------------------------------------------------------------------


class CallbackServer:
    """Minimal HTTP listener the sidecar calls back into.

    ``POST /speak`` with ``{"kind": "inject"|"send", ...}``. Bearer-token gated when
    a token is configured. Handler delegates to :meth:`dispatch`, which is pure enough
    to unit-test without a socket.
    """

    def __init__(
        self,
        *,
        port: int,
        on_inject: Callable[[str, Optional[str]], bool],
        on_send: Callable[[str, Optional[str]], bool],
        token: str = "",
        log: Optional[LogFn] = None,
        plugin_id: str = "kairos",
        host: str = "127.0.0.1",
        server_factory: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.port = int(port)
        self.host = host
        self.token = token or ""
        self.on_inject = on_inject
        self.on_send = on_send
        self.log = _resolve_log(log)
        self.plugin_id = plugin_id or "kairos"
        self._server_factory = server_factory or http.server.HTTPServer
        self._server: Any = None
        self._thread: Optional[threading.Thread] = None

    @property
    def running(self) -> bool:
        return self._server is not None

    def start(self) -> "CallbackServer":
        handler = _build_handler(self)
        self._server = self._server_factory((self.host, self.port), handler)
        if self.port == 0:  # ephemeral bind: expose the real port
            self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="kairos-callback", daemon=True
        )
        self._thread.start()
        self.log(f"callback listener on http://{self.host}:{self.port}/speak")
        return self

    def stop(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            try:
                server.shutdown()
            except Exception:
                pass
            try:
                server.server_close()
            except Exception:
                pass
        thread, self._thread = self._thread, None
        if thread is not None:
            try:
                thread.join(timeout=5.0)
            except Exception:
                pass
        self.log("callback listener stopped")

    # -- request handling ----------------------------------------------------
    def _authorized(self, headers: Any) -> bool:
        if not self.token:
            return True
        raw = str(headers.get("Authorization") or "")
        parts = raw.split(None, 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False
        return hmac.compare_digest(parts[1].strip(), self.token)

    def dispatch(self, path: str, headers: Any, body: bytes) -> "tuple[int, Dict[str, Any]]":
        """Route one request; returns ``(status, json_payload)``. Never raises."""
        if path != "/speak":
            return 404, {"ok": False, "error": "not found"}
        if not self._authorized(headers):
            self.log("callback rejected: unauthorized (bad/missing bearer token)")
            return 401, {"ok": False, "error": "unauthorized"}
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except Exception as exc:
            self.log(f"callback bad JSON: {exc}")
            return 400, {"ok": False, "error": "invalid json"}
        if not isinstance(data, dict):
            return 400, {"ok": False, "error": "invalid payload"}

        kind = str(data.get("kind") or "").strip().lower()
        session_id = _coerce_session(str(data.get("sessionId") or data.get("session_key") or ""))

        if kind == "inject":
            content = str(data.get("directive") or data.get("content") or "").strip()
            if not content:
                return 400, {"ok": False, "error": "missing directive"}
            try:
                injected = bool(self.on_inject(content, session_id))
            except Exception as exc:
                self.log(f"inject callback raised (ignored): {exc}")
                injected = False
            self.log(f"inject_message -> {injected} (session={session_id or '-'})")
            if not injected:
                self.log(
                    "HINT: injection returned False. In gateway mode set "
                    f"plugins.entries.{self.plugin_id}.allow_gateway_injection: true "
                    "in ~/.hermes/config.yaml (CLI sessions are always allowed)."
                )
            return 200, {"ok": True, "injected": injected}

        if kind == "send":
            content = str(data.get("content") or "")
            if not content.strip():
                return 400, {"ok": False, "error": "missing content"}
            try:
                sent = bool(self.on_send(content, session_id))
            except Exception as exc:
                self.log(f"send callback raised (ignored): {exc}")
                sent = False
            self.log(f"verbatim send -> {sent} (session={session_id or '-'})")
            return 200, {"ok": True, "sent": sent}

        self.log(f"callback unknown kind: {kind!r}")
        return 400, {"ok": False, "error": "unknown kind"}


def _build_handler(server: CallbackServer) -> type:
    """Build a ``BaseHTTPRequestHandler`` subclass bound to ``server``."""

    def _write(handler: Any, status: int, payload: Dict[str, Any]) -> None:
        data = json.dumps(payload).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        try:
            handler.wfile.write(data)
        except Exception:
            pass

    class _CallbackHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:  # noqa: N802 (stdlib naming)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            body = self.rfile.read(length) if length > 0 else b""
            path = urllib.parse.urlsplit(self.path).path
            try:
                status, payload = server.dispatch(path, self.headers, body)
            except Exception as exc:  # dispatch is defensive; never leak a 500 traceback
                server.log(f"callback dispatch error: {exc}")
                status, payload = 500, {"ok": False, "error": "internal"}
            _write(self, status, payload)

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.urlsplit(self.path).path
            status, payload = (200, {"ok": True}) if path == "/health" else (404, {"ok": False, "error": "not found"})
            _write(self, status, payload)

        def log_message(self, fmt: str, *args: Any) -> None:  # route to plugin log, not stderr
            server.log("callback http: " + (fmt % args))

    return _CallbackHandler


def _coerce_session(value: str) -> Optional[str]:
    value = (value or "").strip()
    return value or None


# ---------------------------------------------------------------------------
# event forwarding + hook mapping
# ---------------------------------------------------------------------------


def session_key_from(payload: MappingLike) -> str:
    """Best-effort session identifier from a hook payload (session_key wins)."""
    for key in ("session_key", "sessionId", "session_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def extract_text(value: Any) -> str:
    """Defensively pull plain text out of a hook field.

    Handles ``str``, ``{"content"|"text"|"message": ...}``, and lists of parts
    (preferring the last user-role mapping, else joined string parts).
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("content", "text", "message"):
            if key in value:
                text = extract_text(value[key])
                if text:
                    return text
        return ""
    if isinstance(value, (list, tuple)):
        for item in reversed(value):
            if isinstance(item, dict) and str(item.get("role", "")).lower() == "user":
                text = extract_text(item.get("content") if item.get("content") is not None else item.get("text"))
                if text:
                    return text
        parts = [extract_text(item) for item in value]
        return "\n".join(part for part in parts if part).strip()
    return str(value).strip()


def extract_last_user_message(payload: MappingLike) -> str:
    """Return the last clear user text in a hook payload, else ``""``.

    ``pre_llm_call`` carries ``user_message`` (the current turn) and
    ``conversation_history`` (the full message list); prefer the former.
    """
    text = extract_text(payload.get("user_message"))
    if text:
        return text
    history = payload.get("conversation_history")
    if history is None:
        history = payload.get("messages")
    if isinstance(history, (list, tuple)):
        for item in reversed(history):
            if isinstance(item, dict):
                role = str(item.get("role", "")).lower()
                if role and role != "user":
                    continue
                text = extract_text(item.get("content") if item.get("content") is not None else item.get("text"))
                if text:
                    return text
            elif isinstance(item, str) and item.strip():
                return item.strip()
    return ""


def build_event(hook: str, payload: MappingLike, *, now: Optional[Callable[[], float]] = None) -> Optional[Dict[str, Any]]:
    """Map a hermes hook payload to a kairos ``/events`` body (or None to skip).

    Conservative by design: only emits ``user-message`` when a user text is
    clearly present, and ``agent-message`` (content-less activity marker) at
    ``on_session_end`` — which hermes fires once per completed turn.
    """
    if not isinstance(payload, dict):
        payload = {}
    session_id = session_key_from(payload)
    if not session_id:
        return None
    ts = (now or time.time)()
    if hook == "pre_llm_call":
        text = extract_last_user_message(payload)
        if not text:
            return None
        return {"type": "user-message", "sessionId": session_id, "content": text, "ts": ts}
    if hook == "on_session_end":
        return {"type": "agent-message", "sessionId": session_id, "content": "", "ts": ts}
    # on_session_start and anything else: no clear message text → skip.
    return None


class HookForwarder:
    """Signature-tolerant hook callbacks that forward activity to the sidecar."""

    def __init__(self, forward: Callable[[Dict[str, Any]], Any], log: Optional[LogFn] = None,
                 now: Optional[Callable[[], float]] = None) -> None:
        self._forward = forward
        self.log = _resolve_log(log)
        self._now = now

    def on_session_start(self, **payload: Any) -> Optional[Dict[str, Any]]:
        return self._dispatch("on_session_start", payload)

    def on_session_end(self, **payload: Any) -> Optional[Dict[str, Any]]:
        return self._dispatch("on_session_end", payload)

    def pre_llm_call(self, **payload: Any) -> Optional[Dict[str, Any]]:
        return self._dispatch("pre_llm_call", payload)

    def _dispatch(self, hook: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            event = build_event(hook, payload, now=self._now)
            if event is None:
                return None
            self._forward(event)
            return event
        except Exception as exc:  # a hook must never raise into hermes
            self.log(f"hook {hook} failed (ignored): {exc}")
            return None


def forward_event(
    port: int,
    token: str,
    event: Dict[str, Any],
    *,
    timeout: float = 2.0,
    opener: Optional[Callable[..., Any]] = None,
    log: Optional[LogFn] = None,
) -> bool:
    """Best-effort ``POST /events`` to the sidecar; returns True on 2xx, never raises."""
    logger = _resolve_log(log)
    url = f"http://127.0.0.1:{int(port)}/events"
    try:
        data = json.dumps(event).encode("utf-8")
    except Exception as exc:
        logger(f"event not serializable (ignored): {exc}")
        return False
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    do_open = opener or urllib.request.urlopen
    try:
        with do_open(request, timeout=timeout) as response:
            return 200 <= int(getattr(response, "status", 200)) < 300
    except Exception as exc:
        logger(f"event forward failed ({event.get('type', '?')}): {exc}")
        return False


def make_forward(settings: Settings, *, log: Optional[LogFn] = None, opener: Optional[Callable[..., Any]] = None,
                 timeout: float = 2.0) -> Callable[[Dict[str, Any]], bool]:
    def _forward(event: Dict[str, Any]) -> bool:
        return forward_event(settings.port, settings.token, event, timeout=timeout, opener=opener, log=log)

    return _forward


# ---------------------------------------------------------------------------
# delivery actions
# ---------------------------------------------------------------------------


def make_inject_fn(ctx: Any, log: Optional[LogFn] = None) -> Callable[[str, Optional[str]], bool]:
    """Build the ``inject_message`` adapter used by the callback listener."""
    logger = _resolve_log(log)

    def _inject(content: str, session_key: Optional[str]) -> bool:
        try:
            return bool(ctx.inject_message(content, role="user", session_key=session_key or None))
        except Exception as exc:
            logger(f"inject_message raised (ignored): {exc}")
            return False

    return _inject


def make_send_fn(settings: Settings, log: Optional[LogFn] = None) -> Callable[[str, Optional[str]], bool]:
    """Build the verbatim delivery adapter (``hermes send --to <target> <content>``)."""
    logger = _resolve_log(log)
    target = settings.hermes_send_target

    def _send(content: str, session_key: Optional[str]) -> bool:
        if not target:
            logger("verbatim delivery requested but hermesSendTarget is not configured; dropping")
            return False
        executable = shutil.which("hermes") or "hermes"
        command = [executable, "send", "--to", target]
        if content.startswith("-"):
            command.append("--")  # don't let a leading-dash message parse as a flag
        command.append(content)
        try:
            proc = subprocess.run(command, capture_output=True, text=True, timeout=30)
        except Exception as exc:
            logger(f"hermes send failed: {exc}")
            return False
        if proc.returncode == 0:
            logger(f"hermes send ok -> {target}")
            return True
        detail = (proc.stderr or proc.stdout or "").strip().replace("\n", " ")[:200]
        logger(f"hermes send exited {proc.returncode}: {detail}")
        return False

    return _send


# ---------------------------------------------------------------------------
# wiring
# ---------------------------------------------------------------------------


def _plugin_id(ctx: Any) -> str:
    try:
        return str(getattr(ctx, "plugin_id", None) or getattr(getattr(ctx, "manifest", None), "name", None) or "kairos")
    except Exception:
        return "kairos"


def register(
    ctx: Any,
    *,
    popen_factory: Optional[Callable[..., Any]] = None,
    server_factory: Optional[Callable[..., Any]] = None,
    opener: Optional[Callable[..., Any]] = None,
    health_probe: Optional[Callable[[], bool]] = None,
    settings: Optional[Settings] = None,
    env: Optional[Dict[str, str]] = None,
    log: Optional[LogFn] = None,
) -> Dict[str, Any]:
    """Wire the KAIROS bridge into a hermes ``PluginContext``.

    Called by hermes as ``register(ctx)``; the keyword-only extras exist purely for
    tests (inject a fake subprocess/server/HTTP opener). Returns a small handle dict
    (also useful in tests). Fail-open: sidecar/health/listener problems are logged,
    never raised.
    """
    logger = _resolve_log(log)
    if settings is None:
        settings = load_settings(ctx, env=env)
    logger(
        f"registering (deliveryMode={settings.delivery_mode}, port={settings.port}, "
        f"callbackPort={settings.callback_port}, dist={settings.dist_path})"
    )

    sidecar = SidecarProcess(
        settings.sidecar_command,
        settings.port,
        settings.token,
        log=logger,
        popen_factory=popen_factory,
        health_probe=health_probe,
    )
    if sidecar.start():
        if sidecar.wait_for_health(settings.start_timeout_sec):
            logger("sidecar is healthy")
        else:
            logger(
                f"sidecar did not report healthy within {settings.start_timeout_sec}s — "
                "continuing anyway (events will be dropped until it is up)"
            )

    server = CallbackServer(
        port=settings.callback_port,
        token=settings.token,
        on_inject=make_inject_fn(ctx, logger),
        on_send=make_send_fn(settings, logger),
        log=logger,
        plugin_id=_plugin_id(ctx),
        server_factory=server_factory,
    )
    try:
        server.start()
    except Exception as exc:
        logger(f"could not start callback listener on port {settings.callback_port}: {exc} (continuing)")

    forwarder = HookForwarder(make_forward(settings, log=logger, opener=opener), log=logger)
    try:
        ctx.register_hook("on_session_start", forwarder.on_session_start)
        ctx.register_hook("on_session_end", forwarder.on_session_end)
        ctx.register_hook("pre_llm_call", forwarder.pre_llm_call)
    except Exception as exc:
        logger(f"hook registration failed (ignored): {exc}")

    def teardown() -> None:
        try:
            server.stop()
        except Exception as exc:
            logger(f"callback shutdown error: {exc}")
        try:
            sidecar.stop()
        except Exception as exc:
            logger(f"sidecar shutdown error: {exc}")

    try:
        ctx.on_unload(teardown)
    except Exception as exc:
        logger(f"on_unload registration failed (ignored): {exc}")

    logger("kairos plugin ready")
    return {
        "sidecar": sidecar,
        "server": server,
        "forwarder": forwarder,
        "settings": settings,
        "teardown": teardown,
    }
