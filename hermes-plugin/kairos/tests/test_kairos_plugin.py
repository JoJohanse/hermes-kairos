"""Unit tests for the kairos hermes plugin.

Pure-stdlib pytest: no hermes import, no network to the sidecar. The real HTTP
listener is exercised on an ephemeral port with urllib; the subprocess is faked.
Runs on any CPython 3.11+.

    python -m pytest hermes-plugin/kairos/tests/ -q
"""

from __future__ import annotations

import io
import json
import os
import signal
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest

# Make ``bridge`` importable without installing the plugin under ~/.hermes.
PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

import bridge  # noqa: E402

# A stable scratch dataDir so register() never mkdirs inside the developer's home.
_TEST_DATA_DIR = tempfile.mkdtemp(prefix="kairos-test-data-")


# ---------------------------------------------------------------------------
# test doubles
# ---------------------------------------------------------------------------


class MockCtx:
    """Just enough PluginContext surface for ``register`` (no hermes)."""

    plugin_id = "kairos"

    def __init__(self, config=None):
        self.config = dict(config or {})
        self.hooks = {}
        self.unload_callbacks = []
        self.injected = []
        self.inject_result = True

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_hook(self, name, fn):
        self.hooks[name] = fn
        return fn

    def on_unload(self, fn):
        self.unload_callbacks.append(fn)
        return fn

    def inject_message(self, content, role="user", *, session_key=None):
        self.injected.append({"content": content, "role": role, "session_key": session_key})
        return self.inject_result


class FakeProc:
    """Stand-in for subprocess.Popen."""

    def __init__(self):
        self.pid = 4242
        self.stdout = io.StringIO("bridge booting\n")
        self.stderr = io.StringIO("")
        self.terminated = False
        self.killed = False
        self._returncode = None

    def poll(self):
        return self._returncode

    def terminate(self):
        self.terminated = True
        self._returncode = 0

    def kill(self):
        self.killed = True
        self._returncode = -9

    def wait(self, timeout=None):
        if self._returncode is None:
            self._returncode = 0
        return self._returncode


class FakeResponse:
    def __init__(self, status=200, body=b"{}"):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class RecordingOpener:
    """Captures POST requests instead of hitting the network."""

    def __init__(self, status=200):
        self.requests = []
        self.status = status

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        return FakeResponse(self.status)


def post(port, payload, token=None, path="/speak", content_type="application/json", body=None):
    """POST JSON to the callback listener; returns (status, parsed_body)."""
    data = body if body is not None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": content_type}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------


