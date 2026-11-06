"""The tool surface: blocking limits, argument validation, the manifest's tool list and what a sync may change.

Offline: every SLOPCANNON call is a fake. Run with the other tests: python -m unittest discover -s tests
"""
from __future__ import annotations

import importlib.util
import json
import re
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import test_plugin as tp  # installs the Hermes stubs and loads the plugin package

from slopcannon_plugin import production, production_tools, server_tools, tools  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
HERMES_BATCH_DEADLINE_S = 420


class FakeClock:
    """Stands in for the ``time`` module inside a tool: sleeping advances the clock, nothing really waits."""

    def __init__(self):
        self.now = 1000.0
        self.slept = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        assert seconds >= 0, seconds
        self.now += seconds
        self.slept += seconds

    def module(self):
        return types.SimpleNamespace(monotonic=self.monotonic, sleep=self.sleep)


def local_specs():
    return {spec.name: spec for spec in (*tools.TOOLS, *production_tools.TOOLS)}


class BlockingLimitTest(unittest.TestCase):
    def test_one_shared_limit_under_the_hermes_deadline(self):
        self.assertLessEqual(tools.MAX_BLOCK_S, 300)
        self.assertLess(tools.MAX_BLOCK_S, HERMES_BATCH_DEADLINE_S)
        self.assertIs(production_tools.MAX_BLOCK_S, tools.MAX_BLOCK_S)
        for name in ("_MAX_WAIT_S", "_ANALYSIS_TIMEOUT_S"):
            self.assertFalse(hasattr(tools, name), name)
            self.assertFalse(hasattr(production_tools, name), name)

    def test_every_wait_argument_is_capped_in_the_schema(self):
        capped = 0
        for name, spec in local_specs().items():
            for prop, schema in spec.schema["parameters"]["properties"].items():
                if prop in ("timeout_s", "wait_s"):
                    capped += 1
                    self.assertEqual(schema.get("maximum"), tools.MAX_BLOCK_S, f"{name}.{prop}")
        self.assertEqual(capped, 4)  # wait, transcribe, produce, production_status
        for name in ("slopcannon_wait", "slopcannon_transcribe"):
            self.assertIn(f"{tools.MAX_BLOCK_S} s", local_specs()[name].schema["description"])
            self.assertIn("call_again", local_specs()[name].schema["description"])


class WaitTest(unittest.TestCase):
    class RunningClient:
        """A generation that never finishes and an assembly still rendering."""

        def __init__(self):
            self.calls = 0

        def call_tool(self, name, args):
            self.calls += 1
            if name == "slopcannon_get_generation":
                return {"generation": {"id": args["generationId"], "status": "running"}}
            return {"assembly": {"id": args["assemblyId"], "status": "rendering"}}

    def run_wait(self, args):
        clock, client = FakeClock(), self.RunningClient()
        with mock.patch.object(tools, "time", clock.module()), mock.patch.object(tools, "Client", lambda: client):
            out = json.loads(tools.WAIT.handler(args))
        return out, clock, client

    def test_returns_what_is_still_running_with_the_arguments_to_resume(self):
        out, clock, client = self.run_wait({"generation_ids": ["g1"], "assembly_id": "a1", "project_id": "p1"})
        self.assertTrue(out["ok"])
        self.assertEqual(out["still_running"], ["g1"])
        self.assertEqual(out["call_again"], {"generation_ids": ["g1"], "assembly_id": "a1", "project_id": "p1"})
        self.assertIn("call slopcannon_wait again", out["note"])
        self.assertIn("Never resubmit", out["note"])
        self.assertLessEqual(clock.slept, tools.MAX_BLOCK_S)
        self.assertGreater(client.calls, 2)  # it polled for the whole window, not once

    def test_a_longer_timeout_is_held_to_the_limit(self):
        out, clock, _ = self.run_wait({"generation_ids": ["g1"], "timeout_s": 900})
        self.assertEqual(out["still_running"], ["g1"])
        self.assertLessEqual(clock.slept, tools.MAX_BLOCK_S)
        self.assertGreaterEqual(clock.slept, tools.MAX_BLOCK_S - tools._POLL_S)

    def test_the_last_poll_does_not_sleep_past_the_deadline(self):
        _, clock, _ = self.run_wait({"generation_ids": ["g1"], "timeout_s": 45})
        self.assertEqual(clock.slept, 45)


class TranscribeTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.song = self.base / "song.mp3"
        self.song.write_bytes(b"not really audio")
        patcher = mock.patch.object(production, "root", lambda: self.base / "productions")
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_transcribe(self, args, client=None):
        clock = FakeClock()
        made = []

        def factory():
            made.append(client)
            return client
        with mock.patch.object(production_tools, "time", clock.module()), \
                mock.patch.object(production_tools, "Client", factory):
            out = json.loads(production_tools.TRANSCRIBE.handler(args))
        return out, clock, made

    class RunningAnalysis:
        def rights_policy(self):
            return {"requiredVersion": "rights-v1", "statement": "I own this."}

        def call_tool(self, name, args):
            if name == "slopcannon_create_project":
                return {"project": {"id": "p1"}}
            if name == "slopcannon_start_song_analysis":
                self.started = args
                return {"analysis": {"id": "an1"}}
            return {"analysis": {"id": "an1", "status": "running"}}

        def upload_asset(self, **kw):
            return {"asset": {"id": "as1"}}

    def test_still_running_is_a_result_to_resume_not_a_timeout(self):
        client = self.RunningAnalysis()
        out, clock, _ = self.run_transcribe(
            {"song": str(self.song), "rights_version": "rights-v1", "language": "pt-BR", "timeout_s": 900}, client)
        self.assertTrue(out["ok"])
        self.assertEqual(out["status"], "running")
        self.assertEqual(out["analysisId"], "an1")
        self.assertEqual(out["call_again"], {"song": str(self.song), "rights_version": "rights-v1",
                                             "language": "pt-BR"})
        self.assertIn("call_again", out["message"])
        self.assertLessEqual(clock.slept, tools.MAX_BLOCK_S)
        self.assertEqual(client.started["language"], "pt-BR")

    def test_bad_language_tags_are_refused_before_any_path_or_call(self):
        for bad in ("../../etc", "en/x", "en\\x", "en.json", "en_US", "e", "-en", "en-", "en--us", " en",
                    "a" * 36, "en-" + "a" * 9, 7, ["en"]):
            out, _, made = self.run_transcribe({"song": str(self.song), "language": bad})
            self.assertFalse(out["ok"], bad)
            self.assertEqual(out["error"], "invalid_language", bad)
            self.assertEqual(made, [], bad)
        self.assertFalse((self.base / "transcripts").exists())

    def test_good_language_tags_pass(self):
        for good in ("en", "pt-BR", "zh-Hant-TW", "es-419", "sr-Latn-RS", "x" * 8 + "-abc"):
            self.assertEqual(production_tools._language(good), good)
        self.assertEqual(production_tools._language(None), "")
        self.assertEqual(production_tools._language(""), "")
        out, _, _ = self.run_transcribe({"song": str(self.base / "missing.mp3"), "language": "en"})
        self.assertEqual(out["error"], "file_not_found")  # past the language check

    def test_schema_pattern_matches_the_check(self):
        schema = production_tools.TRANSCRIBE.schema["parameters"]["properties"]["language"]
        self.assertEqual(schema["maxLength"], 35)
        pattern = re.compile(schema["pattern"])
        for tag in ("en", "pt-BR", "../x", "en_US", "en-"):
            try:
                production_tools._language(tag)
                accepted = True
            except Exception:
                accepted = False
            self.assertEqual(bool(pattern.search(tag)), accepted, tag)


