"""Golden-contract test (F10).

``tests/contract.json`` is the machine-readable cross-process contract; the TS sidecar
mirrors the same bytes at ``src/hermes-bridge/contract.json``. This module asserts the
plugin's ACTUAL behavior (constants, payload dicts, auth/content-type checks, nonce
handshake) against that fixture, so a drift on either side breaks a test.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

import bridge  # noqa: E402

CONTRACT_PATH = Path(__file__).resolve().parent / "contract.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_contract_fixture_shape():
    assert CONTRACT["version"] == 1
    for section in ("transport", "auth", "routes", "nonce", "sidecarArgv", "speakPayloads", "eventPayloads", "pidfile"):
        assert section in CONTRACT


def test_transport_constants_match_fixture():
    transport = CONTRACT["transport"]
    assert bridge.REQUIRED_CONTENT_TYPE == transport["contentType"] == "application/json"
    assert bridge.MAX_BODY_BYTES == transport["maxBodyBytes"] == 1024 * 1024
    assert bridge.STATUS_UNSUPPORTED_MEDIA_TYPE == transport["unsupportedContentTypeStatus"] == 415
    assert bridge.STATUS_PAYLOAD_TOO_LARGE == transport["payloadTooLargeStatus"] == 413


def test_auth_rule_matches_fixture():
    auth = CONTRACT["auth"]
    assert bridge.AUTH_HEADER == auth["header"]
    assert bridge.AUTH_SCHEME == auth["scheme"]
    assert auth["emptyTokenMeansDisabled"] is True
    assert bridge.TOKEN_DISABLED_VALUE == auth["disabledTokenLiteral"]
    assert tuple(auth["exemptRoutes"]) == bridge.AUTH_EXEMPT_ROUTES

    # Empty token => auth off: a well-formed request is accepted without any header.
    server = bridge.CallbackServer(
        port=0, on_inject=lambda content, session: True, on_send=lambda content, session: True,
        token="", log=lambda _m: None,
    )
    status, body = server.dispatch(
        bridge.SPEAK_ROUTE, {"Content-Type": "application/json"},
        b'{"kind":"inject","sessionId":"s","directive":"hi"}',
    )
    assert status == 200 and body["injected"] is True
    # /health is exempt from auth: GET is not bearer-gated even with a token configured.
    assert bridge.HEALTH_ROUTE in auth["exemptRoutes"]


def test_routes_match_fixture():
    routes = CONTRACT["routes"]
    assert routes["health"]["path"] == bridge.HEALTH_ROUTE
    assert routes["events"]["path"] == bridge.EVENTS_ROUTE
    assert routes["speak"]["path"] == bridge.SPEAK_ROUTE

    posted = {}

    class _Opener:
        def __call__(self, request, timeout=None):
            posted["url"] = request.full_url
            return _Response()

    class _Response:
        status = 200

        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    bridge.forward_event(9999, "", {"type": "user-message", "sessionId": "s"},
                         opener=_Opener(), log=lambda _m: None)
    assert posted["url"] == f"http://127.0.0.1:9999{bridge.EVENTS_ROUTE}"


def test_sidecar_argv_flags_match_fixture():
    assert tuple(CONTRACT["sidecarArgv"]["flags"]) == bridge.SIDECAR_ARGV_FLAGS
    assert CONTRACT["sidecarArgv"]["allOptional"] is True


def test_speak_payload_kinds_match_fixture():
    assert tuple(CONTRACT["speakPayloads"].keys()) == bridge.SUPPORTED_SPEAK_KINDS
    for kind, spec in CONTRACT["speakPayloads"].items():
        assert spec["kind"] == kind
        assert "sessionId" in spec["required"]


def test_event_payload_schema_matches_build_event():
    for event_type, spec in CONTRACT["eventPayloads"].items():
        if event_type == "user-message":
            event = bridge.build_event("pre_llm_call", {"session_id": "s", "user_message": "hi"})
        else:
            event = bridge.build_event("on_session_end", {"session_id": "s"})
        assert event is not None and event["type"] == spec["type"]
        assert set(event.keys()) == set(spec["required"]) | set(spec["optional"])
        for field, field_type in spec["fieldTypes"].items():
            assert field in event
            value = event[field]
            if field_type == "string":
                assert isinstance(value, str)
            elif field_type == "number":
                assert isinstance(value, (int, float))
    assert tuple(CONTRACT["eventPayloads"].keys()) == bridge.SUPPORTED_EVENT_TYPES


def test_nonce_handshake_matches_fixture(monkeypatch):
    nonce_spec = CONTRACT["nonce"]
    assert nonce_spec["perBoot"] is True
    assert nonce_spec["field"] == "nonce"
    assert nonce_spec["healthRoute"] == bridge.HEALTH_ROUTE

    class _Response:
        status = 200

        def __init__(self, body):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    sidecar = bridge.SidecarProcess(["node", "main.js"], 1, nonce="good", log=lambda _m: None)
    assert sidecar.nonce == "good"
    monkeypatch.setattr(bridge.urllib.request, "urlopen",
                        lambda request, timeout=None: _Response(b'{"ok":true,"nonce":"bad"}'))
    assert sidecar.is_healthy() is False
    monkeypatch.setattr(bridge.urllib.request, "urlopen",
                        lambda request, timeout=None: _Response(b'{"ok":true,"nonce":"good"}'))
    assert sidecar.is_healthy() is True


def test_pidfile_and_datadir_fields_match_fixture():
    assert CONTRACT["pidfile"]["filename"] == bridge.PIDFILE_NAME
    assert CONTRACT["pidfile"]["writer"] == "sidecar"
    data_dir = CONTRACT["dataDir"]
    assert data_dir["envOverride"] == "HERMES_HOME"
    assert data_dir["hermesHomeSuffix"] == bridge.DEFAULT_DATA_DIR_NAME
    assert bridge.default_data_dir({"HERMES_HOME": "/srv/hermes"}).endswith(
        bridge.DEFAULT_DATA_DIR_NAME
    )


def test_contract_mirror_is_byte_identical():
    ts_mirror = PLUGIN_DIR.parent.parent / "src" / "hermes-bridge" / "contract.json"
    assert ts_mirror.is_file(), f"missing TS mirror: {ts_mirror}"
    assert ts_mirror.read_bytes() == CONTRACT_PATH.read_bytes()


def test_pidfile_body_format_matches_fixture(tmp_path):
    """The plugin's orphan-recovery read must accept the body the sidecar actually
    writes: the canonical JSON shape named by the contract, plus the legacy forms."""
    body = CONTRACT["pidfile"]["body"]
    assert body["format"] == "json"
    canonical = body["canonicalExample"]

    def read_pid(raw: str):
        pid_file = tmp_path / "sidecar.pid"
        pid_file.write_text(raw, encoding="utf-8")
        sidecar = bridge.SidecarProcess(
            ["node", "main.js"], 8671, log=lambda _m: None, pid_file=str(pid_file),
        )
        return sidecar._read_pidfile()

    assert read_pid(canonical) == 1234
    for legacy in body["legacyTolerated"]:
        assert read_pid(legacy.replace("<pid>", "1234").replace("<nonce>", "abc")) == 1234
    assert read_pid('{"pid": -5, "nonce": "x"}') is None
    assert read_pid('{"pid": "4242", "nonce": "x"}') is None
    assert read_pid("{ not json") is None
    assert read_pid("garbage") is None
    assert read_pid("") is None


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
