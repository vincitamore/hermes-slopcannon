"""The gate's unattended rules, its fail-closed branch and the scope of the private-paths rule.

Offline: no network, no Hermes. Route and folder strings are built from parts so that this file's own
source never trips the gate it tests when an agent edits it.
"""
from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import test_plugin as tp  # installs the Hermes stubs and loads the plugin package

from slopcannon_plugin import auth, commands, gate, production, settings  # noqa: E402
from slopcannon_plugin import client as client_mod  # noqa: E402

SUBMIT = "slopcannon_submit_generation"
ROUTE = "/".join(("api", "plugins", "slopcannon"))
CRON_RUN = types.SimpleNamespace(job_id="j1", job_name="nightly", execution_id="e1")


class CronCtx(tp.FakeCtx):
    """A PluginContext whose public cron check says this call runs inside a cron job (or not)."""

    def __init__(self, config=None, cron=CRON_RUN):
        super().__init__(config)
        self.cron = cron

    def current_cron_execution(self):
        return self.cron


def bind_cron(config=None, cron=CRON_RUN):
    ctx = CronCtx(config, cron)
    settings.bind(ctx)
    return ctx


class GateRulesBase(unittest.TestCase):
    def setUp(self):
        tp.bind()
        for patcher in (mock.patch.object(gate, "_approvals_bypassed", return_value=False),
                        mock.patch.object(client_mod.Client, "rights_policy", return_value={})):
            patcher.start()
            self.addCleanup(patcher.stop)

    def bypassed(self):
        return mock.patch.object(gate, "_approvals_bypassed", return_value=True)


class UnattendedSpendTest(GateRulesBase):
    def test_bypassed_spend_is_allowed_up_to_the_allowance_and_blocked_above(self):
        tp.bind({"unattended_max_credits": 48})
        with self.bypassed():
            self.assertIsNone(gate.pre_tool_call(SUBMIT, tp.submit_args(40)))
            self.assertIsNone(gate.pre_tool_call(SUBMIT, tp.submit_args(48)))
            over = gate.pre_tool_call(SUBMIT, tp.submit_args(56))
        self.assertEqual(over["action"], "block")
        self.assertIn("approvals are bypassed", over["message"])
        self.assertIn("unattended_max_credits", over["message"])

    def test_default_allowance_blocks_every_unattended_spend(self):
        with self.bypassed():
            self.assertEqual(gate.pre_tool_call(SUBMIT, tp.submit_args(1))["action"], "block")

    def test_ceiling_still_applies_under_the_allowance(self):
        tp.bind({"unattended_max_credits": 500, "max_credits_per_action": 100})
        with self.bypassed():
            blocked = gate.pre_tool_call(SUBMIT, tp.submit_args(120))
        self.assertEqual(blocked["action"], "block")
        self.assertIn("max_credits_per_action", blocked["message"])

    def test_a_cron_job_is_unattended(self):
        bind_cron({"unattended_max_credits": 48})
        self.assertIsNone(gate.pre_tool_call(SUBMIT, tp.submit_args(40)))
        over = gate.pre_tool_call(SUBMIT, tp.submit_args(56))
        self.assertEqual(over["action"], "block")
        self.assertIn("cron job", over["message"])

    def test_outside_a_cron_job_the_person_is_asked(self):
        bind_cron({"unattended_max_credits": 48}, cron=None)
        self.assertEqual(gate.pre_tool_call(SUBMIT, tp.submit_args(40))["action"], "approve")

    def test_a_failing_cron_check_reads_as_attended(self):
        ctx = bind_cron({"unattended_max_credits": 48})
        ctx.current_cron_execution = mock.Mock(side_effect=RuntimeError("no cron module"))
        self.assertEqual(gate.pre_tool_call(SUBMIT, tp.submit_args(40))["action"], "approve")

    def test_produce_spends_follow_the_allowance_in_a_cron_job(self):
        bind_cron({"unattended_max_credits": 10})
        with mock.patch.object(production, "load_state", return_value={"title": "Film"}):
            self.assertIsNone(gate.pre_tool_call("slopcannon_produce", {"production_id": "film-1",
                                                                        "approve_credits": 10}))
            over = gate.pre_tool_call("slopcannon_produce", {"production_id": "film-1", "approve_credits": 11})
        self.assertEqual(over["action"], "block")


class UnattendedRightsTest(GateRulesBase):
    def assert_needs_a_person(self, directive):
        self.assertEqual(directive["action"], "block")
        self.assertIn("legal attestation", directive["message"])
        self.assertIn("attended session", directive["message"])

    def test_upload_sign_off_is_blocked_in_a_cron_job(self):
        bind_cron()
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "song.mp3"
            song.write_bytes(b"x" * 10)
            self.assert_needs_a_person(gate.pre_tool_call("slopcannon_upload", {
                "path": str(song), "kind": "song", "rights_version": "rights-v1"}))

    def test_already_signed_files_are_still_not_signed_unattended(self):
        with self.bypassed(), mock.patch.object(gate, "_already_signed", return_value=True):
            self.assert_needs_a_person(gate.pre_tool_call("slopcannon_transcribe", {
                "song": __file__, "rights_version": "rights-v1"}))

    def test_rights_tools_are_blocked_even_when_the_spend_fits(self):
        tp.bind({"unattended_max_credits": 100})
        with self.bypassed():
            self.assert_needs_a_person(gate.pre_tool_call("slopcannon_create_audio_spot", {
                "maxCredits": 30, "lengthS": 30, "rightsAttestationVersion": "rights-v1"}))
            self.assert_needs_a_person(gate.pre_tool_call("mcp_slopcannon_slopcannon_import_character", {
                "slug": "x", "rightsAttestationVersion": "rights-v1"}))

    def test_produce_sign_off_is_blocked_in_a_cron_job(self):
        bind_cron({"unattended_max_credits": 100})
        with mock.patch.object(production, "load_state", return_value={"title": "Film"}):
            self.assert_needs_a_person(gate.pre_tool_call("slopcannon_produce", {
                "production_id": "film-1", "rights_version": "rights-v1", "approve_credits": 5}))
            held = {"title": "Film", "decisions": {"rights_version": "rights-v1"}}
            with mock.patch.object(production, "load_state", return_value=held):
                # a version the production already holds is not a new sign-off
                self.assertIsNone(gate.pre_tool_call("slopcannon_produce", {
                    "production_id": "film-1", "rights_version": "rights-v1"}))

    def test_attended_sign_off_still_asks(self):
        directive = gate.pre_tool_call("slopcannon_import_character", {"rightsAttestationVersion": "rights-v1"})
        self.assertEqual(directive["action"], "approve")


