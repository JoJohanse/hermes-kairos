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
                 turn mode:     ctx.inject_message(directive, role="user", session_key=<mapped>)
                 verbatim mode: hermes send --to <target> <content>

Every hook / network / subprocess failure is swallowed and logged: a plugin must
never break the host it is attached to.

Session routing (F1)
--------------------
hermes has two distinct identifiers:

* ``session_id``  — the internal agent/transcript id. Every lifecycle hook
  (``pre_llm_call``, ``on_session_end``; see ``agent/turn_context.py`` and
  ``hermes_cli/hooks.py``) exposes only this.
* ``session_key`` — the gateway routing key built from the message source by
  ``gateway.session.build_session_key`` (``gateway/session.py:664``) and resolved
  per source by ``GatewayRunner._session_key_for_source`` (``gateway/run.py:3861``).
  ``inject_message(session_key=...)`` routes through
  ``SessionStore.lookup_by_session_key`` — a different key space.

Forwarded ``/events`` therefore carry the internal ``sessionId``. To translate it
back, :func:`register` also registers the ``pre_gateway_dispatch`` hook. In hermes
that hook is invoked as::

    invoke_hook("pre_gateway_dispatch", event=<MessageEvent>, gateway=self,
                session_store=getattr(self, "session_store", None))

(``gateway/run_inbound.py:66-78``). The event carries no ``session_key`` field, so
the hook derives it from ``gateway._session_key_for_source(event.source)`` (fallback
``session_store._generate_session_key``) and derives the internal ``session_id`` from
``session_store.lookup_by_session_key(session_key).session_id`` (fallbacks:
``peek_session_id``, ``gateway._peek_session_state(session_key).turn.agent.session_id``,
and event metadata ``gateway_session_id``). The pairing is recorded in a bounded,
thread-safe ``{session_id: session_key}`` map. The hook runs BEFORE the session row
exists, so a brand-new conversation has no mapping until its next inbound message;
callbacks for such an id fall back to CLI-style injection (``session_key`` omitted)
and log a one-time hint.
"""

from __future__ import annotations

import hmac
import http.server
import json
import os
import secrets
import shlex
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

__all__ = [
    "Settings",
    "load_settings",
    "default_dist_path",
    "default_data_dir",
    "ensure_data_dir",
    "build_sidecar_argv",
    "resolve_hermes_executable",
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
    "make_gateway_dispatch_hook",
    "record_session_route",
    "resolve_session_route",
    "clear_session_routes",
    "register",
    "DEFAULT_PORT",
    "DEFAULT_CALLBACK_PORT",
    "DEFAULT_START_TIMEOUT_SEC",
    "DEFAULT_DATA_DIR_NAME",
    "HEALTH_ROUTE",
    "SPEAK_ROUTE",
    "EVENTS_ROUTE",
    "MAX_BODY_BYTES",
    "STATUS_UNSUPPORTED_MEDIA_TYPE",
    "STATUS_PAYLOAD_TOO_LARGE",
    "REQUIRED_CONTENT_TYPE",
    "TOKEN_DISABLED_VALUE",
    "SIDECAR_ARGV_FLAGS",
    "SUPPORTED_SPEAK_KINDS",
    "SUPPORTED_EVENT_TYPES",
]

DEFAULT_PORT = 8671
DEFAULT_CALLBACK_PORT = 8672
DEFAULT_START_TIMEOUT_SEC = 15.0
DEFAULT_DATA_DIR_NAME = "kairos-data"
DIST_RELPATH = ("..", "..", "dist", "hermes-bridge", "main.js")

# --- cross-process contract (mirrored in tests/contract.json) ---------------
HEALTH_ROUTE = "/health"
SPEAK_ROUTE = "/speak"
EVENTS_ROUTE = "/events"
PIDFILE_NAME = "sidecar.pid"

REQUIRED_CONTENT_TYPE = "application/json"
STATUS_UNSUPPORTED_MEDIA_TYPE = 415
STATUS_PAYLOAD_TOO_LARGE = 413
MAX_BODY_BYTES = 1024 * 1024  # 1 MiB

AUTH_HEADER = "authorization"
AUTH_SCHEME = "Bearer"
AUTH_EXEMPT_ROUTES = (HEALTH_ROUTE,)
TOKEN_DISABLED_VALUE = "none"

SIDECAR_ARGV_FLAGS = (
    "--port", "--host", "--token", "--callback-url", "--delivery-mode", "--data-dir", "--nonce",
)
SUPPORTED_SPEAK_KINDS = ("inject", "send")
SUPPORTED_EVENT_TYPES = ("user-message", "agent-message")

# --- hot-path forwarding guard (F9) -----------------------------------------
FORWARD_TIMEOUT_SEC = 0.5
FORWARD_FAILURE_THRESHOLD = 5
FORWARD_LATCH_SEC = 60.0

# --- session-id -> session_key routing map (F1) -----------------------------
MAX_SESSION_ROUTES = 200

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
    data_dir: str = ""
    auth_enabled: bool = True
    token_generated: bool = False
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


def default_data_dir(env: Optional[Dict[str, str]] = None) -> str:
    """Stable plugin data dir: ``<HERMES_HOME>/kairos-data`` when ``HERMES_HOME`` is set,
    else ``~/.hermes/kairos-data``. Passed to the sidecar as ``--data-dir`` (it stores its
    ``.hermes-data`` state there) and used as the subprocess cwd / pidfile home."""
    environ = os.environ if env is None else env
    hermes_home = str(environ.get("HERMES_HOME") or "").strip()
    if hermes_home:
        return os.path.abspath(os.path.join(os.path.expanduser(hermes_home), DEFAULT_DATA_DIR_NAME))
    return os.path.abspath(os.path.join(os.path.expanduser("~"), ".hermes", DEFAULT_DATA_DIR_NAME))


def ensure_data_dir(path: str, log: Optional[LogFn] = None) -> str:
    """``mkdir -p`` the data dir; fail-open (the sidecar may still create it)."""
    try:
        os.makedirs(path, exist_ok=True)
    except Exception as exc:
        _resolve_log(log)(f"could not create dataDir {path!r}: {exc} (continuing)")
    return path


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


def _resolve_token(ctx: Any) -> Tuple[str, bool, bool]:
    """(token, auth_enabled, generated).

    * explicit ``token: "none"`` (any case) → auth off (token ``""``)
    * explicit non-empty token → used as-is
    * empty/absent → a fresh ``secrets.token_urlsafe(24)`` per call (per register)
    """
    raw = str(_cfg(ctx, "token", "") or "").strip()
    if raw.lower() == TOKEN_DISABLED_VALUE:
        return "", False, False
    if raw:
        return raw, True, False
    return secrets.token_urlsafe(24), True, True


def _resolve_data_dir(ctx: Any, env: Optional[Dict[str, str]]) -> str:
    raw = str(_cfg(ctx, "dataDir", "") or "").strip()
    if raw:
        return os.path.abspath(os.path.expanduser(raw))
    return default_data_dir(env)


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

    token, auth_enabled, token_generated = _resolve_token(ctx)
    data_dir = _resolve_data_dir(ctx, environ)

    return Settings(
        sidecar_command=command,
        dist_path=dist,
        port=_cfg_int(ctx, "port", DEFAULT_PORT),
        callback_port=_cfg_int(ctx, "callbackPort", DEFAULT_CALLBACK_PORT),
        token=token,
        delivery_mode=delivery_mode,
        hermes_send_target=str(_cfg(ctx, "hermesSendTarget", "") or ""),
        start_timeout_sec=_cfg_float(ctx, "startTimeoutSec", DEFAULT_START_TIMEOUT_SEC),
        plugin_dir=pdir,
        data_dir=data_dir,
        auth_enabled=auth_enabled,
        token_generated=token_generated,
        raw={
            "sidecarCommand": raw_command,
            "port": _cfg(ctx, "port", DEFAULT_PORT),
            "callbackPort": _cfg(ctx, "callbackPort", DEFAULT_CALLBACK_PORT),
            "token": _cfg(ctx, "token", ""),
            "deliveryMode": _cfg(ctx, "deliveryMode", "turn"),
            "hermesSendTarget": _cfg(ctx, "hermesSendTarget", ""),
            "startTimeoutSec": _cfg(ctx, "startTimeoutSec", DEFAULT_START_TIMEOUT_SEC),
            "dataDir": _cfg(ctx, "dataDir", ""),
        },
    )


def callback_url(settings: Settings) -> str:
    """The sidecar's ``--callback-url``: our /speak listener for this session."""
    return f"http://127.0.0.1:{int(settings.callback_port)}{SPEAK_ROUTE}"


