"""Unit tests for the kairos hermes plugin.

Pure-stdlib pytest: no hermes import, no network to the sidecar. The real HTTP
listener is exercised on an ephemeral port with urllib; the subprocess is faked.
Runs on any CPython 3.11+.

    python -m pytest hermes-plugin/kairos/tests/ -q
"""

from __future__ import annotations

import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

# Make ``bridge`` importable without installing the plugin under ~/.hermes.
PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

import bridge  # noqa: E402


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


def post(port, payload, token=None, path="/speak"):
    """POST JSON to the callback listener; returns (status, parsed_body)."""
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
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


def noop_inject(content, session_key):
    return True


def noop_send(content, session_key):
    return True


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------


def test_load_settings_defaults():
    settings = bridge.load_settings(MockCtx(), plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.sidecar_command == ["node", settings.dist_path]
    assert settings.dist_path.endswith(str(Path("dist", "hermes-bridge", "main.js")))
    assert settings.port == 8671
    assert settings.callback_port == 8672
    assert settings.token == ""
    assert settings.delivery_mode == "turn"
    assert settings.hermes_send_target == ""
    assert settings.start_timeout_sec == 15.0


def test_load_settings_dist_env_override():
    import os

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


def test_load_settings_invalid_delivery_mode_falls_back():
    settings = bridge.load_settings(MockCtx({"deliveryMode": "telepathy"}), plugin_dir=str(PLUGIN_DIR), env={})
    assert settings.delivery_mode == "turn"


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
                                    popen_factory=factory, health_probe=lambda: True)
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
                                    popen_factory=broken_factory, health_probe=lambda: True)
    assert sidecar.start() is False
    sidecar.stop()  # must not raise with no process


def test_sidecar_no_command():
    sidecar = bridge.SidecarProcess([], 8671, log=lambda _m: None)
    assert sidecar.start() is False


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
    assert json.loads(request.data.decode("utf-8"))["sessionId"] == "s"


def test_forward_event_tolerates_connection_errors():
    def raising_opener(request, timeout=None):
        raise urllib.error.URLError("connection refused")

    assert bridge.forward_event(8671, "", {"type": "user-message", "sessionId": "s"},
                                opener=raising_opener, log=lambda _m: None) is False


# ---------------------------------------------------------------------------
# register wiring
# ---------------------------------------------------------------------------


def _register_with_fakes(config=None, ctx=None, **kwargs):
    ctx = ctx or MockCtx(config or {"callbackPort": 0, "startTimeoutSec": 0})
    procs = []

    def factory(*args, **kwargs_):
        proc = FakeProc()
        procs.append(proc)
        return proc

    opener = RecordingOpener()
    result = bridge.register(
        ctx,
        popen_factory=factory,
        opener=opener,
        health_probe=lambda: True,
        log=lambda _m: None,
        **kwargs,
    )
    return ctx, result, procs, opener


def test_register_wires_hooks_and_starts_sidecar():
    ctx, result, procs, _opener = _register_with_fakes()
    try:
        assert set(ctx.hooks) == {"on_session_start", "on_session_end", "pre_llm_call"}
        assert len(procs) == 1
        assert result["sidecar"].proc is procs[0]
        assert result["server"].running is True
        assert ctx.unload_callbacks, "on_unload must be registered"
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


def test_register_injection_flows_through_callback():
    ctx, result, _procs, _opener = _register_with_fakes()
    try:
        status, body = post(result["server"].port, {"kind": "inject", "sessionId": "sess-42", "directive": "say hi"})
    finally:
        result["teardown"]()
    assert status == 200 and body["injected"] is True
    assert ctx.injected == [{"content": "say hi", "role": "user", "session_key": "sess-42"}]


def test_register_injection_false_is_reported_without_raising():
    ctx = MockCtx({"callbackPort": 0, "startTimeoutSec": 0})
    ctx.inject_result = False
    ctx, result, _procs, _opener = _register_with_fakes(ctx=ctx)
    try:
        status, body = post(result["server"].port, {"kind": "inject", "sessionId": "s", "directive": "x"})
    finally:
        result["teardown"]()
    assert status == 200 and body["injected"] is False


def test_on_unload_stops_sidecar_and_callback():
    ctx, result, procs, _opener = _register_with_fakes()
    assert procs[0].terminated is False
    ctx.unload_callbacks[0]()  # simulate hermes unload
    assert procs[0].terminated is True
    assert result["server"].running is False


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

    ctx = MockCtx({"callbackPort": 0, "startTimeoutSec": 0, "deliveryMode": "verbatim",
                   "hermesSendTarget": "telegram:me"})
    ctx, result, _procs, _opener = _register_with_fakes(ctx=ctx)
    try:
        status, body = post(result["server"].port, {"kind": "send", "sessionId": "s", "content": "reach out"})
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
    ctx = MockCtx({"callbackPort": 0, "startTimeoutSec": 0, "deliveryMode": "verbatim"})
    ctx, result, _procs, _opener = _register_with_fakes(ctx=ctx)
    try:
        status, body = post(result["server"].port, {"kind": "send", "sessionId": "s", "content": "x"})
    finally:
        result["teardown"]()
    assert status == 200 and body["sent"] is False
    assert called["run"] is False


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