def test_load_settings_defaults():
    settings = bridge.load_settings(MockCtx(), plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.sidecar_command == ["node", settings.dist_path]
    assert settings.dist_path.endswith(str(Path("dist", "hermes-bridge", "main.js")))
    assert settings.port == 8671
    assert settings.callback_port == 8672
    assert settings.delivery_mode == "turn"
    assert settings.hermes_send_target == ""
    assert settings.start_timeout_sec == 15.0
    assert settings.data_dir.endswith(bridge.DEFAULT_DATA_DIR_NAME)
    # token absent -> generated per register()
    assert settings.token and settings.auth_enabled and settings.token_generated


def test_load_settings_dist_env_override():
    override = os.path.join(os.sep, "opt", "kairos", "main.js")
    settings = bridge.load_settings(MockCtx(), plugin_dir=str(PLUGIN_DIR), env={"KAIROS_DIST": override})
    expected = os.path.abspath(override)
    assert settings.dist_path == expected
    assert settings.sidecar_command == ["node", expected]
    assert "hermes-bridge" not in settings.dist_path


def test_load_settings_overrides_and_coercion():
    ctx = MockCtx(
        {
            "sidecarCommand": ["deno", "run", "main.js"],
            "port": "9001",
            "callbackPort": "9002",
            "token": "secret",
            "deliveryMode": "VERBATIM",
            "hermesSendTarget": "telegram:me",
            "startTimeoutSec": "3.5",
        }
    )
    settings = bridge.load_settings(ctx, plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.sidecar_command == ["deno", "run", "main.js"]
    assert settings.port == 9001 and isinstance(settings.port, int)
    assert settings.callback_port == 9002
    assert settings.token == "secret"
    assert settings.auth_enabled and not settings.token_generated
    assert settings.delivery_mode == "verbatim"
    assert settings.hermes_send_target == "telegram:me"
    assert settings.start_timeout_sec == 3.5


def test_load_settings_string_command_is_split():
    ctx = MockCtx({"sidecarCommand": "node custom/main.js"})
    settings = bridge.load_settings(ctx, plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.sidecar_command == ["node", "custom/main.js"]


def test_load_settings_tolerates_broken_ctx():
    class Broken:
        def get_config(self, key, default=None):
            raise RuntimeError("no config backend")

    settings = bridge.load_settings(Broken(), plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.port == 8671 and settings.delivery_mode == "turn"
    assert settings.token and settings.data_dir


def test_load_settings_invalid_delivery_mode_falls_back():
    settings = bridge.load_settings(MockCtx({"deliveryMode": "telepathy"}), plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.delivery_mode == "turn"


def test_load_settings_generates_token_when_absent():
    first = bridge.load_settings(MockCtx(), plugin_dir=str(PLUGIN_DIR), env={})
    second = bridge.load_settings(MockCtx(), plugin_dir=str(PLUGIN_DIR), env={})
    assert first.token_generated and first.auth_enabled
    assert len(first.token) >= 24
    assert first.token != second.token  # per-call (per register) generation


def test_load_settings_token_none_disables_auth():
    settings = bridge.load_settings(MockCtx({"token": "none"}), plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.token == ""
    assert settings.auth_enabled is False
    assert settings.token_generated is False


def test_load_settings_data_dir_override():
    override = os.path.join(os.sep, "var", "kairos")
    settings = bridge.load_settings(MockCtx({"dataDir": override}), plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.data_dir == os.path.abspath(override)


def test_load_settings_data_dir_honors_hermes_home():
    home = os.path.join(os.sep, "srv", "hermes")
    settings = bridge.load_settings(MockCtx(), plugin_dir=str(PLUGIN_DIR), env={"HERMES_HOME": home})
    expected = os.path.abspath(os.path.join(os.path.expanduser(home), bridge.DEFAULT_DATA_DIR_NAME))
    assert settings.data_dir == expected


def test_build_sidecar_argv_contract_shape():
    settings = bridge.load_settings(MockCtx({"token": "tok", "callbackPort": 9002}),
                                    plugin_dir=str(PLUGIN_DIR), env={})
    argv = bridge.build_sidecar_argv(settings, "NONCE")
    assert argv[:2] == ["node", settings.dist_path]
    assert argv[2:] == [
        "--port", "8671",
        "--token", "tok",
        "--callback-url", "http://127.0.0.1:9002/speak",
        "--delivery-mode", "turn",
        "--data-dir", settings.data_dir,
        "--nonce", "NONCE",
    ]


# ---------------------------------------------------------------------------
# hook payload -> event mapping
# ---------------------------------------------------------------------------


def test_build_event_pre_llm_call_uses_user_message():
    event = bridge.build_event("pre_llm_call", {"session_key": "sess-1", "user_message": "hello there"}, now=lambda: 123.0)
    assert event == {"type": "user-message", "sessionId": "sess-1", "content": "hello there", "ts": 123.0}


def test_build_event_pre_llm_call_falls_back_to_history():
    payload = {"session_id": "sess-2", "conversation_history": [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "latest question"},
    ]}
    event = bridge.build_event("pre_llm_call", payload)
    assert event["type"] == "user-message"
    assert event["sessionId"] == "sess-2"
    assert event["content"] == "latest question"


def test_build_event_skips_when_no_text():
    assert bridge.build_event("pre_llm_call", {"session_key": "s"}) is None
    assert bridge.build_event("on_session_start", {"session_key": "s"}) is None
    assert bridge.build_event("pre_llm_call", {"user_message": "hi"}) is None  # no session id


def test_build_event_on_session_end_marks_agent_activity():
    event = bridge.build_event("on_session_end", {"session_key": "sess-3"})
    assert event["type"] == "agent-message"
    assert event["sessionId"] == "sess-3"
    assert event["content"] == ""


def test_extract_text_handles_shapes():
    assert bridge.extract_text("  plain ") == "plain"
    assert bridge.extract_text({"content": "from dict"}) == "from dict"
    assert bridge.extract_text([{"role": "assistant", "content": "a"}, {"role": "user", "content": "b"}]) == "b"
    assert bridge.extract_text(None) == ""


# ---------------------------------------------------------------------------
# HookForwarder
# ---------------------------------------------------------------------------


def test_hook_forwarder_dispatch_and_safety():
    forwarded = []
    forwarder = bridge.HookForwarder(forwarded.append, log=lambda _m: None)
    assert forwarder.pre_llm_call(session_key="s1", user_message="ping")["type"] == "user-message"
    assert forwarded[-1]["sessionId"] == "s1"
    assert forwarder.on_session_end(session_key="s1")["type"] == "agent-message"
    assert forwarder.on_session_start(session_key="s1") is None
    assert forwarder.pre_llm_call(session_key="s1") is None


def test_hook_forwarder_swallows_forward_errors():
    def boom(_event):
        raise RuntimeError("network down")

    forwarder = bridge.HookForwarder(boom, log=lambda _m: None)
    # Must not raise even though the forward fails; returns None.
    assert forwarder.pre_llm_call(session_key="s1", user_message="hi") is None


# ---------------------------------------------------------------------------
# sidecar process
# ---------------------------------------------------------------------------


def test_sidecar_start_health_and_stop_with_fakes():
    procs = []

    def factory(*args, **kwargs):
        proc = FakeProc()
        procs.append(proc)
        return proc

    sidecar = bridge.SidecarProcess(["node", "main.js"], 8671, log=lambda _m: None,
                                    popen_factory=factory, health_probe=lambda: True,
                                    is_windows=False)
    assert sidecar.start() is True
    assert len(procs) == 1
    assert sidecar.wait_for_health(1.0) is True
    sidecar.stop()
    assert procs[0].terminated is True
    assert sidecar.proc is None


def test_sidecar_spawn_failure_is_fail_open():
    def broken_factory(*args, **kwargs):
        raise FileNotFoundError("node not found")

    sidecar = bridge.SidecarProcess(["node", "main.js"], 8671, log=lambda _m: None,
                                    popen_factory=broken_factory, health_probe=lambda: True,
                                    is_windows=False)
    assert sidecar.start() is False
    sidecar.stop()  # must not raise with no process


def test_sidecar_no_command():
    sidecar = bridge.SidecarProcess([], 8671, log=lambda _m: None)
    assert sidecar.start() is False


def test_sidecar_stop_windows_uses_ctrl_break_then_terminate(monkeypatch):
    if not hasattr(signal, "CTRL_BREAK_EVENT"):
        pytest.skip("CTRL_BREAK_EVENT is Windows-only")

    class TimeoutProc(FakeProc):
        def __init__(self):
            super().__init__()
            self.wait_calls = 0

        def wait(self, timeout=None):
            self.wait_calls += 1
            if self.wait_calls == 1:
                raise bridge.subprocess.TimeoutExpired("node", timeout)
            self._returncode = 0
            return 0

    proc = TimeoutProc()
    killed = []

    sidecar = bridge.SidecarProcess(
        ["node", "main.js"], 8671, log=lambda _m: None,
        popen_factory=lambda *a, **k: proc, health_probe=lambda: True,
        is_windows=True, os_kill=lambda pid, sig: killed.append((pid, sig)),
        pid_alive=lambda _pid: True,
    )
    sidecar.start()
    sidecar.stop()
    assert killed == [(4242, signal.CTRL_BREAK_EVENT)]
    assert proc.killed is True  # TerminateProcess fallback after the graceful wait timed out


class _HealthOpener:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        return FakeResponse(200, json.dumps(self.payload).encode("utf-8"))


def test_sidecar_nonce_mismatch_is_unhealthy(monkeypatch):
    opener = _HealthOpener({"ok": True, "nonce": "other"})
    monkeypatch.setattr(bridge.urllib.request, "urlopen", opener)
    sidecar = bridge.SidecarProcess(["node", "main.js"], 8671, nonce="expected", log=lambda _m: None)
    assert sidecar.is_healthy() is False


def test_sidecar_nonce_match_is_healthy(monkeypatch):
    opener = _HealthOpener({"ok": True, "nonce": "expected"})
    monkeypatch.setattr(bridge.urllib.request, "urlopen", opener)
    sidecar = bridge.SidecarProcess(["node", "main.js"], 8671, nonce="expected", log=lambda _m: None)
    assert sidecar.is_healthy() is True


def test_sidecar_orphan_pidfile_kill_and_retry(tmp_path):
    pid_file = tmp_path / "sidecar.pid"
    pid_file.write_text("12345", encoding="utf-8")
    calls = {"n": 0}
    killed = []

    def probe():
        calls["n"] += 1
        return calls["n"] > 1  # unhealthy on the first probe, healthy on the retry

    sidecar = bridge.SidecarProcess(
        ["node", "main.js"], 8671, log=lambda _m: None,
        popen_factory=lambda *a, **k: FakeProc(), health_probe=probe,
        pid_file=str(pid_file), killer=killed.append, pid_alive=lambda _pid: True,
        sleep=lambda _s: None, is_windows=False,
    )
    assert sidecar.start() is True
    assert killed == [12345]
    assert calls["n"] == 2


def test_sidecar_orphan_pidfile_ignores_own_pid(tmp_path):
    pid_file = tmp_path / "sidecar.pid"
    pid_file.write_text("4242", encoding="utf-8")  # the pid our FakeProc reports
    killed = []

    sidecar = bridge.SidecarProcess(
        ["node", "main.js"], 8671, log=lambda _m: None,
        popen_factory=lambda *a, **k: FakeProc(), health_probe=lambda: False,
        pid_file=str(pid_file), killer=killed.append, pid_alive=lambda _pid: True,
        sleep=lambda _s: None, is_windows=False,
    )
    sidecar.start()
    assert killed == []


# ---------------------------------------------------------------------------
# callback listener
# ---------------------------------------------------------------------------


def _make_server(**kwargs):
    calls = {"inject": [], "send": []}

    def on_inject(content, session_key):
        calls["inject"].append((content, session_key))
        return kwargs.pop("inject_result", True)

    def on_send(content, session_key):
        calls["send"].append((content, session_key))
        return True

    server = bridge.CallbackServer(
        port=0,
        token=kwargs.pop("token", ""),
        on_inject=on_inject,
        on_send=on_send,
        log=kwargs.pop("log", lambda _m: None),
        **kwargs,
    )
    server.start()
    return server, calls


def test_callback_inject_calls_inject_message():
    server, calls = _make_server()
    try:
        status, body = post(server.port, {"kind": "inject", "sessionId": "sess-9", "directive": "reach out now", "score": 0.8})
    finally:
        server.stop()
    assert status == 200 and body == {"ok": True, "injected": True}
    assert calls["inject"] == [("reach out now", "sess-9")]


def test_callback_send_dispatches_verbatim():
    server, calls = _make_server()
    try:
        status, body = post(server.port, {"kind": "send", "sessionId": "sess-9", "content": "hello from kairos"})
    finally:
        server.stop()
    assert status == 200 and body == {"ok": True, "sent": True}
    assert calls["send"] == [("hello from kairos", "sess-9")]


def test_callback_wrong_token_is_401_and_no_inject():
    server, calls = _make_server(token="right-token")
    try:
        status, body = post(server.port, {"kind": "inject", "sessionId": "s", "directive": "x"}, token="wrong-token")
        ok_status, _ = post(server.port, {"kind": "inject", "sessionId": "s", "directive": "x"}, token="right-token")
    finally:
        server.stop()
    assert status == 401 and body["error"] == "unauthorized"
    assert ok_status == 200
    assert calls["inject"] == [("x", "s")]  # only the authorized request got through


def test_callback_missing_token_is_401():
    server, calls = _make_server(token="right-token")
    try:
        status, _ = post(server.port, {"kind": "inject", "sessionId": "s", "directive": "x"})
    finally:
        server.stop()
    assert status == 401
    assert calls["inject"] == []


def test_callback_unknown_kind_and_bad_body():
    server, _ = _make_server()
    try:
        status_unknown, _ = post(server.port, {"kind": "wat"})
        status_missing, _ = post(server.port, {"kind": "inject", "sessionId": "s"})
    finally:
        server.stop()
    assert status_unknown == 400
    assert status_missing == 400


def test_callback_health_get():
    server, _ = _make_server()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{server.port}/health", timeout=5) as response:
            assert response.status == 200
    finally:
        server.stop()


def test_callback_rejects_wrong_content_type_415():
    server, calls = _make_server()
    try:
        status, body = post(server.port, {"kind": "inject", "sessionId": "s", "directive": "x"},
                            content_type="text/plain")
    finally:
        server.stop()
    assert status == bridge.STATUS_UNSUPPORTED_MEDIA_TYPE == 415
    assert body["error"] == "unsupported media type"
    assert calls["inject"] == []


def test_callback_rejects_oversize_body_413():
    server, calls = _make_server()
    big = json.dumps({"kind": "inject", "sessionId": "s",
                      "directive": "x" * (bridge.MAX_BODY_BYTES + 1024)}).encode("utf-8")
    try:
        status, body = post(server.port, None, body=big)
    finally:
        server.stop()
    assert status == bridge.STATUS_PAYLOAD_TOO_LARGE == 413
    assert body["error"] == "payload too large"
    assert calls["inject"] == []


# ---------------------------------------------------------------------------
# forward_event
# ---------------------------------------------------------------------------


def test_forward_event_posts_event():
    opener = RecordingOpener(status=200)
    ok = bridge.forward_event(8671, "tok", {"type": "user-message", "sessionId": "s", "content": "hi"},
                              opener=opener, log=lambda _m: None)
    assert ok is True
    request = opener.requests[0]
    assert request.method == "POST"
    assert request.full_url == "http://127.0.0.1:8671/events"
    assert request.get_header("Authorization") == "Bearer tok"
    assert request.get_header("Content-type") == bridge.REQUIRED_CONTENT_TYPE
    assert json.loads(request.data.decode("utf-8"))["sessionId"] == "s"


def test_forward_event_tolerates_connection_errors():
    def raising_opener(request, timeout=None):
        raise urllib.error.URLError("connection refused")

    assert bridge.forward_event(8671, "", {"type": "user-message", "sessionId": "s"},
                                opener=raising_opener, log=lambda _m: None) is False


def test_forward_event_default_timeout_is_hot_path():
    seen = {}

    def opener(request, timeout=None):
        seen["timeout"] = timeout
        return FakeResponse(200)

    bridge.forward_event(8671, "", {"type": "user-message", "sessionId": "s"}, opener=opener, log=lambda _m: None)
    assert seen["timeout"] == bridge.FORWARD_TIMEOUT_SEC == 0.5


def test_forward_latch_skips_after_consecutive_failures():
    clock = {"now": 0.0}
    attempts = {"n": 0}

    def opener(request, timeout=None):
        attempts["n"] += 1
        raise urllib.error.URLError("connection refused")

    settings = bridge.load_settings(MockCtx({"token": "none"}), plugin_dir=str(PLUGIN_DIR), env={})
    forward = bridge.make_forward(settings, opener=opener, log=lambda _m: None, now=lambda: clock["now"])
    event = {"type": "user-message", "sessionId": "s"}
    for _ in range(bridge.FORWARD_FAILURE_THRESHOLD):
        assert forward(event) is False
    assert attempts["n"] == bridge.FORWARD_FAILURE_THRESHOLD
    # Latched: no further attempt until the latch window elapses.
    assert forward(event) is False
    assert attempts["n"] == bridge.FORWARD_FAILURE_THRESHOLD
    clock["now"] += bridge.FORWARD_LATCH_SEC + 1.0
    assert forward(event) is False
    assert attempts["n"] == bridge.FORWARD_FAILURE_THRESHOLD + 1


def test_resolve_hermes_executable_prefers_exe(tmp_path, monkeypatch):
    (tmp_path / "hermes.exe").write_text("", encoding="utf-8")
    (tmp_path / "hermes.bat").write_text("", encoding="utf-8")
    monkeypatch.setattr(bridge.shutil, "which", lambda _name: "C:/npm/hermes.cmd")
    resolved = bridge.resolve_hermes_executable(env={"PATH": str(tmp_path)}, prefer_windows_ext=True)
    assert resolved == str(tmp_path / "hermes.exe")
    fallback = bridge.resolve_hermes_executable(env={"PATH": ""}, prefer_windows_ext=True)
    assert fallback == "C:/npm/hermes.cmd"


# ---------------------------------------------------------------------------
# register wiring
# ---------------------------------------------------------------------------


def _register_config(extra=None):
    cfg = {"callbackPort": 0, "startTimeoutSec": 0, "dataDir": _TEST_DATA_DIR}
    if extra:
        cfg.update(extra)
    return cfg


def _register_with_fakes(config=None, ctx=None, log=None, **kwargs):
    bridge.clear_session_routes()
    ctx = ctx or MockCtx(config or _register_config())
    ctx.config.setdefault("dataDir", _TEST_DATA_DIR)
    procs = []

    def factory(*args, **kwargs_):
        proc = FakeProc()
        procs.append(proc)
        return proc

    opener = RecordingOpener()
    sidecar_kwargs = {"is_windows": False, "sleep": lambda _s: None}
    sidecar_kwargs.update(kwargs.pop("sidecar_kwargs", {}))
    result = bridge.register(
        ctx,
        popen_factory=factory,
        opener=opener,
        health_probe=lambda: True,
        log=log or (lambda _m: None),
        sidecar_kwargs=sidecar_kwargs,
        **kwargs,
    )
    return ctx, result, procs, opener


def test_register_wires_hooks_and_starts_sidecar():
    ctx, result, procs, _opener = _register_with_fakes()
    try:
        assert set(ctx.hooks) == {"on_session_start", "on_session_end", "pre_llm_call", "pre_gateway_dispatch"}
        assert len(procs) == 1
        assert result["sidecar"].proc is procs[0]
        assert result["server"].running is True
        assert ctx.unload_callbacks, "on_unload must be registered"
    finally:
        result["teardown"]()


def test_register_passes_contract_argv_and_data_dir():
    ctx, result, _procs, _opener = _register_with_fakes()
    try:
        argv = result["argv"]
        settings = result["settings"]
        assert argv[:2] == ["node", settings.dist_path]
        assert argv[argv.index("--port") + 1] == str(settings.port)
        assert argv[argv.index("--token") + 1] == settings.token
        assert argv[argv.index("--callback-url") + 1].endswith(bridge.SPEAK_ROUTE)
        assert argv[argv.index("--delivery-mode") + 1] == settings.delivery_mode
        assert argv[argv.index("--data-dir") + 1] == _TEST_DATA_DIR
        assert argv[argv.index("--nonce") + 1] == result["nonce"]
        assert result["sidecar"].command == argv
    finally:
        result["teardown"]()


def test_register_hook_forwards_via_opener():
    ctx, result, _procs, opener = _register_with_fakes()
    try:
        ctx.hooks["pre_llm_call"](session_key="sess-hook", user_message="ping from test")
        ctx.hooks["on_session_end"](session_key="sess-hook")
    finally:
        result["teardown"]()
    types = [json.loads(request.data.decode("utf-8"))["type"] for request in opener.requests]
    assert types == ["user-message", "agent-message"]
    assert json.loads(opener.requests[0].data.decode("utf-8"))["content"] == "ping from test"


def test_register_injection_unmapped_uses_cli_path_and_hint():
    logs = []
    ctx, result, _procs, _opener = _register_with_fakes(log=logs.append)
    token = result["settings"].token
    try:
        status, body = post(result["server"].port,
                            {"kind": "inject", "sessionId": "sess-42", "directive": "say hi"}, token=token)
    finally:
        result["teardown"]()
    assert status == 200 and body["injected"] is True
    assert ctx.injected == [{"content": "say hi", "role": "user", "session_key": None}]
    hints = [line for line in logs if "no session_key observed for sess-42" in line]
    assert len(hints) == 1  # rate-limited to once per id


def test_register_injection_mapped_uses_real_session_key():
    ctx, result, _procs, _opener = _register_with_fakes()
    real_key = "agent:main:telegram:dm:12345"
    bridge.record_session_route("sess-42", real_key)
    token = result["settings"].token
    try:
        status, body = post(result["server"].port,
                            {"kind": "inject", "sessionId": "sess-42", "directive": "say hi"}, token=token)
    finally:
        result["teardown"]()
    assert status == 200 and body["injected"] is True
    assert ctx.injected == [{"content": "say hi", "role": "user", "session_key": real_key}]


def test_register_injection_false_is_reported_without_raising():
    ctx = MockCtx(_register_config())
    ctx.inject_result = False
    ctx, result, _procs, _opener = _register_with_fakes(ctx=ctx)
    token = result["settings"].token
    try:
        status, body = post(result["server"].port, {"kind": "inject", "sessionId": "s", "directive": "x"}, token=token)
    finally:
        result["teardown"]()
    assert status == 200 and body["injected"] is False


def test_register_injection_resolves_session_key_from_captured_store():
    bridge.clear_session_routes()
    ctx, result, _procs, _opener = _register_with_fakes()
    token = result["settings"].token
    session_id = "20260920_144726_9cdf793e"
    real_key = "agent:main:telegram:dm:12345"
    entry = SimpleNamespace(session_id=session_id, session_key=real_key)
    store = SimpleNamespace(
        lookup_by_session_id=lambda sid: entry if sid == session_id else None,
        lookup_by_session_key=lambda _key: None,
    )
    event = SimpleNamespace(source=object(), metadata={})
    try:
        # First inbound message: pre_gateway_dispatch runs before the row exists, so it
        # records no mapping but captures the store.
        ctx.hooks["pre_gateway_dispatch"](event=event, gateway=SimpleNamespace(), session_store=store)
        assert bridge.resolve_session_route(session_id) is None
        status, body = post(result["server"].port,
                            {"kind": "inject", "sessionId": session_id, "directive": "reach out"}, token=token)
    finally:
        bridge.clear_session_routes()
        result["teardown"]()
    assert status == 200 and body["injected"] is True
    assert ctx.injected == [{"content": "reach out", "role": "user", "session_key": real_key}]


def test_register_injection_mapped_id_uses_map_before_store():
    bridge.clear_session_routes()
    ctx, result, _procs, _opener = _register_with_fakes()
    token = result["settings"].token
    session_id = "sess-mapped"
    real_key = "agent:main:telegram:dm:777"
    entry = SimpleNamespace(session_id=session_id, session_key=real_key)
    store_calls = {"lookup": 0}

    def lookup_by_session_id(_sid):
        store_calls["lookup"] += 1
        return None

    store = SimpleNamespace(
        lookup_by_session_id=lookup_by_session_id,
        lookup_by_session_key=lambda _key: entry,
    )
    gateway = SimpleNamespace(_session_key_for_source=lambda _source: real_key)
    event = SimpleNamespace(source=object(), metadata={})
    try:
        ctx.hooks["pre_gateway_dispatch"](event=event, gateway=gateway, session_store=store)
        assert bridge.resolve_session_route(session_id) == real_key
        status, body = post(result["server"].port,
                            {"kind": "inject", "sessionId": session_id, "directive": "hi"}, token=token)
    finally:
        bridge.clear_session_routes()
        result["teardown"]()
    assert status == 200 and body["injected"] is True
    assert ctx.injected == [{"content": "hi", "role": "user", "session_key": real_key}]
    assert store_calls["lookup"] == 0  # map hit: the store is never consulted


def test_register_injection_store_failure_logs_no_key_reason():
    logs = []
    ctx = MockCtx(_register_config())
    ctx.inject_result = False
    ctx, result, _procs, _opener = _register_with_fakes(ctx=ctx, log=logs.append)
    token = result["settings"].token
    session_id = "sess-store-down"

    class BoomStore:
        def lookup_by_session_id(self, _sid):
            raise RuntimeError("store caught mid-write")

    event = SimpleNamespace(source=object(), metadata={})
    try:
        ctx.hooks["pre_gateway_dispatch"](event=event, gateway=SimpleNamespace(), session_store=BoomStore())
        status, body = post(result["server"].port,
                            {"kind": "inject", "sessionId": session_id, "directive": "x"}, token=token)
    finally:
        bridge.clear_session_routes()
        result["teardown"]()
    assert status == 200 and body["injected"] is False
    # CLI-path fallback: no session_key passed, one-time hint logged.
    assert ctx.injected == [{"content": "x", "role": "user", "session_key": None}]
    assert any(f"no session_key resolved for {session_id}" in line for line in logs)
    # The real reason is the missing key, NOT the allow-gateway flag.
    assert not any("allow_gateway_injection" in line for line in logs)


def test_register_injection_resolved_key_but_false_logs_allow_flag_reason():
    logs = []
    ctx = MockCtx(_register_config())
    ctx.inject_result = False
    ctx, result, _procs, _opener = _register_with_fakes(ctx=ctx, log=logs.append)
    token = result["settings"].token
    session_id = "sess-flag-off"
    real_key = "agent:main:discord:dm:42"
    entry = SimpleNamespace(session_id=session_id, session_key=real_key)
    store = SimpleNamespace(lookup_by_session_id=lambda sid: entry if sid == session_id else None)
    event = SimpleNamespace(source=object(), metadata={})
    try:
        ctx.hooks["pre_gateway_dispatch"](event=event, gateway=SimpleNamespace(), session_store=store)
        status, body = post(result["server"].port,
                            {"kind": "inject", "sessionId": session_id, "directive": "x"}, token=token)
    finally:
        bridge.clear_session_routes()
        result["teardown"]()
    assert status == 200 and body["injected"] is False
    assert ctx.injected == [{"content": "x", "role": "user", "session_key": real_key}]
    assert any(f"session_key {real_key!r} resolved for {session_id}" in line for line in logs)
    assert any("allow_gateway_injection" in line for line in logs)
    assert not any(f"no session_key resolved for {session_id}" in line for line in logs)


def test_on_unload_stops_sidecar_and_callback():
    ctx, result, procs, _opener = _register_with_fakes()
    assert procs[0].terminated is False
    ctx.unload_callbacks[0]()  # simulate hermes unload
    assert procs[0].terminated is True
    assert result["server"].running is False


def test_pre_gateway_dispatch_records_session_route():
    bridge.clear_session_routes()
    entry = SimpleNamespace(session_id="sid-1")
    store = SimpleNamespace(lookup_by_session_key=lambda key: entry)
    gateway = SimpleNamespace(_session_key_for_source=lambda source: "agent:main:telegram:dm:9")
    event = SimpleNamespace(source=object(), metadata={})
    hook = bridge.make_gateway_dispatch_hook(log=lambda _m: None)
    assert hook(event=event, gateway=gateway, session_store=store) is None  # observer, not a gate
    assert bridge.resolve_session_route("sid-1") == "agent:main:telegram:dm:9"
    bridge.clear_session_routes()


def test_pre_gateway_dispatch_falls_back_to_event_metadata():
    bridge.clear_session_routes()
    store = SimpleNamespace(lookup_by_session_key=lambda key: None)
    event = SimpleNamespace(source=object(),
                            metadata={"gateway_session_key": "agent:main:slack:dm:x", "gateway_session_id": "sid-2"})
    hook = bridge.make_gateway_dispatch_hook(log=lambda _m: None)
    hook(event=event, gateway=SimpleNamespace(), session_store=store)
    assert bridge.resolve_session_route("sid-2") == "agent:main:slack:dm:x"
    bridge.clear_session_routes()


def test_register_uses_verbatim_send_when_configured(monkeypatch):
    sent = {}

    class FakeCompleted:
        returncode = 0
        stderr = ""
        stdout = "sent"

    def fake_run(command, capture_output=True, text=True, timeout=30):
        sent["command"] = command
        return FakeCompleted()

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    monkeypatch.setattr(bridge.shutil, "which", lambda _name: "hermes")

    ctx = MockCtx(_register_config({"deliveryMode": "verbatim", "hermesSendTarget": "telegram:me"}))
    ctx, result, _procs, _opener = _register_with_fakes(ctx=ctx)
    token = result["settings"].token
    try:
        status, body = post(result["server"].port, {"kind": "send", "sessionId": "s", "content": "reach out"}, token=token)
    finally:
        result["teardown"]()
    assert status == 200 and body["sent"] is True
    assert sent["command"] == ["hermes", "send", "--to", "telegram:me", "reach out"]


def test_register_send_without_target_is_noop(monkeypatch):
    called = {"run": False}

    def fake_run(*args, **kwargs):  # pragma: no cover - must not be called
        called["run"] = True
        raise AssertionError("hermes send should not run without a target")

    monkeypatch.setattr(bridge.subprocess, "run", fake_run)
    ctx = MockCtx(_register_config({"deliveryMode": "verbatim"}))
    ctx, result, _procs, _opener = _register_with_fakes(ctx=ctx)
    token = result["settings"].token
    try:
        status, body = post(result["server"].port, {"kind": "send", "sessionId": "s", "content": "x"}, token=token)
    finally:
        result["teardown"]()
    assert status == 200 and body["sent"] is False
    assert called["run"] is False


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