def load_sync_script():
    spec = importlib.util.spec_from_file_location("sync_server_tools", ROOT / "scripts" / "sync_server_tools.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # defines functions only: no network, no writes
    return mod


def manifest_tools(text):
    block = re.search(r"provides_tools:\n((?:  - .*\n)+)", text).group(1)
    return [line.strip()[2:] for line in block.splitlines()]


class SyncScriptTest(unittest.TestCase):
    def test_generated_list_is_the_manifests_list(self):
        sync = load_sync_script()
        manifest = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
        names = sync.provides_tools(server_tools._bundled())
        self.assertEqual(names, manifest_tools(manifest))
        self.assertEqual(len(names), len(set(names)))
        for spec in production_tools.TOOLS:
            self.assertIn(spec.name, names)
        self.assertEqual(sync.with_provides_tools(manifest, names), manifest)  # a sync with no drift writes nothing new

    def test_a_new_server_tool_lands_after_the_plugins_own(self):
        sync = load_sync_script()
        names = sync.provides_tools([*server_tools._bundled(), {"name": "slopcannon_zz_new"}])
        self.assertEqual(names[-1], "slopcannon_zz_new")
        self.assertEqual(names[:8], [s.name for s in (*tools.TOOLS, *production_tools.TOOLS)])

    def test_drift_report(self):
        sync = load_sync_script()
        current = [{"name": "a", "description": "x"}, {"name": "b", "description": "y"}]
        live = [{"name": "a", "description": "x2"}, {"name": "c", "description": "z"}]
        self.assertEqual(sync.drift(live, current), {"added_or_removed": ["b", "c"], "changed": ["a"]})


class SyncedDescriptionsTest(unittest.TestCase):
    def setUp(self):
        self.ctx = tp.bind()
        self.bundled = server_tools._bundled()
        self.names = [t["name"] for t in self.bundled]

    def sync(self, tools_list):
        self.ctx.state.set("server_tools", {"tools": tools_list})
        return server_tools.load()

    def test_a_sync_can_neither_add_nor_remove_a_tool(self):
        loaded = self.sync([
            {"name": "slopcannon_get_project", "title": "T", "description": "newer words",
             "inputSchema": {"type": "object", "properties": {"projectId": {"type": "string"}}},
             "annotations": {"readOnlyHint": True}},
            {"name": "slopcannon_new_thing", "description": "d", "inputSchema": {"type": "object"}},
        ])
        self.assertEqual([t["name"] for t in loaded], self.names)  # nothing added, nothing dropped
        got = next(t for t in loaded if t["name"] == "slopcannon_get_project")
        self.assertEqual(got["description"], "newer words")
        self.assertEqual(got["title"], "T")
        self.assertEqual(got["inputSchema"]["properties"], {"projectId": {"type": "string"}})
        self.assertEqual(got["annotations"], {"readOnlyHint": True})
        untouched = next(t for t in loaded if t["name"] == "slopcannon_create_quote")
        self.assertEqual(untouched, next(t for t in self.bundled if t["name"] == "slopcannon_create_quote"))
        registered = [s[0] for s in server_tools.specs(set())]
        self.assertEqual(registered, self.names)

    def test_only_the_syncable_fields_change(self):
        loaded = self.sync([{"name": "slopcannon_get_project", "description": "", "inputSchema": {"type": "array"},
                             "handler": "x", "extra": 1}])
        got = next(t for t in loaded if t["name"] == "slopcannon_get_project")
        original = next(t for t in self.bundled if t["name"] == "slopcannon_get_project")
        self.assertEqual(got, original)  # an empty description, a non-object schema and unknown keys are ignored
        self.assertEqual(server_tools.SYNCABLE_FIELDS, ("title", "description", "inputSchema", "annotations"))

    def test_an_empty_or_broken_sync_is_the_bundled_set(self):
        for cached in ([], ["junk", None], [{"name": 5}]):
            self.assertEqual(self.sync(cached), self.bundled)

    def test_the_rule_is_written_where_a_reviewer_reads(self):
        doc = server_tools.__doc__
        self.assertIn("What a sync can change", doc)
        self.assertIn("never adds a\ntool, never removes one", doc)


class SharedHelpersTest(unittest.TestCase):
    def test_one_guard(self):
        self.assertIs(production_tools._guard, tools._guard)
        self.assertNotIn("def _guard", (ROOT / "production_tools.py").read_text(encoding="utf-8"))

    def test_one_media_line_builder(self):
        line = tools.media_line(ROOT / "x" / ".." / "clip.mp4")
        self.assertEqual(line, "MEDIA:" + (ROOT / "clip.mp4").resolve().as_posix())
        for name in ("tools.py", "production_tools.py"):
            text = (ROOT / name).read_text(encoding="utf-8")
            self.assertEqual(text.count('f"MEDIA:'), 1 if name == "tools.py" else 0, name)

    def test_flagged_takes_are_shown_through_the_helper(self):
        clip = ROOT / "data" / "sc02.mp4"
        info = {"id": "film", "state": "needs", "needs": "shot_review",
                "needsDetail": {"flagged": [{"scene": "sc02"}]},
                "scenes": [{"id": "sc02", "clip": {"path": str(clip)}}, {"id": "sc03", "clip": {"path": "x"}}]}
        with mock.patch.object(production, "media_lines", lambda _: []):
            show = json.loads(production_tools._result(info))["show"]
        self.assertEqual(show, ['::slopcannon-film{id="film"}', tools.media_line(clip)])


if __name__ == "__main__":
    unittest.main()