def build_sidecar_argv(settings: Settings, nonce: str) -> List[str]:
    """Final sidecar argv per the cross-process contract.

    ``[node, <script>, --port, P, --token, T, --callback-url, U, --delivery-mode, M,
    --data-dir, D, --nonce, N]``. The configured ``sidecarCommand`` (default
    ``["node", <dist>]``) is the prefix, so a custom command still works. ``--token`` is
    always sent (possibly empty) so both sides agree even when auth is off.
    """
    argv = [str(part) for part in settings.sidecar_command]
    argv += [
        "--port", str(int(settings.port)),
        "--token", settings.token,
        "--callback-url", callback_url(settings),
        "--delivery-mode", settings.delivery_mode,
        "--data-dir", settings.data_dir,
    ]
    if nonce:
        argv += ["--nonce", nonce]
    return argv


# ---------------------------------------------------------------------------
# session_id -> session_key routing (F1)
# ---------------------------------------------------------------------------

_SESSION_ROUTES: "OrderedDict[str, str]" = OrderedDict()
_SESSION_ROUTES_LOCK = threading.Lock()
_HINTED_UNMAPPED: "OrderedDict[str, None]" = OrderedDict()
_HINTED_LOCK = threading.Lock()


def record_session_route(session_id: str, session_key: str) -> None:
    """Record ``{session_id: session_key}`` (bounded to ``MAX_SESSION_ROUTES``, LRU-pruned)."""
    sid = str(session_id or "").strip()
    key = str(session_key or "").strip()
    if not sid or not key:
        return
    with _SESSION_ROUTES_LOCK:
        _SESSION_ROUTES[sid] = key
        _SESSION_ROUTES.move_to_end(sid)
        while len(_SESSION_ROUTES) > MAX_SESSION_ROUTES:
            _SESSION_ROUTES.popitem(last=False)


