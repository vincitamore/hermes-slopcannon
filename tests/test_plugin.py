"""Offline tests: no network, no Hermes required (Hermes paths are stubbed).

Run: python -m unittest discover -s tests -v   (from the plugin root)
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parents[1]

# Never touch a real Hermes home from tests: stand in for hermes_cli.config's secret store.
import types  # noqa: E402

_FAKE_ENV: dict[str, str] = {}
_fake_config = types.ModuleType("hermes_cli.config")
_fake_config.get_env_value = _FAKE_ENV.get
_fake_config.save_env_value = _FAKE_ENV.__setitem__
_fake_config.save_env_value_secure = _FAKE_ENV.__setitem__
_fake_config.remove_env_value = lambda key: _FAKE_ENV.pop(key, None) is not None
_fake_pkg = types.ModuleType("hermes_cli")
_fake_pkg.config = _fake_config
sys.modules["hermes_cli"] = _fake_pkg
sys.modules["hermes_cli.config"] = _fake_config


# Hermes's signed-in request helper and secret route, faked: no test reaches a real auth store.
class ProviderNotSignedIn(RuntimeError):
    pass


class AuthError(RuntimeError):
    def __init__(self, message, *, provider="", code=None, **_):
        super().__init__(message)
        self.provider, self.code = provider, code


class ProviderResponse:
    def __init__(self, status, payload):
        self.status, self._payload = status, payload

    def json(self):
        return self._payload


def _no_sign_in(*_a, **_k):
    raise ProviderNotSignedIn("Not signed in to slop for plugin 'slopcannon' in this Hermes profile. "
                              "Run `hermes auth add slopcannon:slop`.")


_fake_requests = types.ModuleType("hermes_cli.plugin_provider_requests")
_fake_requests.ProviderNotSignedIn = ProviderNotSignedIn
_fake_requests.credentialed_provider_request = _no_sign_in
_fake_auth_constants = types.ModuleType("hermes_cli.auth_constants")
_fake_auth_constants.AuthError = AuthError
sys.modules["hermes_cli.plugin_provider_requests"] = _fake_requests
sys.modules["hermes_cli.auth_constants"] = _fake_auth_constants
_SECRETS: dict[str, str] = {}
_fake_agent = types.ModuleType("agent")
_fake_secret_scope = types.ModuleType("agent.secret_scope")
_fake_secret_scope.get_secret = lambda name, default=None: _SECRETS.get(name, default)
_fake_agent.secret_scope = _fake_secret_scope
sys.modules.setdefault("agent", _fake_agent)
sys.modules["agent.secret_scope"] = _fake_secret_scope

_spec = importlib.util.spec_from_file_location(
    "slopcannon_plugin", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
plugin = importlib.util.module_from_spec(_spec)
sys.modules["slopcannon_plugin"] = plugin
_spec.loader.exec_module(plugin)

from slopcannon_plugin import auth, client as client_mod, gate, server_tools, settings, tools  # noqa: E402
from slopcannon_plugin import production, production_tools  # noqa: E402

ORIGIN = "https://api.slop.cc"


class FakeState:
    def __init__(self):
        self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value


class FakeCtx:
    def __init__(self, config=None):
        self.config = config or {}
        self.state = FakeState()
        self.tools, self.hooks, self.commands, self.cli, self.skills = {}, {}, {}, {}, {}

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools[name] = (toolset, schema, handler)

    def register_hook(self, name, cb):
        self.hooks[name] = cb

    def register_command(self, name, handler, **kw):
        self.commands[name] = handler

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, **kw):
        self.cli[name] = (setup_fn, handler_fn)

    def register_skill(self, name, path, **kw):
        self.skills[name] = path

    def session_surface(self):
        return "desktop"


def bind(config=None):
    ctx = FakeCtx(config)
    settings.bind(ctx)
    return ctx


class RegistrationTest(unittest.TestCase):
    def test_register_wires_every_surface(self):
        ctx = FakeCtx()
        plugin.register(ctx)
        local = {"slopcannon_account", "slopcannon_upload", "slopcannon_wait", "slopcannon_download",
                 "slopcannon_transcribe", "slopcannon_produce", "slopcannon_production_status",
                 "slopcannon_production_stop"}
        server = {t["name"] for t in server_tools.load()}
        self.assertGreaterEqual(len(server), 50)
        self.assertEqual(set(ctx.tools), local | server)
        for must in ("slopcannon_create_quote", "slopcannon_submit_generation", "slopcannon_start_assembly",
                     "slopcannon_create_audio_spot", "slopcannon_list_characters"):
            self.assertIn(must, ctx.tools)
        self.assertTrue(all(t[0] == "slopcannon" for t in ctx.tools.values()))
        for _, schema, _ in ctx.tools.values():
            self.assertEqual(schema["parameters"]["type"], "object")
            self.assertNotIn("$schema", schema["parameters"])
        self.assertIn("pre_tool_call", ctx.hooks)
        self.assertIn("slop", ctx.commands)
        self.assertIn("slopcannon", ctx.cli)
        self.assertEqual(set(ctx.skills), {"hermes-workflow", "slopcannon-music-video"})

    def test_manifest_lists_the_registered_tools(self):
        manifest = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
        for spec in tools.TOOLS:
            self.assertIn(f"  - {spec.name}\n", manifest)

    def test_server_tool_handler_proxies_to_mcp(self):
        bind()
        seen = {}

        def handler(request):
            seen["body"] = json.loads(request.content)
            return rpc({"structuredContent": {"projectId": "p_1"}})
        transport = httpx.MockTransport(handler)
        real = client_mod.Client
        with mock.patch.object(server_tools, "Client",
                               lambda *a, **k: real(origin=ORIGIN, token="slop_live_test", transport=transport)):
            spec = next(s for s in server_tools.specs(set()) if s[0] == "slopcannon_get_project")
            out = json.loads(spec[2]({"projectId": "p_1"}))
        self.assertEqual(out, {"ok": True, "result": {"projectId": "p_1"}})
        self.assertEqual(seen["body"]["params"], {"name": "slopcannon_get_project", "arguments": {"projectId": "p_1"}})

    def test_synced_copy_refreshes_declared_tools_only(self):
        ctx = bind()
        ctx.state.set("server_tools", {"tools": [
            {"name": "slopcannon_get_project", "description": "newer words", "inputSchema": {"type": "object"}},
            {"name": "slopcannon_new_thing", "description": "d", "inputSchema": {"type": "object"}}]})
        specs = {s[0]: s[1] for s in server_tools.specs(set())}
        self.assertEqual(set(specs), {t["name"] for t in server_tools._bundled()})   # a sync never adds or drops a tool
        self.assertEqual(specs["slopcannon_get_project"]["description"], "newer words")

    def test_synced_copy_with_no_declared_tool_falls_back_to_the_snapshot(self):
        ctx = bind()
        ctx.state.set("server_tools", {"tools": [{"name": "slopcannon_new_thing", "description": "d",
                                                   "inputSchema": {"type": "object"}}]})
        self.assertIn("slopcannon_get_project", [s[0] for s in server_tools.specs(set())])


class SettingsTest(unittest.TestCase):
    def test_origin_validation(self):
        self.assertEqual(settings.validated_origin("https://api.slop.cc/"), ORIGIN)
        self.assertEqual(settings.validated_origin("http://127.0.0.1:3000"), "http://127.0.0.1:3000")
        for bad in ("http://api.slop.cc", "https://api.slop.cc/v1", "https://u:p@api.slop.cc",
                    "https://api.slop.cc?x=1", "ftp://api.slop.cc", ""):
            with self.assertRaises(ValueError, msg=bad):
                settings.validated_origin(bad)

    def test_defaults_without_hermes(self):
        settings.bind(None)
        self.assertEqual(settings.api_origin(), ORIGIN)
        bind({"api_origin": "http://localhost:8787"})
        self.assertEqual(settings.api_origin(), "http://localhost:8787")


SUBMIT = "slopcannon_submit_generation"


def submit_args(amount=40, **extra):
    return {"schemaVersion": "1.0", "quoteId": "q_123",
            "approval": {"amountUnits": amount, "currency": "CANNON_CREDIT", "creditUnit": "cannon-credit"},
            "idempotencyKey": "k" * 20, **extra}


class GateTest(unittest.TestCase):
    def setUp(self):
        bind()
        patcher = mock.patch.object(gate, "_approvals_bypassed", return_value=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        offline = mock.patch.object(client_mod.Client, "rights_policy", return_value={})
        offline.start()
        self.addCleanup(offline.stop)

    def test_production_files_are_only_reached_through_the_tools(self):
        home = r"C:\Users\x\AppData\Local\hermes\profiles\demo"
        for tool, args in (
            ("terminal", {"command": f'cat "{home}\\plugin-data\\slopcannon\\productions\\film\\ledger.json"'}),
            ("write_file", {"path": "/home/x/.hermes/plugin-data/slopcannon/productions/film/ledger.json",
                            "content": "{}"}),
            ("execute_code", {"code": f"open(r'{home}\\plugins\\slopcannon\\production.py')"}),
        ):
            d = gate.pre_tool_call(tool, args)
            self.assertEqual(d["action"], "block", tool)
            self.assertIn("slopcannon_production_status", d["message"])
        self.assertIsNone(gate.pre_tool_call("terminal", {"command": "ls ~/Documents/slopcannon-demo-film"}))
        bind({"protect_production_files": False})
        self.assertIsNone(gate.pre_tool_call("terminal", {"command": f"ls {home}/plugin-data/slopcannon"}))

    def test_paid_submission_goes_to_the_human_gate_with_the_amount(self):
        d = gate.pre_tool_call(SUBMIT, submit_args(56))
        self.assertEqual(d["action"], "approve")
        self.assertIn("56 Cannon Credits", d["message"])
        self.assertIn("q_123", d["message"])
        self.assertTrue(d["rule_key"].startswith("slopcannon:slopcannon_submit_generation:"))

    def test_rule_key_differs_per_quote(self):
        a = gate.pre_tool_call(SUBMIT, submit_args(40))["rule_key"]
        b = gate.pre_tool_call(SUBMIT, submit_args(48))["rule_key"]
        self.assertNotEqual(a, b)

    def test_missing_or_bogus_amount_is_blocked(self):
        args = submit_args()
        del args["approval"]
        self.assertEqual(gate.pre_tool_call(SUBMIT, args)["action"], "block")
        self.assertEqual(gate.pre_tool_call(SUBMIT, submit_args("40"))["action"], "block")
        self.assertEqual(gate.pre_tool_call(SUBMIT, submit_args(True))["action"], "block")

    def test_ceiling_blocks_before_prompt(self):
        bind({"max_credits_per_action": 100})
        self.assertEqual(gate.pre_tool_call(SUBMIT, submit_args(100))["action"], "approve")
        self.assertEqual(gate.pre_tool_call(SUBMIT, submit_args(101))["action"], "block")

    def test_unattended_spend_needs_an_allowance(self):
        with mock.patch.object(gate, "_approvals_bypassed", return_value=True):
            self.assertEqual(gate.pre_tool_call(SUBMIT, submit_args(40))["action"], "block")
            bind({"unattended_max_credits": 48})
            self.assertIsNone(gate.pre_tool_call(SUBMIT, submit_args(40)))
            self.assertEqual(gate.pre_tool_call(SUBMIT, submit_args(56))["action"], "block")

    def test_mcp_catalog_tools_are_gated_too(self):
        d = gate.pre_tool_call("mcp_slopcannon_slopcannon_submit_generation", submit_args(40))
        self.assertEqual(d["action"], "approve")

    def test_audio_spot_combines_spend_and_rights(self):
        d = gate.pre_tool_call("slopcannon_create_audio_spot", {
            "maxCredits": 30, "lengthS": 30, "rightsAttestationVersion": "rights-v1"})
        self.assertEqual(d["action"], "approve")
        self.assertIn("30 Cannon Credits", d["message"])
        self.assertIn("rights-v1", d["message"])

    def test_reads_pass_and_destructive_asks(self):
        self.assertIsNone(gate.pre_tool_call("slopcannon_get_workspace", {"projectId": "p"}))
        self.assertIsNone(gate.pre_tool_call("slopcannon_account", {}))
        self.assertIsNone(gate.pre_tool_call("terminal", {"command": "ls"}))
        d = gate.pre_tool_call("slopcannon_delete_take", {"take": 1})
        self.assertEqual(d["action"], "approve")

    def test_upload_asks_for_rights_with_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "song.mp3"
            song.write_bytes(b"x" * 10)
            d = gate.pre_tool_call("slopcannon_upload", {"path": str(song), "kind": "song",
                                                          "rights_version": "rights-v1"})
        self.assertEqual(d["action"], "approve")
        self.assertIn("song.mp3 (10 bytes)", d["message"])

    def test_gate_bug_fails_closed_for_spend(self):
        with mock.patch.object(gate, "_spend_directive", side_effect=RuntimeError("boom")):
            self.assertEqual(gate.pre_tool_call(SUBMIT, submit_args())["action"], "block")


def make_client(handler):
    return client_mod.Client(origin=ORIGIN, token="slop_live_test", transport=httpx.MockTransport(handler))


def rpc(result=None, error=None):
    body = {"jsonrpc": "2.0", "id": "1", **({"error": error} if error else {"result": result})}
    return httpx.Response(200, json=body)


class ClientTest(unittest.TestCase):
    def setUp(self):
        bind()

    def test_token_never_goes_to_another_origin(self):
        seen = []
        c = make_client(lambda r: seen.append(r) or httpx.Response(200, json={}))
        with self.assertRaises(client_mod.SlopcannonError) as err:
            c.get_json("https://evil.example/v1/x")
        self.assertEqual(err.exception.code, "foreign_origin")
        self.assertEqual(seen, [])

    def test_redirect_is_refused(self):
        c = make_client(lambda r: httpx.Response(302, headers={"location": "https://evil.example"}))
        with self.assertRaises(client_mod.SlopcannonError) as err:
            c.get_json("/v1/billing/balance")
        self.assertEqual(err.exception.code, "unexpected_redirect")

    def test_not_connected(self):
        auth.reset()
        c = client_mod.Client(origin=ORIGIN, transport=httpx.MockTransport(lambda r: httpx.Response(200)))
        with mock.patch.dict(_SECRETS, {}, clear=True):
            with self.assertRaises(client_mod.NotConnected) as err:
                c.balance()
        self.assertIn("hermes auth add slopcannon:slop", str(err.exception))

    def test_tool_call_json_and_sse(self):
        def handler(request):
            body = json.loads(request.content)
            self.assertEqual(request.url.path, "/api/mcp")
            self.assertEqual(request.headers["authorization"], "Bearer slop_live_test")
            self.assertEqual(body["method"], "tools/call")
            if body["params"]["name"] == "a":
                return rpc({"structuredContent": {"status": "queued"}})
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  text='event: message\ndata: {"jsonrpc":"2.0","id":"1","result":'
                                       '{"content":[{"type":"text","text":"{\\"x\\":1}"}]}}\n\n')
        c = make_client(handler)
        self.assertEqual(c.call_tool("a"), {"status": "queued"})
        self.assertEqual(c.call_tool("b"), {"x": 1})

    def test_tool_error_carries_server_code(self):
        c = make_client(lambda r: rpc({"isError": True, "structuredContent": {"error": {
            "code": "quote_expired", "message": "Quote expired"}}}))
        with self.assertRaises(client_mod.SlopcannonError) as err:
            c.call_tool("slopcannon_submit_generation", {})
        self.assertEqual(err.exception.code, "quote_expired")

    def test_upload_sends_rights_digest_and_key(self):
        captured = {}

        def handler(request):
            captured["req"] = request
            return httpx.Response(201, json={"id": "asset_1"})
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "song.mp3"
            song.write_bytes(b"abc")
            out = make_client(handler).upload_asset(path=song, project_id="p_12345678", kind="song",
                                                    content_type="audio/mpeg", rights_version="rights-v1",
                                                    idempotency_key="key-1", duration_ms=9000)
        req = captured["req"]
        self.assertEqual(out, {"id": "asset_1"})
        self.assertEqual(req.url.path, "/v1/assets")
        self.assertEqual(req.url.params["kind"], "song")
        self.assertEqual(req.headers["x-slopcannon-rights-attestation"], "rights-v1")
        self.assertEqual(req.headers["x-content-sha256"],
                         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        self.assertEqual(req.headers["idempotency-key"], "key-1")
        self.assertEqual(req.headers["x-media-duration-ms"], "9000")

    def test_capability_link_download_carries_no_token(self):
        seen = {}

        def handler(request):
            seen["auth"] = request.headers.get("authorization")
            return httpx.Response(200, content=b"mp4bytes")
        with tempfile.TemporaryDirectory() as tmp:
            out = make_client(handler).download("https://cdn.slop.cc/x.mp4", Path(tmp) / "a.mp4")
            self.assertEqual(Path(out["path"]).read_bytes(), b"mp4bytes")
        self.assertIsNone(seen["auth"])


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        bind({"download_dir": self.tmp.name})

    def run_tool(self, name, args, handler):
        transport = httpx.MockTransport(handler)
        real = client_mod.Client

        def factory(*a, **kw):
            return real(origin=ORIGIN, token="slop_live_test", transport=transport)
        spec = next(t for t in tools.TOOLS if t.name == name)
        with mock.patch.object(tools, "Client", factory), mock.patch.object(tools.time, "sleep"):
            return json.loads(spec.handler(args))

    def test_wait_downloads_and_returns_media_lines(self):
        calls = {"n": 0}

        def handler(request):
            if request.url.path == "/api/mcp":
                calls["n"] += 1
                status = "running" if calls["n"] == 1 else "succeeded"
                return rpc({"structuredContent": {"generation": {"id": "g1", "status": status}}})
            if request.url.path == "/v1/generations/g1/content":
                return httpx.Response(200, json={"artifacts": [{"downloadUrl": f"{ORIGIN}/v1/generations/g1/download"}]})
            if request.url.path == "/v1/generations/g1/download":
                return httpx.Response(200, content=b"clip")
            return httpx.Response(404)
        out = self.run_tool("slopcannon_wait", {"generation_ids": ["g1"], "project_id": "p1"}, handler)
        self.assertTrue(out["ok"])
        self.assertEqual(out["still_running"], [])
        self.assertEqual(len(out["media"]), 1)
        self.assertTrue(out["media"][0].startswith("MEDIA:"))
        self.assertTrue(out["media"][0].endswith("/p1/g1.mp4"))

    def test_upload_without_rights_returns_the_statement(self):
        def handler(request):
            if request.url.path == "/v1/rights-attestation":
                return httpx.Response(200, json={"data": {"requiredVersion": "rights-v1", "statement": "I confirm"}})
            return httpx.Response(500)
        song = Path(self.tmp.name) / "s.mp3"
        song.write_bytes(b"1")
        out = self.run_tool("slopcannon_upload", {"path": str(song), "project_id": "p1", "kind": "song",
                                                  "rights_version": "old"}, handler)
        self.assertEqual(out["error"], "rights_required")
        self.assertEqual(out["requiredVersion"], "rights-v1")



class AuthTest(unittest.TestCase):
    def test_status_is_aligned_rows_without_raw_json(self):
        from slopcannon_plugin import commands

        bind()
        transport = httpx.MockTransport(lambda r: httpx.Response(200, json=(
            {"data": {"availableCredits": 4430, "reservedCredits": 56}} if r.url.path == "/v1/billing/balance"
            else {"hostedRuntime": {"status": "available", "submissionReady": True}})))
        real = client_mod.Client
        with mock.patch.object(commands, "Client", lambda *a, **k: real(origin=ORIGIN, token="t", transport=transport)), \
                mock.patch.object(auth, "token_summary", return_value={
                    "connected": True, "via": auth.VIA_SIGN_IN, "expires_at": 1_900_000_000, "scopes": None}):
            text = commands.slash("status")
        lines = text.splitlines()
        self.assertEqual(lines[0], "SLOPCANNON")
        self.assertIn("connected · Hermes sign-in · session until", text)
        self.assertIn("4,430 available · 56 held for running work", text)
        self.assertIn("available · rendering open", text)
        self.assertNotIn("{", text)
        self.assertNotIn("slop_live", text)
        self.assertEqual(len({line.index(line.split()[1]) for line in lines[1:]}), 1)  # one value column


def session_payload(token="slop_live_session_a", ttl_s=7200, scopes=("projects:read", "billing:read")):
    now_ms = int(__import__("time").time() * 1000)
    return {"data": {"object": "agent_session", "id": "tok_x", "token": token, "tokenType": "Bearer",
                     "name": "Hermes - SLOPCANNON plugin", "scopes": list(scopes),
                     "expiresAt": now_ms + ttl_s * 1000, "expiresIn": ttl_s, "createdAt": now_ms},
            "requestId": "req_1"}


class SessionTest(unittest.TestCase):
    """Credentials come from Hermes: a minted session (memory only) or the personal token."""

    def setUp(self):
        self.ctx = bind()
        auth.reset()
        auth.set_session_ttl(auth.SESSION_TTL_S)
        self.addCleanup(auth.reset)
        self.calls = []
        self.responses = []
        self.secrets = mock.patch.dict(_SECRETS, {}, clear=True)
        self.secrets.start()
        self.addCleanup(self.secrets.stop)
        self.env_before = dict(_FAKE_ENV)
        self.process_env_before = os.environ.get(settings.TOKEN_ENV)

    def helper(self, *responses):
        self.responses = list(responses)

        def fake(provider, method, url, *, json=None, headers=None, timeout=30.0):
            self.calls.append({"provider": provider, "method": method, "url": url, "json": json, "timeout": timeout})
            if not self.responses:
                raise AssertionError("unexpected sign-in request")
            item = self.responses.pop(0)
            if isinstance(item, BaseException):
                raise item
            return item
        patch = mock.patch.object(_fake_requests, "credentialed_provider_request", fake)
        patch.start()
        self.addCleanup(patch.stop)

    def assert_nothing_stored(self):
        self.assertEqual(_FAKE_ENV, self.env_before)  # no .env write
        self.assertEqual(self.ctx.state.data, {})  # no plugin-state write
        self.assertTrue(os.environ.get(settings.TOKEN_ENV) == self.process_env_before)  # no process-env write

    def test_mints_through_hermes_and_caches_in_memory(self):
        self.helper(ProviderResponse(201, session_payload()))
        first = auth.credential()
        second = auth.credential()
        self.assertEqual(first.token, "slop_live_session_a")
        self.assertIs(first, second)
        self.assertEqual(len(self.calls), 1)
        call = self.calls[0]
        self.assertEqual((call["provider"], call["method"], call["url"]),
                         ("slop", "POST", "https://api.slop.cc/v1/agent-sessions"))
        self.assertEqual(call["json"]["ttlSeconds"], 7200)
        self.assertNotIn("scopes", call["json"])  # the parent's scopes minus billing:purchase
        self.assertTrue(1 <= len(call["json"]["name"]) <= 60)
        self.assertEqual(call["timeout"], 20)
        self.assertEqual(first.via, auth.VIA_SIGN_IN)
        self.assertNotIn("slop_live", repr(first))
        self.assert_nothing_stored()

    def test_remints_when_less_than_ten_minutes_remain(self):
        self.helper(ProviderResponse(201, session_payload("slop_live_short", ttl_s=300)),
                    ProviderResponse(201, session_payload("slop_live_next")))
        self.assertEqual(auth.get_token(), "slop_live_short")
        self.assertEqual(auth.get_token(), "slop_live_next")
        self.assertEqual(auth.get_token(), "slop_live_next")
        self.assertEqual(len(self.calls), 2)

    def test_a_401_remints_and_retries_once(self):
        self.helper(ProviderResponse(201, session_payload("slop_live_old")),
                    ProviderResponse(201, session_payload("slop_live_new")))
        seen = []

        def api(request):
            seen.append(request.headers["authorization"])
            if request.headers["authorization"] == "Bearer slop_live_old":
                return httpx.Response(401, json={"error": {"code": "INVALID_API_TOKEN", "message": "expired"}})
            return httpx.Response(200, json={"data": {"availableCredits": 7}})
        c = client_mod.Client(origin=ORIGIN, transport=httpx.MockTransport(api))
        self.assertEqual(c.balance(), {"availableCredits": 7})
        self.assertEqual(seen, ["Bearer slop_live_old", "Bearer slop_live_new"])
        self.assertEqual(len(self.calls), 2)

    def test_a_second_401_is_not_retried_again(self):
        self.helper(ProviderResponse(201, session_payload("slop_live_a")),
                    ProviderResponse(201, session_payload("slop_live_b")))
        seen = []
        c = client_mod.Client(origin=ORIGIN, transport=httpx.MockTransport(
            lambda r: seen.append(1) or httpx.Response(401, json={"error": {"code": "INVALID_API_TOKEN"}})))
        with self.assertRaises(client_mod.SlopcannonError) as err:
            c.balance()
        self.assertEqual(err.exception.status, 401)
        self.assertEqual(len(seen), 2)

    def test_mcp_401_also_remints(self):
        self.helper(ProviderResponse(201, session_payload("slop_live_old")),
                    ProviderResponse(201, session_payload("slop_live_new")))

        def api(request):
            if request.headers["authorization"] == "Bearer slop_live_old":
                return httpx.Response(401, json={"error": "invalid_token"})
            return rpc({"structuredContent": {"ok": 1}})
        c = client_mod.Client(origin=ORIGIN, transport=httpx.MockTransport(api))
        self.assertEqual(c.call_tool("get_workspace"), {"ok": 1})

    def test_not_signed_in_names_the_hermes_command(self):
        self.helper(ProviderNotSignedIn("Not signed in to slop for plugin 'slopcannon' in this Hermes profile. "
                                        "Run `hermes auth add slopcannon:slop`."))
        with self.assertRaises(auth.NotSignedIn) as err:
            auth.credential()
        self.assertIn("hermes auth add slopcannon:slop", str(err.exception))
        self.assertIn("terminal", str(err.exception))
        self.assertIn("Agent token", str(err.exception))
        self.assert_nothing_stored()

    def test_not_signed_in_status_is_truthful(self):
        self.helper(ProviderNotSignedIn("Run `hermes auth add slopcannon:slop`."))
        summary = auth.token_summary()
        self.assertFalse(summary["connected"])
        self.assertIsNone(summary["via"])
        self.assertEqual(summary["sign_in"], "hermes auth add slopcannon:slop")

    def test_auth_errors_are_explained(self):
        self.helper(AuthError("slopcannon:slop: SLOPCANNON_OAUTH_CLIENT_ID is not set.",
                              code="oauth_client_id_missing"))
        with self.assertRaises(auth.CredentialError) as err:
            auth.credential()
        self.assertEqual(err.exception.code, "oauth_client_id_missing")
        self.assertIn("SLOPCANNON_OAUTH_CLIENT_ID", str(err.exception))
        self.assertIn("hermes-agent", str(err.exception))
        self.helper(AuthError("refused", code="invalid_client"))
        c = client_mod.Client(origin=ORIGIN, transport=httpx.MockTransport(lambda r: httpx.Response(200)))
        with self.assertRaises(client_mod.SlopcannonError) as err2:
            c.balance()
        self.assertEqual(err2.exception.code, "invalid_client")
        self.assertNotIsInstance(err2.exception, client_mod.NotConnected)

    def test_server_refusals_map_to_codes(self):
        self.helper(ProviderResponse(429, {"error": {"code": "AGENT_SESSION_RATE_LIMITED", "message": "x"}}),
                    ProviderResponse(503, {"error": {"code": "AGENT_SESSIONS_UNAVAILABLE", "message": "x"}}),
                    ProviderResponse(401, {"error": {"code": "INVALID_API_TOKEN", "message": "x"}}))
        with self.assertRaises(auth.CredentialError) as err:
            auth.credential()
        self.assertEqual(err.exception.code, "agent_session_rate_limited")
        with self.assertRaises(auth.CredentialError) as err:
            auth.credential(fresh=True)
        self.assertEqual(err.exception.code, "agent_sessions_unavailable")
        with self.assertRaises(auth.NotSignedIn):  # the grant was revoked at slop.cc
            auth.credential(fresh=True)

    def test_personal_token_when_not_signed_in(self):
        self.helper(ProviderNotSignedIn("Run `hermes auth add slopcannon:slop`."),
                    ProviderNotSignedIn("Run `hermes auth add slopcannon:slop`."))
        _SECRETS[settings.TOKEN_ENV] = "slop_live_personal"
        cred = auth.credential()
        self.assertEqual((cred.token, cred.via, cred.session), ("slop_live_personal", auth.VIA_PERSONAL, False))
        summary = auth.token_summary()
        self.assertTrue(summary["connected"])
        self.assertEqual(summary["via"], "personal token")
        self.assertNotIn("slop_live", json.dumps(summary))
        self.assert_nothing_stored()

    def test_custom_origin_uses_the_personal_token_and_never_the_sign_in(self):
        self.ctx = bind({"api_origin": "http://127.0.0.1:8787"})
        self.helper()  # any call would pop from an empty list and fail
        _SECRETS[settings.TOKEN_ENV] = "slop_live_local"
        self.assertEqual(auth.get_token(), "slop_live_local")
        self.assertEqual(self.calls, [])
        _SECRETS.clear()
        with self.assertRaises(auth.NotSignedIn) as err:
            auth.credential()
        self.assertIn("personal token", str(err.exception))
        self.assertEqual(self.calls, [])

    def test_driver_gets_its_own_twelve_hour_session(self):
        self.helper(ProviderResponse(201, session_payload("slop_live_driver", ttl_s=43200)),
                    ProviderResponse(201, session_payload("slop_live_inproc")))
        cred = auth.driver_token("film-1")
        self.assertEqual(cred.token, "slop_live_driver")
        self.assertEqual(self.calls[0]["json"]["ttlSeconds"], 43200)
        self.assertIn("film-1", self.calls[0]["json"]["name"])
        self.assertEqual(auth.get_token(), "slop_live_inproc")  # never the cached in-process session
        self.assert_nothing_stored()

    def test_driver_with_a_personal_token_gets_a_session_minted_from_it(self):
        self.helper(ProviderNotSignedIn("Run `hermes auth add slopcannon:slop`."))
        _SECRETS[settings.TOKEN_ENV] = "slop_live_personal"
        minted = auth.Credential(token="slop_live_child", via=auth.VIA_PERSONAL, expires_at=1.0, session=True)
        with mock.patch.object(auth, "_mint_with_personal", return_value=minted) as mint:
            self.assertEqual(auth.driver_token("film-2").token, "slop_live_child")
        self.assertEqual(mint.call_args.args[0], "slop_live_personal")
        self.assertEqual(mint.call_args.args[1], auth.DRIVER_TTL_S)
        self.helper(ProviderNotSignedIn("x"))
        with mock.patch.object(auth, "_mint_with_personal", side_effect=auth.CredentialError("down", "http_503")):
            with self.assertRaises(auth.CredentialError):  # never the raw personal token on slop.cc
                auth.driver_token("film-2")

    def test_cli_sessions_are_short(self):
        self.helper(ProviderResponse(201, session_payload()))
        auth.set_session_ttl(900)
        auth.credential()
        self.assertEqual(self.calls[0]["json"]["ttlSeconds"], 900)

    def test_auth_module_runs_no_flow_and_touches_no_store(self):
        source = (ROOT / "auth.py").read_text(encoding="utf-8")
        for banned in ("webbrowser", "http.server", "save_env", "remove_env", "get_env_value", "os.environ",
                       "register_client", "code_verifier", "/api/oauth/token", "state_set", "open("):
            self.assertNotIn(banned, source, banned)


class LoginCommandTest(unittest.TestCase):
    def setUp(self):
        bind()

    def test_login_shows_the_hermes_command_and_starts_nothing(self):
        from slopcannon_plugin import commands

        with mock.patch.object(_fake_requests, "credentialed_provider_request",
                               side_effect=AssertionError("login must not mint")):
            text = commands.slash("login")
        self.assertIn("hermes auth add slopcannon:slop", text)
        self.assertIn("hermes config set SLOPCANNON_OAUTH_CLIENT_ID hermes-agent", text)
        self.assertIn("terminal", text)
        self.assertIn("Agent token", text)
        self.assertNotIn("slop_live", text)

    def test_logout_points_at_hermes_and_drops_the_memory_session(self):
        from slopcannon_plugin import commands

        with mock.patch.object(auth, "reset") as reset:
            text = commands.slash("logout")
        reset.assert_called_once()
        self.assertIn("hermes auth logout slopcannon:slop", text)

    def test_cli_has_no_paste_path(self):
        import argparse
        from slopcannon_plugin import commands

        parser = argparse.ArgumentParser()
        commands.setup_cli(parser)
        with self.assertRaises(SystemExit), mock.patch("sys.stderr", io.StringIO()):
            parser.parse_args(["login", "--token-stdin"])
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            self.assertEqual(commands.run_cli(parser.parse_args(["login"])), 0)
        self.assertIn("hermes auth add slopcannon:slop", out.getvalue())

    def test_manifest_oauth_entry_matches_the_plugin(self):
        import yaml

        manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text(encoding="utf-8"))
        (entry,) = manifest["oauth"]
        self.assertEqual(entry["id"], auth.OAUTH_ID)
        self.assertEqual(entry["scopes"], auth.DEFAULT_SCOPES.split())
        self.assertNotIn("billing:purchase", entry["scopes"])
        self.assertEqual(entry["client_id_env"], auth.CLIENT_ID_ENV)
        self.assertEqual(entry["hosts"], ["api.slop.cc"])
        self.assertEqual(manifest["name"], auth.PLUGIN_KEY)
        self.assertIn(auth.CLIENT_ID_ENV, [e["name"] for e in manifest.get("optional_env") or []])
        self.assertNotIn("requires_env", manifest)  # nothing gates loading for personal-token users


class CheckRowTest(unittest.TestCase):
    def test_verdict_passes_through(self):
        row = production._check_row({"shotCheck": {"verdict": "fail", "issues": [{"description": "x"}]}})
        self.assertEqual(row, {"verdict": "fail", "issues": [{"description": "x"}]})

    def test_check_that_could_not_run_reads_unchecked_with_its_reason(self):
        entry = {"artifact": {"assetId": "take-2"},
                 "shotCheckError": {"assetId": "take-2", "code": "SHOT_CHECK_PROVIDER_REJECTED",
                                    "message": "The check model refused this take.", "retryable": False}}
        row = production._check_row(entry)
        self.assertEqual(row["verdict"], "unchecked")
        self.assertEqual(row["error"]["message"], "The check model refused this take.")
        self.assertFalse(row["error"]["retryable"])

    def test_error_from_an_earlier_take_is_ignored(self):
        entry = {"artifact": {"assetId": "take-2"}, "shotCheckError": {"assetId": "take-1", "message": "old"}}
        self.assertIsNone(production._check_row(entry))

class BroadcastTest(unittest.TestCase):
    def test_skipped_outside_the_gateway_process(self):
        events = types.ModuleType("hermes_cli.plugin_events")
        events.broadcast_plugin_event = mock.Mock()
        with mock.patch.dict(sys.modules, {"hermes_cli.plugin_events": events}):
            sys.modules.pop("tui_gateway.server", None)
            production._broadcast("production.updated", {"id": "x"})
        events.broadcast_plugin_event.assert_not_called()

    def test_sent_inside_the_gateway_process(self):
        events = types.ModuleType("hermes_cli.plugin_events")
        events.broadcast_plugin_event = mock.Mock()
        with mock.patch.dict(sys.modules, {"tui_gateway.server": types.ModuleType("tui_gateway.server"),
                                           "hermes_cli.plugin_events": events}):
            production._broadcast("production.updated", {"id": "x"})
        events.broadcast_plugin_event.assert_called_once_with("slopcannon", "production.updated", {"id": "x"})

if __name__ == "__main__":
    unittest.main()


# --------------------------------------------------------------------------- productions

FAKE_DRIVER = r"""
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const ledgerFile = flag("--ledger");
const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : { scenes: {} };
const out = (value, code) => { process.stdout.write(JSON.stringify(value) + "\n"); process.exitCode = code; };
if (process.env.SLOPCANNON_AGENT_TOKEN !== "slop_live_test") { out({ ok: false, needs: "origin", message: "no token" }, 2); }
else if (args[0] === "reroll") {
  const root = flag("--scene"), take = root + ".r1", price = root === "sc01" ? 44 : 50;
  const log = path.join(path.dirname(ledgerFile), "reroll-calls.log");
  writeFileSync(log, (existsSync(log) ? readFileSync(log, "utf8") : "") + [root, flag("--approve-units"), flag("--max-credits"), flag("--wait")].join(" ") + "\n");
  const expire = path.join(path.dirname(ledgerFile), "expire-once");
  if (flag("--approve-units") && existsSync(expire)) {  // the approved quote expired: quoted again
    unlinkSync(expire);
    out({ ok: false, needs: "approval", scene: take, rerollOf: root, quoteId: "q2-" + root, amountUnits: price }, 2);
  } else if (!flag("--approve-units")) {
    ledger.scenes[take] = { rerollOf: root, quote: { id: "q-" + root, amountUnits: price } };
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    out({ ok: false, needs: "approval", scene: take, rerollOf: root, quoteId: "q-" + root, amountUnits: price }, 2);
  } else if (Number(flag("--approve-units")) !== price) { out({ ok: false, error: "bad approval" }, 1); }
  else if (flag("--wait") === "no") {
    ledger.scenes[take].generation = { id: "gen-" + take, status: "queued" };
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    out({ ok: true, submitted: true, scene: take, rerollOf: root, status: "queued" }, 0);
  } else {
    const clip = path.join(path.dirname(ledgerFile), "work", "clips", take + ".mp4"); writeFileSync(clip, "mp4");
    ledger.scenes[take].generation = { id: "gen-" + take, status: "succeeded" };
    ledger.scenes[take].downloaded = { path: clip, sha256: "b".repeat(64), bytes: 3 };
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    out({ ok: true, scene: take, rerollOf: root, path: clip, check: { verdict: "pass" } }, 0);
  }
}
else if (args[0] === "cut") {
  const master = flag("--output"); writeFileSync(master, "cut " + flag("--takes")); out({ ok: true, output: master, cut: "c1" }, 0);
}
else if (flag("--rights-accepted") !== "v1") {
  out({ ok: false, needs: "rights", requiredVersion: "v1", statement: "I own it.", files: [{ file: "/x/song.mp3", bytes: 10, role: "master" }] }, 2);
} else if (!flag("--max-credits")) {
  ledger.scenes.production = { projectId: "proj_1" };
  ledger.scenes.sc01 = { quote: { id: "q1", amountUnits: 40, currency: "CANNON_CREDIT", creditUnit: "cannon-credit" } };
  ledger.scenes.sc02 = { quote: { id: "q2", amountUnits: 56, currency: "CANNON_CREDIT", creditUnit: "cannon-credit" } };
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  out({ ok: false, needs: "approval", quotes: [{ scene: "sc01", amountUnits: 40 }, { scene: "sc02", amountUnits: 56 }], totalCannonCredits: 96 }, 2);
} else if (JSON.parse(readFileSync(flag("--production"), "utf8")).continuity === "chain") {
  // chain continuity: one scene at a time, each kept (by its bytes) before the next is bought
  const log = path.join(path.dirname(ledgerFile), "chain-calls.log");
  writeFileSync(log, (existsSync(log) ? readFileSync(log, "utf8") : "") + [flag("--max-credits"), flag("--reviewed"), flag("--takes")].join(" ") + "\n");
  const clips = path.join(path.dirname(ledgerFile), "work", "clips"); mkdirSync(clips, { recursive: true });
  const reviewed = (flag("--reviewed") || "").split(",");
  const takes = Object.fromEntries((flag("--takes") || "").split(",").filter(Boolean).map((p) => p.split("=")));
  let stopped = false;
  for (const [i, id] of ["sc01", "sc02"].entries()) {
    const take = takes[id] || id;
    const entry = ledger.scenes[take];
    if (!entry.downloaded) {
      const clip = path.join(clips, take + ".mp4"); writeFileSync(clip, "mp4");
      entry.generation = { id: "gen_" + take, key: "k" + take, status: "succeeded", submission: { approval: { amountUnits: entry.quote.amountUnits, currency: "CANNON_CREDIT", creditUnit: "cannon-credit" } } };
      entry.downloaded = { path: clip, sha256: (i ? "c" : "a").repeat(64), bytes: 3 };
    }
    writeFileSync(ledgerFile, JSON.stringify(ledger));
    if (!reviewed.includes(entry.downloaded.sha256)) {
      out({ ok: false, needs: "scene_review", scene: id, take, index: i + 1, total: 2, next: i ? null : "sc02", continuesFrom: i ? (takes.sc01 || "sc01") : null,
            sha256: entry.downloaded.sha256, artifact: entry.downloaded, shotCheck: { scene: take, verdict: "pass", issues: [] } }, 2);
      stopped = true; break;
    }
  }
  if (!stopped) {
    const master = path.join(path.dirname(ledgerFile), "work", "Film.mp4"); writeFileSync(master, "chain " + (flag("--takes") || ""));
    out({ ok: true, output: master, report: { ok: true, output: master, syncVerified: true } }, 0);
  }
} else {
  const clips = path.join(path.dirname(ledgerFile), "work", "clips"); mkdirSync(clips, { recursive: true });
  const master = path.join(path.dirname(ledgerFile), "work", "Film.mp4"); writeFileSync(master, "mp4");
  for (const id of ["sc01", "sc02"]) {
    const clip = path.join(clips, id + ".mp4"); writeFileSync(clip, "mp4");
    ledger.scenes[id].generation = { id: "gen_" + id, key: "k" + id, status: "succeeded", submission: { approval: { amountUnits: ledger.scenes[id].quote.amountUnits, currency: "CANNON_CREDIT", creditUnit: "cannon-credit" } } };
    ledger.scenes[id].downloaded = { path: clip, sha256: "a".repeat(64), bytes: 3 };
  }
  writeFileSync(ledgerFile, JSON.stringify(ledger));
  out({ ok: true, output: master, report: { ok: true, output: master, syncVerified: true }, steps: [{ step: "assemble", ok: true }] }, 0);
}
"""


class ProductionTest(unittest.TestCase):
    def setUp(self):
        bind()
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / "productions"
        self.root.mkdir()
        self.song = base / "song.mp3"
        self.song.write_bytes(b"ID3song")
        self.transcript = base / "song.words.json"
        self.transcript.write_text('{"segments": []}', encoding="utf-8")
        driver = base / "fake-driver.mjs"
        driver.write_text(FAKE_DRIVER, encoding="utf-8")
        self.patches = [
            mock.patch.object(production, "root", lambda: self.root),
            mock.patch.object(production, "DRIVER", driver),
            mock.patch.object(production, "_broadcast", lambda *a, **k: None),
            mock.patch.object(client_mod.Client, "rights_policy", return_value={}),
            mock.patch.object(production.auth, "driver_token",
                              lambda pid: auth.Credential(token="slop_live_test", via=auth.VIA_PERSONAL)),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def spec(self, **extra):
        return {"title": "Film", "song": str(self.song), "transcript": str(self.transcript),
                "scenes": [{"shot": "LEAD sings", "cast": ["LEAD"]}], **extra}

    def produce(self, **args):
        return json.loads(production_tools.PRODUCE.handler({"wait_s": 30, **args}))

    @unittest.skipUnless(production.node_status()["ok"], "Node.js 22.13+ not installed")
    def test_gates_then_finishes_with_master_media(self):
        first = self.produce(production=self.spec(approve=999, maxCredits=999))
        self.assertTrue(first["ok"], first)
        pid = first["production"]["id"]
        self.assertEqual(first["production"]["needs"], "rights")
        self.assertEqual(first["production"]["needsDetail"]["requiredVersion"], "v1")
        self.assertIn("rights_version", first["next"])  # the chat path, after the card
        self.assertEqual(first["card"], f'::slopcannon-film{{id="{pid}"}}')
        stored = json.loads((self.root / pid / "production.json").read_text(encoding="utf-8"))
        self.assertNotIn("approve", stored)  # gate answers never ride the production file
        self.assertNotIn("maxCredits", stored)

        quoted = self.produce(production_id=pid, rights_version="v1")
        self.assertEqual(quoted["production"]["needs"], "approval")
        self.assertEqual(quoted["production"]["needsDetail"]["totalCannonCredits"], 96)
        self.assertEqual([s["quoteCredits"] for s in quoted["production"]["scenes"]], [40, 56])

        done = self.produce(production_id=pid, approve_credits=100)
        self.assertEqual(done["production"]["state"], "done", done)
        self.assertEqual(done["production"]["spend"], {"approvedCredits": 100, "committedCredits": 96})
        self.assertEqual(done["production"]["scenes"][0]["status"], "succeeded")
        self.assertTrue(done["media"] and done["media"][0].startswith("MEDIA:") and done["media"][0].endswith("Film.mp4"))
        # Every result leads with what the reply must show: the film card, and here the master.
        self.assertEqual(done["show"], [f'::slopcannon-film{{id="{pid}"}}', done["media"][0]])
        self.assertTrue(done["next"].startswith("Write each line in `show` alone on its own line"))
        self.assertEqual(quoted["show"], [quoted["card"]])
        # At the take check every flagged take is shown in chat, not only described.
        clip = Path(self.tmp.name) / "sc02.mp4"
        clip.write_bytes(b"mp4")
        review = {"id": pid, "state": "needs", "needs": "shot_review", "needsDetail": {"flagged": [{"scene": "sc02"}]},
                  "scenes": [{"id": "sc01", "clip": {"path": str(clip)}}, {"id": "sc02", "clip": {"path": str(clip)}}]}
        with mock.patch.object(production, "media_lines", lambda info: []):
            shown = json.loads(production_tools._result(review))["show"]
        self.assertEqual(shown, [f'::slopcannon-film{{id="{pid}"}}', f"MEDIA:{clip.resolve().as_posix()}"])
        # A turn that answered every gate without a reply still ends on the card and the master.
        production_tools._PENDING_SHOW.clear()
        production_tools._owe("chat-1", json.dumps(done))
        reply = production_tools.show_in_reply(response_text="The film is done.", session_id="chat-1")
        self.assertEqual(reply.split("\n\n"), done["show"] + ["The film is done."])
        self.assertIsNone(production_tools.show_in_reply(response_text="Next turn.", session_id="chat-1"))
        production_tools._owe("chat-2", json.dumps(done))
        self.assertIsNone(production_tools.show_in_reply(response_text="\n".join(done["show"]) + "\nDone.",
                                                         session_id="chat-2"))  # already shown: untouched
        listed = json.loads(production_tools.PRODUCTION_STATUS.handler({}))
        self.assertEqual([p["id"] for p in listed["productions"]], [pid])

        # A reroll runs inside the production: asked for, quoted, approved in a prompt, then cut into the film.
        state = production.load_state(pid)
        production._save_state(pid, {**state, "state": "error", "message": "fetch failed"})
        self.assertIsNone(production.reroll_problem(pid, "sc01"))  # a stopped film's delivered scene can be rerolled
        production._save_state(pid, {**state, "errorCode": "sign_in_refused"})  # a failure from an earlier run
        self.assertIsNone(gate.pre_tool_call("slopcannon_produce", {"production_id": pid, "reroll": {"scene": "sc01"},
                                                                    "rights_version": "v1"}))  # already signed
        quote = self.produce(production_id=pid, reroll={"scene": "sc01", "direction": "keep the helmet"})
        self.assertEqual(quote["production"]["needs"], "reroll_approval", quote)
        self.assertEqual(quote["production"]["needsDetail"]["amountUnits"], 44)
        row = quote["production"]["scenes"][0]
        self.assertEqual((row["id"], row["rerolled"], row["status"], row["take"]), ("sc01", True, "quoted", 2))
        self.assertEqual(len(quote["production"]["scenes"]), 2)  # the reroll is a take of sc01, not a scene
        wrong = gate.pre_tool_call("slopcannon_produce", {"production_id": pid, "approve_reroll": 40})
        self.assertEqual(wrong["action"], "block")
        ask = gate.pre_tool_call("slopcannon_produce", {"production_id": pid, "approve_reroll": 44})
        self.assertEqual(ask["action"], "approve")
        self.assertIn("44 Cannon Credits on new takes of sc01", ask["message"])
        cut = self.produce(production_id=pid, approve_reroll=44)
        self.assertEqual(cut["production"]["state"], "done", cut)
        master = Path(cut["production"]["master"]["path"])
        self.assertNotIn("errorCode", production.load_state(pid))  # the next run cleared it
        self.assertTrue(master.name.endswith("Film.mp4"))
        self.assertEqual(master.read_text(), "cut sc01=sc01.r1")
        self.assertEqual(cut["production"]["scenes"][0]["clip"]["name"], "sc01.r1.mp4")
        # Several rerolls in one call: quoted together, one approval for the total, all submitted before any
        # is waited on (so they render at once), then one cut with every new take.
        many = self.produce(production_id=pid, reroll=[{"scene": "sc01", "direction": "again"}, {"scene": "sc02"}])
        self.assertEqual(many["production"]["needs"], "reroll_approval", many)
        detail = many["production"]["needsDetail"]
        self.assertEqual((detail["scenes"], detail["amountUnits"]), (["sc01", "sc02"], 94))
        both = gate.pre_tool_call("slopcannon_produce", {"production_id": pid, "approve_reroll": 94})
        self.assertIn("94 Cannon Credits on new takes of sc01, sc02 (sc01 44; sc02 50)", both["message"])
        self.assertEqual(gate.pre_tool_call("slopcannon_produce", {"production_id": pid, "approve_reroll": 44})["action"],
                         "block")
        final = self.produce(production_id=pid, approve_reroll=94)
        self.assertEqual(final["production"]["state"], "done", final)
        calls = (production._dir(pid) / "reroll-calls.log").read_text().splitlines()[-6:]
        self.assertEqual([c.split(" ")[3] for c in calls[2:4]], ["no", "no"])  # both sent before either waited
        self.assertEqual(calls[2].split(" ")[2], "238")  # ceiling: 100 film + 44 + 94 rerolls
        self.assertEqual(Path(final["production"]["master"]["path"]).read_text(), "cut sc01=sc01.r1,sc02=sc02.r1")
        # Hand-driving the film's own project is refused, and so is a second sign-off for the same files.
        hand = gate.pre_tool_call("mcp_slopcannon_slopcannon_create_quote", {"projectId": "proj_1"})
        self.assertEqual(hand["action"], "block")
        self.assertIn("reroll=", hand["message"])

    @unittest.skipUnless(production.node_status()["ok"], "Node.js 22.13+ not installed")
    def test_the_film_card_answers_every_gate(self):
        def card(pid, **answer):
            production.decide(pid, answer)
            return production.wait(pid, 30) | {"detail": production.summary(pid, detail=True)}

        first = self.produce(production=self.spec())
        pid = first["production"]["id"]
        self.assertIn("END YOUR TURN", first["next"])  # the agent shows the card and stops
        with self.assertRaises(production.ProductionError):
            production.decide(pid, {"gate": "rights", "version": "v0"})  # only the version the gate names
        with self.assertRaises(production.ProductionError):
            production.decide(pid, {"gate": "approval", "credits": 96})  # not the gate it is stopped at
        quoted = card(pid, gate="rights", version="v1")["detail"]
        self.assertEqual((quoted["needs"], quoted["needsDetail"]["totalCannonCredits"]), ("approval", 96))
        with self.assertRaises(production.ProductionError) as stale:
            production.decide(pid, {"gate": "approval", "credits": 95})
        self.assertEqual(stale.exception.code, "stale_decision")
        with mock.patch.object(settings, "get_int", lambda key: 50 if key == "max_credits_per_action" else 0):
            with self.assertRaises(production.ProductionError) as over:
                production.decide(pid, {"gate": "approval", "credits": 96})
        self.assertEqual(over.exception.code, "over_ceiling")
        done = card(pid, gate="approval", credits=96)["detail"]
        self.assertEqual(done["state"], "done", done)
        self.assertEqual(done["spend"]["approvedCredits"], 96)
        self.assertIn("on the film card the person approved 96 Cannon Credits", production.load_state(pid)["log"])
        # A reroll from the card is quoted first; keeping the current take cancels it without buying anything.
        asked = card(pid, gate="reroll", reroll=["sc01"])["detail"]
        self.assertEqual((asked["needs"], asked["needsDetail"]["amountUnits"]), ("reroll_approval", 44))
        kept = card(pid, gate="reroll_approval", cancel=True)["detail"]
        self.assertEqual(kept["state"], "done", kept)
        self.assertNotIn("sc01.r1=", Path(kept["master"]["path"]).read_text())
        card(pid, gate="reroll", reroll=["sc01"])
        # The approved quote expired before it was bought: quoted again at the same price, the approval stands.
        (production._dir(pid) / "expire-once").write_text("")
        cut = card(pid, gate="reroll_approval", credits=44)["detail"]
        self.assertFalse((production._dir(pid) / "expire-once").exists())
        self.assertEqual(cut["state"], "done", cut)
        self.assertIn("the quote for sc01.r1 expired; quoted again at 44, within the approved 44",
                      production.load_state(pid)["log"])
        self.assertEqual(Path(cut["master"]["path"]).read_text(), "cut sc01=sc01.r1")
        # At the take check every flagged scene needs an answer, and the card's routes are never the agent's.
        state = production.load_state(pid)
        production._save_state(pid, {**state, "state": "needs", "needs": "shot_review",
                                     "needsDetail": {"flagged": [{"scene": "sc01"}, {"scene": "sc02"}]}})
        with self.assertRaises(production.ProductionError) as partial:
            production.decide(pid, {"gate": "shot_review", "keep": ["sc01"]})
        self.assertEqual(partial.exception.code, "incomplete_decision")
        with mock.patch.object(settings, "get", lambda key: False if key == "protect_production_files" else None):
            agent = gate.pre_tool_call("terminal", {"command": "curl -X POST http://127.0.0.1:9119/api/plugins/slopcannon/productions/x/decide"})
        self.assertEqual(agent["action"], "block")

    @unittest.skipUnless(production.node_status()["ok"], "Node.js 22.13+ not installed")
    def test_chain_continuity_keeps_or_rerolls_each_scene_before_the_next(self):
        def card(pid, **answer):
            production.decide(pid, answer)
            production.wait(pid, 30)
            return production.summary(pid, detail=True)

        pid = self.produce(production=self.spec(continuity="chain"))["production"]["id"]
        self.assertEqual(production.summary(pid)["continuity"], "chain")
        card(pid, gate="rights", version="v1")
        first = card(pid, gate="approval", credits=96)
        self.assertEqual(first["needs"], "scene_review", first)
        detail = first["needsDetail"]
        self.assertEqual((detail["scene"], detail["index"], detail["total"], detail["next"]), ("sc01", 1, 2, "sc02"))
        self.assertTrue(detail["clip"]["path"].endswith("sc01.mp4"))
        self.assertEqual(production.media_lines(first), [f"MEDIA:{Path(detail['clip']['path']).resolve().as_posix()}"])
        with self.assertRaises(production.ProductionError) as stale:
            production.decide(pid, {"gate": "scene_review", "sha256": "f" * 64})
        self.assertEqual(stale.exception.code, "stale_decision")
        second = card(pid, gate="scene_review", sha256="a" * 64)
        self.assertEqual((second["needs"], second["needsDetail"]["continuesFrom"]), ("scene_review", "sc01"))
        # Rerolled from the card with a direction: quoted, approved, rendered, then kept like any take.
        asked = card(pid, gate="reroll", reroll=[{"scene": "sc02", "direction": "same blue sky"}])
        self.assertEqual((asked["needs"], asked["needsDetail"]["amountUnits"]), ("reroll_approval", 50), asked)
        self.assertEqual(production.load_state(pid)["decisions"]["rerolls"]["sc02"]["direction"], "same blue sky")
        again = card(pid, gate="reroll_approval", credits=50)
        self.assertEqual((again["needs"], again["needsDetail"]["take"]), ("scene_review", "sc02.r1"), again)
        # In a chained film the reroll goes back through the run (not straight to a cut), under the raised ceiling.
        self.assertEqual(production.load_state(pid)["state"], "needs")
        done = card(pid, gate="scene_review", sha256="b" * 64)
        self.assertEqual(done["state"], "done", done)
        self.assertEqual(Path(done["master"]["path"]).read_text(), "chain sc02=sc02.r1")
        calls = (production._dir(pid) / "chain-calls.log").read_text().splitlines()
        self.assertEqual(calls[-1].split(" "), ["146", ",".join(sorted(["a" * 64, "b" * 64])), "sc02=sc02.r1"])
        # The chat path answers the same gate through Hermes's prompt.
        state = production.load_state(pid)
        production._save_state(pid, {**state, "state": "needs", "needs": "scene_review",
                                     "needsDetail": {"scene": "sc02", "take": "sc02.r1", "sha256": "d" * 64}})
        ask = gate.pre_tool_call("slopcannon_produce", {"production_id": pid, "keep_scene": "d" * 64})
        self.assertEqual(ask["action"], "approve")
        self.assertIn("keep sc02.r1", ask["message"])
        self.assertEqual(gate.pre_tool_call("slopcannon_produce", {"production_id": pid, "keep_scene": "e" * 64})["action"],
                         "block")

    def test_a_chained_reroll_keeps_the_frame_it_continues_from(self):
        folder = self.root / "f"
        plans = folder / "work" / "scene-audio" / "scene-plans"
        plans.mkdir(parents=True)
        (folder / "production.json").write_text('{"continuity": "chain"}', encoding="utf-8")
        self.assertTrue(production._reroll_args(folder, "sc02", {})[6].endswith("sc02.json"))
        (plans / "sc02.chain.json").write_text("{}", encoding="utf-8")
        (plans / "sc02.chain-cast.json").write_text("[]", encoding="utf-8")
        args = production._reroll_args(folder, "sc02", {})
        self.assertTrue(args[args.index("--plan") + 1].endswith("sc02.chain.json"))
        self.assertTrue(args[args.index("--cast") + 1].endswith("sc02.chain-cast.json"))

    def test_changed_inputs_after_paid_state_need_a_new_revision(self):
        production.write_production("film-1", self.spec())
        ledger = self.root / "film-1" / "ledger.json"
        ledger.write_text('{"productionFingerprint": "abc", "scenes": {}}', encoding="utf-8")
        with self.assertRaises(production.ProductionError) as caught:
            production.write_production("film-1", self.spec(concept="different"))
        self.assertEqual(caught.exception.code, "new_revision")
        production.write_production("film-1", self.spec())  # unchanged inputs are fine

    def test_bad_inputs_are_refused_before_anything_runs(self):
        result = self.produce(production={"title": "x", "song": "/no/such/song.mp3"})
        self.assertFalse(result["ok"])
        self.assertIn("song must be an existing local audio file", result["message"])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_production_ids_cannot_escape_the_folder(self):
        for bad in ("../x", "A", "a/b", ""):
            with self.assertRaises(production.ProductionError):
                production.summary(bad)

    def test_driver_args_carry_only_recorded_decisions(self):
        folder = self.root / "f"
        self.assertNotIn("--approve", production._driver_args(folder, {}, 4))
        args = production._driver_args(folder, {"rights_version": "v1", "approved_credits": 120,
                                                "review_first": "b" * 64, "accept_checks": ["sc03"]}, 40)
        self.assertEqual(args[args.index("--max-credits") + 1], "120")
        self.assertEqual(args[args.index("--concurrency") + 1], "16")
        self.assertEqual(args[args.index("--accept-checks") + 1], "sc03")

    def test_every_flag_the_plugin_passes_is_one_the_driver_accepts(self):
        # The fake driver accepts anything; the real one refuses an unknown flag, so a chained run once
        # died at its first keep on --reviewed. Read the driver's own verb table and check every call shape.
        source = production._driver_path(Path(production.__file__).parent).read_text(encoding="utf-8")
        verbs = {m.group(1): set(re.findall(r'"(--[a-z-]+)"', m.group(2)))
                 for m in re.finditer(r'^  ([a-z-]+): \[([^\]]*)\],?\r?$', source, re.M)}
        folder = self.root / "chained"
        (folder / "work" / "scene-audio" / "scene-plans").mkdir(parents=True)
        (folder / "production.json").write_text(json.dumps({"title": "t", "continuity": "chain"}), encoding="utf-8")
        shapes = [
            {"rights_version": "v1", "approved_credits": 120, "review_first": "b" * 64, "accept_checks": ["sc03"],
             "reviewed": ["a" * 64]},
            {"rights_version": "v1", "approved_credits": 120, "reviewed": ["a" * 64],
             "rerolls": {"sc01": {"take": "sc01r1", "approved": 40}}},
            {"approved_credits": 120, "rerolls": {"sc02": {"direction": "d", "quote": None, "approved": None}}},
            {"approved_credits": 120, "rerolls": {"sc02": {"quote": {"amountUnits": 40}, "approved": 40,
                                                           "submitted": False}}},
        ]
        for decisions in shapes:
            args = production._driver_args(folder, decisions, 3)
            flags = {a for a in args[1:] if a.startswith("--")}
            self.assertLessEqual(flags, verbs[args[0]], f"{args[0]} refuses {flags - verbs[args[0]]}")

    def test_driver_runs_when_the_plugin_is_installed_as_a_link(self):
        # Hermes installs a local plugin as a link; Node runs a script only from its real path and
        # otherwise exits 0 having done nothing.
        node = production.node_status()
        if not node["ok"]:
            self.skipTest("node is not installed")
        real = Path(production.__file__).resolve().parent
        with tempfile.TemporaryDirectory() as tmp:
            link = Path(tmp) / "slopcannon"
            try:
                os.symlink(real, link, target_is_directory=True)
            except (OSError, NotImplementedError):
                try:
                    import _winapi
                    _winapi.CreateJunction(str(real), str(link))
                except (ImportError, OSError):
                    self.skipTest("links are not available here")
            import subprocess
            driver = production._driver_path(link)
            run = subprocess.run([node["node"], str(driver), "run"], capture_output=True, text=True, timeout=60)
            self.assertEqual(driver, production._driver_path(real))
            self.assertTrue((run.stdout + run.stderr).strip(), "the driver printed nothing")

    def test_runner_keeps_the_calling_profile_scope(self):
        # Hermes holds the served profile in context variables; the background run must see the caller's.
        import contextvars
        profile = contextvars.ContextVar("profile", default="primary")
        seen: dict[str, str] = {}

        def node_status():
            seen["profile"] = profile.get()
            return {"ok": False, "message": "stop here"}

        production.write_production("film-1", self.spec())
        token = profile.set("demo")
        try:
            with mock.patch.object(production, "node_status", node_status):
                production.start("film-1")
                production.wait("film-1", 10)
        finally:
            profile.reset(token)
        self.assertEqual(seen.get("profile"), "demo")
        self.assertEqual(production.load_state("film-1")["state"], "error")

    def test_produce_gate(self):
        production.write_production("film-1", self.spec())
        self.assertIsNone(gate.pre_tool_call("slopcannon_produce", {"production": self.spec()}))
        blocked = gate.pre_tool_call("slopcannon_produce", {"production": self.spec(), "approve_credits": 50})
        self.assertEqual(blocked["action"], "block")  # an answer needs a production the person has seen
        prompt = gate.pre_tool_call("slopcannon_produce", {"production_id": "film-1", "rights_version": "v1",
                                                            "approve_credits": 120})
        self.assertEqual(prompt["action"], "approve")
        self.assertIn('"Film"', prompt["message"])
        self.assertIn("song.mp3", prompt["message"])
        self.assertIn("120 Cannon Credits", prompt["message"])
        bind({"max_credits_per_action": 100})
        over = gate.pre_tool_call("slopcannon_produce", {"production_id": "film-1", "approve_credits": 120})
        self.assertEqual(over["action"], "block")
        bind()
        with mock.patch.object(gate, "_approvals_bypassed", return_value=True):
            self.assertEqual(gate.pre_tool_call("slopcannon_produce", {"production_id": "film-1",
                                                                       "approve_credits": 5})["action"], "block")
        self.assertEqual(gate.pre_tool_call("slopcannon_transcribe", {"song": str(self.song),
                                                                      "rights_version": "v1"})["action"], "approve")

    def test_a_deleted_chat_is_not_reported_as_the_films_chat(self):
        class SessionDB:
            def __init__(self, read_only=False):
                pass

            def get_session(self, sid):
                return {"id": sid} if sid == "local-alive" else None

            def close(self):
                pass

        fake = types.ModuleType("hermes_state")
        fake.SessionDB = SessionDB
        with mock.patch.dict(sys.modules, {"hermes_state": fake}):
            self.assertEqual(production._live_session("local-alive"), "local-alive")
            self.assertIsNone(production._live_session("local-deleted"))
            self.assertIsNone(production._live_session(None))

    def test_production_is_checked_before_the_rights_prompt(self):
        pic = Path(self.song).with_name("cloudsea.jpg")
        pic.write_bytes(b"jpg")
        plan = {"schemaVersion": 1, "durationMs": 1000,
                "scenes": [{"startMs": 0, "endMs": 1000, "beat": "x", "cast": ["CLOUDSEA"]}]}
        # The natural word for a place is accepted and written as the driver's own kind.
        ok = self.spec(references=[{"name": "CLOUDSEA", "path": str(pic), "kind": "set"}])
        self.assertEqual(gate.pre_tool_call("slopcannon_produce", {"production": ok, "timed_plan": plan,
                                                                   "rights_version": "v1"})["action"], "approve")
        production.write_production("kinds", ok, plan)
        written = json.loads((production._dir("kinds") / "production.json").read_text(encoding="utf-8"))
        self.assertEqual(written["references"][0]["kind"], "product")
        # A kind nothing maps to, or a cast name with no picture, is refused before anything is signed.
        bad = self.spec(references=[{"name": "CLOUDSEA", "path": str(pic), "kind": "vibe"}])
        d = gate.pre_tool_call("slopcannon_produce", {"production": bad, "timed_plan": plan, "rights_version": "v1"})
        self.assertEqual(d["action"], "block")
        self.assertIn("nothing was signed", d["message"])
        self.assertIn('"product" for a set', d["message"])
        missing = dict(plan, scenes=[dict(plan["scenes"][0], cast=["COURIER"])])
        d = gate.pre_tool_call("slopcannon_produce", {"production": ok, "timed_plan": missing, "rights_version": "v1"})
        self.assertEqual(d["action"], "block")
        self.assertIn("'COURIER'", d["message"])

    def test_rights_sign_off_is_one_prompt_carrying_the_statement(self):
        statement = "I confirm that I own or am licensed to use this song."
        policy = {"requiredVersion": "v1", "statement": statement,
                  "termsUrl": "https://slop.cc/terms", "acceptableUseUrl": "https://slop.cc/acceptable-use"}
        with mock.patch.object(client_mod.Client, "rights_policy", return_value={"data": policy}):
            # The very first call may carry the sign-off: the prompt names the files and quotes the statement.
            first = gate.pre_tool_call("slopcannon_produce", {"production": self.spec(), "rights_version": "v1"})
            self.assertEqual(first["action"], "approve")
            self.assertIn("song.mp3 (7 bytes)", first["message"])
            self.assertIn(f"\u201c{statement}\u201d", first["message"])
            self.assertIn("https://slop.cc/acceptable-use", first["message"])
            # A version the server does not publish gets no statement it never said.
            stale = gate.pre_tool_call("slopcannon_produce", {"production": self.spec(), "rights_version": "v0"})
            self.assertNotIn(statement, stale["message"])
            upload = gate.pre_tool_call("slopcannon_upload", {"path": str(self.song), "kind": "song",
                                                              "rights_version": "v1"})
            self.assertIn(statement, upload["message"])
        # The gate's own next steps never tell the agent to wait for a typed agreement: the card is the answer.
        for need in ("rights", "approval", "first_scene_review", "shot_review", "reroll_approval"):
            self.assertIn("do not ask the person to reply in chat", production_tools.NEXT[need])

class TranscribeTest(unittest.TestCase):
    def test_server_words_become_whisper_segments(self):
        doc = production_tools.whisper_json([
            {"word": "Hello", "start": 0.5, "end": 0.9}, {"word": "world", "start": 1.0, "end": 1.4},
            {"word": "again", "start": 4.0, "end": 4.3}, {"word": "", "start": 5, "end": 6}, {"text": "x"}])
        self.assertEqual([s["text"] for s in doc["segments"]], ["Hello world", "again"])
        self.assertEqual(doc["segments"][0]["start"], 0.5)


class StateWriteTest(unittest.TestCase):
    def test_a_state_file_held_open_for_a_moment_is_still_written(self):
        real, calls = os.replace, []

        def replace(src, dst):
            calls.append(dst)
            if len(calls) <= 2:  # Windows: another process has the file open
                raise PermissionError(13, "Access is denied")
            real(src, dst)

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "state.json"
            with mock.patch.object(production.os, "replace", replace), mock.patch.object(production.time, "sleep"):
                production._write_json(target, {"state": "running"})
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"state": "running"})
            self.assertEqual(len(calls), 3)