class FailClosedTest(GateRulesBase):
    def test_destructive_tools_fail_closed_on_a_gate_error(self):
        with mock.patch.object(gate, "_rule_key", side_effect=RuntimeError("boom")):
            for tool in ("slopcannon_delete_take", "mcp_slopcannon_slopcannon_publish_character"):
                directive = gate.pre_tool_call(tool, {"take": 1})
                self.assertEqual(directive["action"], "block", tool)
                self.assertIn("boom", directive["message"])

    def test_reads_still_fail_open_on_a_gate_error(self):
        with mock.patch.object(gate, "_private_paths_directive", side_effect=RuntimeError("boom")):
            self.assertIsNone(gate.pre_tool_call("slopcannon_get_workspace", {"projectId": "p"}))


class PrivatePathsScopeTest(GateRulesBase):
    def assert_card_blocked(self, tool, args):
        directive = gate.pre_tool_call(tool, args)
        self.assertIsNotNone(directive, tool)
        self.assertEqual(directive["action"], "block", tool)
        self.assertIn("film card", directive["message"])

    def test_disguised_card_routes_are_blocked_for_acting_tools(self):
        encoded = ROUTE.replace("/", "%2F")
        mangled = "\\\\".join(part.upper() for part in ROUTE.split("/")).replace("PLUGINS", "PLUGINS//./")
        for text in (ROUTE, encoded, encoded.upper(), mangled):
            self.assert_card_blocked("terminal", {"command": f"curl -X POST http://127.0.0.1:9119/{text}/x/decide"})
        self.assert_card_blocked("execute_code", {"code": f"post('http://localhost/{encoded}/x/decide')"})
        self.assert_card_blocked("browser_exec", {"code": f"goto_url('http://localhost/{ROUTE}/x')"})

    def test_text_only_tools_may_quote_the_route(self):
        brief = f"Builder note: never POST to /{ROUTE}/<id>/decide; the person answers on the card."
        for tool, args in (("delegate_task", {"goal": brief, "context": brief}),
                           ("clarify", {"question": brief}), ("memory", {"content": brief}),
                           ("skill_view", {"name": "x", "file_path": brief})):
            self.assertIsNone(gate.pre_tool_call(tool, args), tool)

    def test_unknown_and_cron_tools_count_as_acting(self):
        for tool in ("cronjob", "some_new_tool", "mcp_other_server_fetch"):
            self.assert_card_blocked(tool, {"prompt": f"open /{ROUTE}/x"})

    def test_text_only_tools_may_name_the_production_folders(self):
        folder = "/".join(("~", ".hermes", "plugin-data", "slopcannon", "productions"))
        self.assertIsNone(gate.pre_tool_call("delegate_task", {"goal": f"do not touch {folder}"}))
        blocked = gate.pre_tool_call("terminal", {"command": f"cat {folder.replace('/', '%2f')}/ledger.json"})
        self.assertEqual(blocked["action"], "block")


class BypassCheckTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(gate, "_bypass_unavailable", "")
        patcher.start()
        self.addCleanup(patcher.stop)

    def hermes_approval(self, module):
        return mock.patch.dict(sys.modules, {"tools": types.ModuleType("tools"), "tools.approval": module})

    def test_bypass_is_read_from_hermes(self):
        fake = types.ModuleType("tools.approval")
        fake.is_approval_bypass_active = lambda: True
        with self.hermes_approval(fake):
            self.assertTrue(gate.bypass_check_available())
            self.assertTrue(gate._approvals_bypassed())

    def test_missing_check_is_recorded_warned_once_and_read_as_not_bypassed(self):
        with self.hermes_approval(None):
            with self.assertLogs(gate.logger, "WARNING") as logged:
                self.assertFalse(gate._approvals_bypassed())
                self.assertFalse(gate._approvals_bypassed())
                self.assertFalse(gate.bypass_check_available())
        self.assertEqual(len(logged.records), 1)
        self.assertIn("tools.approval", gate.bypass_check_problem())

    def test_status_says_when_the_check_is_unavailable(self):
        tp.bind()
        offline = types.SimpleNamespace(capabilities=mock.Mock(side_effect=RuntimeError("offline")))
        with mock.patch.object(commands, "Client", lambda *a, **k: offline), \
                mock.patch.object(auth, "token_summary", return_value={"connected": False}):
            with self.hermes_approval(None), self.assertLogs(gate.logger, "WARNING"):
                text = commands.slash("status")
            self.assertIn("approvals", text)
            self.assertIn("max_credits_per_action still applies", text)
            fake = types.ModuleType("tools.approval")
            fake.is_approval_bypass_active = lambda: False
            with mock.patch.object(gate, "_bypass_unavailable", ""), self.hermes_approval(fake):
                self.assertNotIn("approvals", commands.slash("status"))


if __name__ == "__main__":
    unittest.main()