def resolve_session_route(session_id: str) -> Optional[str]:
    """Return the gateway ``session_key`` observed for ``session_id``, else ``None``."""
    sid = str(session_id or "").strip()
    if not sid:
        return None
    with _SESSION_ROUTES_LOCK:
        return _SESSION_ROUTES.get(sid)


def clear_session_routes() -> None:
    """Drop all recorded routes and hint latches (tests / plugin reload)."""
    with _SESSION_ROUTES_LOCK:
        _SESSION_ROUTES.clear()
    with _HINTED_LOCK:
        _HINTED_UNMAPPED.clear()


def _hint_unmapped(logger: LogFn, session_id: str) -> None:
    """Log the unmapped-id hint at most once per id."""
    sid = str(session_id or "").strip()
    if not sid:
        return
    with _HINTED_LOCK:
        if sid in _HINTED_UNMAPPED:
            return
        _HINTED_UNMAPPED[sid] = None
        while len(_HINTED_UNMAPPED) > MAX_SESSION_ROUTES:
            _HINTED_UNMAPPED.popitem(last=False)
    logger(f"no session_key observed for {sid}; gateway delivery needs an inbound message first")


# ---------------------------------------------------------------------------
# sidecar subprocess
# ---------------------------------------------------------------------------


def _pid_alive(pid: int) -> bool:
    """Best-effort liveness probe. Never uses ``os.kill(pid, 0)`` on Windows (it would
    TerminateProcess the target); uses OpenProcess/GetExitCodeProcess instead."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes

            process_query_limited_information = 0x1000
            still_active = 259
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
            if not handle:
                return False
            try:
                code = ctypes.c_ulong()
                ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
                return bool(ok) and code.value == still_active
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def _default_kill_tree(pid: int) -> None:
    """Kill a pid and its children: ``taskkill /PID <pid> /T /F`` on Windows, TERM→KILL on POSIX."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return
    if pid <= 0:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, text=True, timeout=10)
        except Exception:
            pass
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    time.sleep(0.5)
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass


class SidecarProcess:
    """Owns the ``node dist/hermes-bridge/main.js`` subprocess and its health."""

    def __init__(
        self,
        command: Sequence[str],
        port: int,
        token: str = "",
        *,
        nonce: str = "",
        pid_file: str = "",
        cwd: Optional[str] = None,
        log: Optional[LogFn] = None,
        popen_factory: Optional[Callable[..., Any]] = None,
        health_probe: Optional[Callable[[], bool]] = None,
        env: Optional[Dict[str, str]] = None,
        health_timeout: float = 1.0,
        killer: Optional[Callable[[int], None]] = None,
        pid_alive: Optional[Callable[[int], bool]] = None,
        sleep: Optional[Callable[[float], None]] = None,
        is_windows: Optional[bool] = None,
        os_kill: Optional[Callable[[int, int], None]] = None,
    ) -> None:
        self.command = [str(part) for part in (command or [])]
        self.port = int(port)
        self.token = token or ""
        self.nonce = nonce or ""
        self.pid_file = pid_file or ""
        self.cwd = cwd
        self.log = _resolve_log(log)
        self._popen_factory = popen_factory or subprocess.Popen
        self._health_probe = health_probe
        self._env = env
        self._health_timeout = float(health_timeout)
        self._killer = killer or _default_kill_tree
        self._pid_alive = pid_alive or _pid_alive
        self._sleep = sleep or time.sleep
        self._is_windows = (os.name == "nt") if is_windows is None else bool(is_windows)
        self._os_kill = os_kill
        self._proc: Any = None
        self._threads: List[threading.Thread] = []

    # -- lifecycle -----------------------------------------------------------
    def start(self) -> bool:
        """Spawn the sidecar; return False (never raise) when it cannot be spawned.

        F5: if the spawn succeeds but the initial health probe fails while a live pidfile
        points at an orphan (e.g. EADDRINUSE from a previous run), kill that pid tree,
        wait 1s, and retry health once.
        """
        if not self.command:
            self.log("no sidecar command configured; not spawning")
            return False
        spawn_kwargs: Dict[str, Any] = {}
        if self._is_windows and hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
            spawn_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        if self.cwd:
            spawn_kwargs["cwd"] = self.cwd
        try:
            self._proc = self._popen_factory(
                self.command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=self._env,
                **spawn_kwargs,
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
        if not self.is_healthy():
            self._recover_orphan()
        self.log(f"sidecar started pid={getattr(self._proc, 'pid', '?')} port={self.port}")
        return True

    def _read_pidfile(self) -> Optional[int]:
        if not self.pid_file:
            return None
        try:
            with open(self.pid_file, "r", encoding="utf-8") as handle:
                raw = handle.read().strip()
        except Exception:
            return None
        try:
            pid = int(raw)
        except (TypeError, ValueError):
            return None
        return pid if pid > 0 else None

    def _recover_orphan(self) -> None:
        """Kill a live orphan named by the pidfile when our health probe fails, then retry."""
        pid = self._read_pidfile()
        if pid is None:
            return
        if self._proc is not None and pid == getattr(self._proc, "pid", None):
            return
        if not self._pid_alive(pid):
            return
        self.log(f"health probe failed with a live pidfile pid={pid}; killing orphan sidecar tree")
        try:
            self._killer(pid)
        except Exception as exc:
            self.log(f"orphan kill failed for pid={pid}: {exc}")
        self._sleep(1.0)
        if self.is_healthy():
            self.log("orphan sidecar cleared; health ok")
        else:
            self.log("orphan recovery did not restore health")

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

    def _windows_interrupt(self, proc: Any) -> None:
        """F7: ask a CTRL_BREAK_EVENT-capable child to exit (needs CREATE_NEW_PROCESS_GROUP)."""
        pid = getattr(proc, "pid", None)
        if not isinstance(pid, int) or pid <= 0:
            return
        if not self._pid_alive(pid):
            return
        ctrl_break = getattr(signal, "CTRL_BREAK_EVENT", None)
        if ctrl_break is None:
            return
        kill = self._os_kill or os.kill
        try:
            kill(pid, ctrl_break)
        except Exception as exc:
            self.log(f"CTRL_BREAK_EVENT failed for pid={pid}: {exc}")

    def stop(self, grace: float = 5.0) -> None:
        """Terminate, then SIGKILL after ``grace`` seconds; join reader threads.

        Windows: CTRL_BREAK_EVENT (graceful) → TerminateProcess after ``grace``.
        POSIX: SIGTERM → SIGKILL after ``grace``.
        """
        proc, self._proc = self._proc, None
        if proc is not None:
            try:
                if proc.poll() is None:
                    if self._is_windows:
                        self._windows_interrupt(proc)
                        try:
                            proc.wait(timeout=grace)
                        except Exception:
                            try:
                                proc.kill()
                            except Exception:
                                pass
                    else:
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
        return f"http://127.0.0.1:{self.port}{HEALTH_ROUTE}"

    def is_healthy(self) -> bool:
        """GET /health → True when 2xx AND (when a nonce is expected) ``nonce`` matches.

        Any failure is False, never an exception. The nonce handshake pins the probe to
        THIS boot, so a stale sidecar answering on the port cannot masquerade as ours.
        """
        if self._health_probe is not None:
            try:
                return bool(self._health_probe())
            except Exception:
                return False
        headers = {"Authorization": f"{AUTH_SCHEME} {self.token}"} if self.token else {}
        request = urllib.request.Request(self.health_url(), headers=headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=self._health_timeout) as response:
                if not (200 <= int(getattr(response, "status", 200)) < 300):
                    return False
                if not self.nonce:
                    return True
                body = response.read()
        except Exception:
            return False
        try:
            payload = json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            return False
        return isinstance(payload, dict) and str(payload.get("nonce") or "") == self.nonce

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


def _header_value(headers: Any, name: str) -> str:
    """Case-robust header read (works for ``email.message.Message`` and plain dicts)."""
    for key in (name, name.lower(), name.upper()):
        try:
            value = headers.get(key)
        except Exception:
            value = None
        if value:
            return str(value)
    return ""


class CallbackServer:
    """Minimal HTTP listener the sidecar calls back into.

    ``POST /speak`` with ``{"kind": "inject"|"send", ...}``. Bearer-token gated when
    a token is configured; requires ``content-type: application/json`` (415 otherwise)
    and rejects bodies > 1 MiB (413). Handler delegates to :meth:`dispatch`, which is
    pure enough to unit-test without a socket.
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
        max_body_bytes: int = MAX_BODY_BYTES,
    ) -> None:
        self.port = int(port)
        self.host = host
        self.token = token or ""
        self.on_inject = on_inject
        self.on_send = on_send
        self.log = _resolve_log(log)
        self.plugin_id = plugin_id or "kairos"
        self.max_body_bytes = int(max_body_bytes)
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
        self.log(f"callback listener on http://{self.host}:{self.port}{SPEAK_ROUTE}")
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
        raw = _header_value(headers, "Authorization")
        parts = raw.split(None, 1)
        if len(parts) != 2 or parts[0].lower() != AUTH_SCHEME.lower():
            return False
        return hmac.compare_digest(parts[1].strip(), self.token)

    def dispatch(self, path: str, headers: Any, body: bytes) -> "Tuple[int, Dict[str, Any]]":
        """Route one request; returns ``(status, json_payload)``. Never raises."""
        if path != SPEAK_ROUTE:
            return 404, {"ok": False, "error": "not found"}
        if not self._authorized(headers):
            self.log("callback rejected: unauthorized (bad/missing bearer token)")
            return 401, {"ok": False, "error": "unauthorized"}
        content_type = _header_value(headers, "Content-Type").split(";", 1)[0].strip().lower()
        if content_type != REQUIRED_CONTENT_TYPE:
            self.log(f"callback rejected: unsupported content-type {content_type or '(none)'!r}")
            return STATUS_UNSUPPORTED_MEDIA_TYPE, {"ok": False, "error": "unsupported media type"}
        if len(body) > self.max_body_bytes:
            self.log(f"callback rejected: payload too large ({len(body)} bytes)")
            return STATUS_PAYLOAD_TOO_LARGE, {"ok": False, "error": "payload too large"}
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
            if length > server.max_body_bytes:
                # Cap the actual read; the unread remainder means the connection is unsafe to reuse.
                self.close_connection = True
                try:
                    self.rfile.read(min(length, server.max_body_bytes))
                except Exception:
                    pass
                server.log(f"callback rejected: payload too large ({length} bytes)")
                _write(self, STATUS_PAYLOAD_TOO_LARGE, {"ok": False, "error": "payload too large"})
                return
            body = self.rfile.read(length) if length > 0 else b""
            path = urllib.parse.urlsplit(self.path).path
            try:
                status, payload = server.dispatch(path, self.headers, body)
            except Exception as exc:  # dispatch is defensive; never leak a 500 traceback
                server.log(f"callback dispatch error: {exc}")
                status, payload = 500, {"ok": False, "error": "internal"}
            if status in (STATUS_UNSUPPORTED_MEDIA_TYPE, STATUS_PAYLOAD_TOO_LARGE):
                self.close_connection = True
            _write(self, status, payload)

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.urlsplit(self.path).path
            status, payload = (200, {"ok": True}) if path == HEALTH_ROUTE else (404, {"ok": False, "error": "not found"})
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

    NOTE: the ``sessionId`` here is hermes's internal ``session_id`` (lifecycle hooks
    do not expose the gateway ``session_key``); the return path translates it via the
    ``pre_gateway_dispatch`` mapping. See the module docstring.
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
    timeout: float = FORWARD_TIMEOUT_SEC,
    opener: Optional[Callable[..., Any]] = None,
    log: Optional[LogFn] = None,
) -> bool:
    """Best-effort ``POST /events`` to the sidecar; returns True on 2xx, never raises."""
    logger = _resolve_log(log)
    url = f"http://127.0.0.1:{int(port)}{EVENTS_ROUTE}"
    try:
        data = json.dumps(event).encode("utf-8")
    except Exception as exc:
        logger(f"event not serializable (ignored): {exc}")
        return False
    headers = {"Content-Type": REQUIRED_CONTENT_TYPE}
    if token:
        headers["Authorization"] = f"{AUTH_SCHEME} {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    do_open = opener or urllib.request.urlopen
    try:
        with do_open(request, timeout=timeout) as response:
            return 200 <= int(getattr(response, "status", 200)) < 300
    except Exception as exc:
        logger(f"event forward failed ({event.get('type', '?')}): {exc}")
        return False


def make_forward(
    settings: Settings,
    *,
    log: Optional[LogFn] = None,
    opener: Optional[Callable[..., Any]] = None,
    timeout: float = FORWARD_TIMEOUT_SEC,
    now: Optional[Callable[[], float]] = None,
) -> Callable[[Dict[str, Any]], bool]:
    """Build the forwarder with an F9 failure latch.

    After ``FORWARD_FAILURE_THRESHOLD`` consecutive failures, forwarding is skipped for
    ``FORWARD_LATCH_SEC`` (checked against the injectable ``now`` clock) before retrying.
    """
    logger = _resolve_log(log)
    clock = now or time.monotonic
    state = {"failures": 0, "skip_until": 0.0}

    def _forward(event: Dict[str, Any]) -> bool:
        current = clock()
        if current < state["skip_until"]:
            return False
        ok = forward_event(settings.port, settings.token, event, timeout=timeout, opener=opener, log=logger)
        if ok:
            state["failures"] = 0
            state["skip_until"] = 0.0
            return True
        state["failures"] += 1
        if state["failures"] >= FORWARD_FAILURE_THRESHOLD:
            state["skip_until"] = current + FORWARD_LATCH_SEC
            state["failures"] = 0
            logger(
                f"event forwarding paused for {FORWARD_LATCH_SEC:.0f}s "
                f"after {FORWARD_FAILURE_THRESHOLD} consecutive failures"
            )
        return False

    return _forward


# ---------------------------------------------------------------------------
# delivery actions
# ---------------------------------------------------------------------------


def make_inject_fn(
    ctx: Any,
    log: Optional[LogFn] = None,
    resolve_route: Optional[Callable[[str], Optional[str]]] = None,
) -> Callable[[str, Optional[str]], bool]:
    """Build the ``inject_message`` adapter used by the callback listener.

    ``session_id`` (from the sidecar payload) is translated to the gateway
    ``session_key`` observed via ``pre_gateway_dispatch``. Unmapped ids take the
    CLI-style path (``session_key`` omitted) and log a one-time hint (F1).
    """
    logger = _resolve_log(log)
    resolve = resolve_route or resolve_session_route

    def _inject(content: str, session_id: Optional[str]) -> bool:
        session_key: Optional[str] = None
        if session_id:
            try:
                session_key = resolve(session_id)
            except Exception:
                session_key = None
            if not session_key:
                _hint_unmapped(logger, session_id)
        try:
            return bool(ctx.inject_message(content, role="user", session_key=session_key or None))
        except Exception as exc:
            logger(f"inject_message raised (ignored): {exc}")
            return False

    return _inject


def resolve_hermes_executable(
    env: Optional[Dict[str, str]] = None,
    name: str = "hermes",
    *,
    prefer_windows_ext: Optional[bool] = None,
) -> str:
    """Resolve the hermes CLI, preferring ``hermes.exe`` over ``.cmd``/``.bat`` shims.

    ``shutil.which`` may return a ``hermes.cmd`` npm shim, which CreateProcess cannot
    launch directly (WinError 193) without a shell. We therefore scan every ``PATH``
    entry for ``hermes.exe`` first and only then fall back to ``shutil.which``. On POSIX
    the ``.exe`` preference is skipped.
    """
    environ = os.environ if env is None else env
    prefer_exe = (os.name == "nt") if prefer_windows_ext is None else bool(prefer_windows_ext)
    if prefer_exe:
        path = str(environ.get("PATH") or "")
        for entry in path.split(os.pathsep):
            entry = entry.strip().strip('"')
            if not entry:
                continue
            candidate = os.path.join(entry, name + ".exe")
            try:
                if os.path.isfile(candidate):
                    return candidate
            except Exception:
                continue
    return shutil.which(name) or name


def make_send_fn(settings: Settings, log: Optional[LogFn] = None) -> Callable[[str, Optional[str]], bool]:
    """Build the verbatim delivery adapter (``hermes send --to <target> <content>``)."""
    logger = _resolve_log(log)
    target = settings.hermes_send_target

    def _send(content: str, session_key: Optional[str]) -> bool:
        if not target:
            logger("verbatim delivery requested but hermesSendTarget is not configured; dropping")
            return False
        executable = resolve_hermes_executable()
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
# pre_gateway_dispatch -> session route mapping (F1)
# ---------------------------------------------------------------------------


def _dispatch_session_key(payload: MappingLike, source: Any, event: Any) -> str:
    """Derive the routing session_key for an inbound message.

    Confirmed payload shape (``gateway/run_inbound.py:66-78``):
    ``event=<MessageEvent>``, ``gateway=<GatewayRunner>``, ``session_store=<SessionStore|None>``.
    The event carries no ``session_key`` field, so derive it the same way the runner does.
    """
    gateway = payload.get("gateway")
    store = payload.get("session_store")
    if source is not None:
        for holder, attr in ((gateway, "_session_key_for_source"), (store, "_generate_session_key")):
            fn = getattr(holder, attr, None)
            if not callable(fn):
                continue
            try:
                key = fn(source)
            except Exception:
                continue
            if isinstance(key, str) and key.strip():
                return key.strip()
    metadata = getattr(event, "metadata", None)
    if isinstance(metadata, dict):
        key = str(metadata.get("gateway_session_key") or "").strip()
        if key:
            return key
    return ""


def _dispatch_session_id(payload: MappingLike, session_key: str, event: Any) -> str:
    """Derive the internal ``session_id`` paired with ``session_key``, if observable."""
    gateway = payload.get("gateway")
    store = payload.get("session_store")
    if session_key:
        lookup = getattr(store, "lookup_by_session_key", None)
        if callable(lookup):
            try:
                entry = lookup(session_key)
            except Exception:
                entry = None
            sid = getattr(entry, "session_id", None)
            if isinstance(sid, str) and sid.strip():
                return sid.strip()
        peek = getattr(store, "peek_session_id", None)
        if callable(peek):
            try:
                sid = peek(session_key)
            except Exception:
                sid = None
            if isinstance(sid, str) and sid.strip():
                return sid.strip()
        peek_state = getattr(gateway, "_peek_session_state", None)
        if callable(peek_state):
            try:
                state = peek_state(session_key)
                sid = getattr(getattr(getattr(state, "turn", None), "agent", None), "session_id", None)
            except Exception:
                sid = None
            if isinstance(sid, str) and sid.strip():
                return sid.strip()
    metadata = getattr(event, "metadata", None)
    if isinstance(metadata, dict):
        sid = str(metadata.get("gateway_session_id") or "").strip()
        if sid:
            return sid
    return ""


def make_gateway_dispatch_hook(log: Optional[LogFn] = None) -> Callable[..., Any]:
    """Build the ``pre_gateway_dispatch`` callback that records ``{session_id: session_key}``.

    Returns ``None`` so dispatch always proceeds normally (this is an observer, not a
    skip/rewrite policy gate).
    """
    logger = _resolve_log(log)

    def _hook(**payload: Any) -> None:
        try:
            event = payload.get("event")
            source = getattr(event, "source", None)
            session_key = _dispatch_session_key(payload, source, event)
            session_id = _dispatch_session_id(payload, session_key, event)
            if session_key and session_id:
                record_session_route(session_id, session_key)
        except Exception as exc:
            logger(f"pre_gateway_dispatch mapping failed (ignored): {exc}")
        return None

    return _hook


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
    sidecar_kwargs: Optional[Dict[str, Any]] = None,
    clock: Optional[Callable[[], float]] = None,
) -> Dict[str, Any]:
    """Wire the KAIROS bridge into a hermes ``PluginContext``.

    Called by hermes as ``register(ctx)``; the keyword-only extras exist purely for
    tests (inject a fake subprocess/server/HTTP opener). Returns a small handle dict
    (also useful in tests). Fail-open: sidecar/health/listener problems are logged,
    never raised.
    """
    logger = _resolve_log(log)
    environ = os.environ if env is None else env
    if settings is None:
        settings = load_settings(ctx, env=env)

    # Fresh per-boot nonce: pins /health to THIS sidecar (F5).
    nonce = secrets.token_urlsafe(16)
    data_dir = ensure_data_dir(settings.data_dir, logger)

    logger(
        f"registering (deliveryMode={settings.delivery_mode}, port={settings.port}, "
        f"callbackPort={settings.callback_port}, dataDir={data_dir}, dist={settings.dist_path})"
    )
    if settings.token_generated:
        logger(
            "no token configured; generated an ephemeral bearer token for this session "
            '(set settings.token to "none" to explicitly disable auth)'
        )

    argv = build_sidecar_argv(settings, nonce)
    child_env = dict(os.environ)
    hermes_home = str(environ.get("HERMES_HOME") or "").strip()
    if hermes_home:
        child_env["HERMES_HOME"] = hermes_home

    sidecar_options: Dict[str, Any] = dict(
        log=logger,
        popen_factory=popen_factory,
        health_probe=health_probe,
        env=child_env,
        nonce=nonce,
        pid_file=os.path.join(data_dir, PIDFILE_NAME),
        cwd=data_dir,
    )
    sidecar_options.update(sidecar_kwargs or {})
    sidecar = SidecarProcess(argv, settings.port, settings.token, **sidecar_options)
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

    forwarder = HookForwarder(make_forward(settings, log=logger, opener=opener, now=clock), log=logger)
    hooks_ok = True
    try:
        ctx.register_hook("on_session_start", forwarder.on_session_start)
        ctx.register_hook("on_session_end", forwarder.on_session_end)
        ctx.register_hook("pre_llm_call", forwarder.pre_llm_call)
        # F1: observe the real gateway session_key for incoming messages.
        ctx.register_hook("pre_gateway_dispatch", make_gateway_dispatch_hook(logger))
    except Exception as exc:
        hooks_ok = False
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
        "nonce": nonce,
        "argv": argv,
        "hooks_ok": hooks_ok,
        "teardown": teardown,
    }
