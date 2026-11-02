"""Offline tests: no network, no Hermes required (Hermes paths are stubbed).

Run: python -m unittest discover -s tests -v   (from the plugin root)
"""
from __future__ import annotations

import importlib.util
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

_spec = importlib.util.spec_from_file_location(
    "slopcannon_plugin", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
plugin = importlib.util.module_from_spec(_spec)
sys.modules["slopcannon_plugin"] = plugin
_spec.loader.exec_module(plugin)

from slopcannon_plugin import auth, client as client_mod, gate, server_tools, settings, tools  # noqa: E402

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
        local = {"slopcannon_account", "slopcannon_upload", "slopcannon_wait", "slopcannon_download"}
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

    def test_state_cache_wins_over_snapshot(self):
        ctx = bind()
        ctx.state.set("server_tools", {"tools": [{"name": "slopcannon_new_thing", "description": "d",
                                                   "inputSchema": {"type": "object"}}]})
        self.assertEqual([s[0] for s in server_tools.specs(set())], ["slopcannon_new_thing"])


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
        self.assertEqual(settings.mcp_resource(), f"{ORIGIN}/mcp")
        bind({"api_origin": "http://localhost:8787"})
        self.assertEqual(settings.mcp_resource(), "http://localhost:8787/mcp")


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
            bind({"auto_approve_max_credits": 48})
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
        c = client_mod.Client(origin=ORIGIN, transport=httpx.MockTransport(lambda r: httpx.Response(200)))
        with mock.patch.object(auth, "get_token", return_value=None):
            with self.assertRaises(client_mod.NotConnected):
                c.balance()

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
                    "connected": True, "via": "oauth", "expires_at": None, "token_prefix": "slop_live_x", "scopes": None}):
            text = commands.slash("status")
        lines = text.splitlines()
        self.assertEqual(lines[0], "SLOPCANNON")
        self.assertIn("4,430 available · 56 held for running work", text)
        self.assertIn("available · rendering open", text)
        self.assertNotIn("{", text)
        self.assertNotIn("slop_live", text)
        self.assertEqual(len({line.index(line.split()[1]) for line in lines[1:]}), 1)  # one value column
    def test_pkce_pair(self):
        verifier, challenge = auth._pkce_pair()
        self.assertRegex(verifier, r"^[A-Za-z0-9._~-]{43,128}$")
        self.assertRegex(challenge, r"^[A-Za-z0-9_-]{43}$")

    def test_pasted_token_shape(self):
        bind()
        with self.assertRaises(auth.LoginError):
            auth.store_pasted_token("sk-not-ours")
        with mock.patch.dict(os.environ, {}, clear=False):
            summary = auth.store_pasted_token("slop_live_abcdefghijkl\n")
            self.assertTrue(summary["connected"])
            self.assertEqual(os.environ[settings.TOKEN_ENV], "slop_live_abcdefghijkl")
            self.assertEqual(_FAKE_ENV[settings.TOKEN_ENV], "slop_live_abcdefghijkl")
            auth.clear_token()
            self.assertNotIn(settings.TOKEN_ENV, os.environ)
            self.assertNotIn(settings.TOKEN_ENV, _FAKE_ENV)


if __name__ == "__main__":
    unittest.main()
