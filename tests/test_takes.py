"""Takes, reroll approvals, stopping, state writes and the driver's environment.

Offline: no network, and no Node (child processes are small Python scripts).
Run with the other tests: python -m unittest discover -s tests
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import test_plugin as tp  # installs the Hermes stubs and loads the plugin package

from slopcannon_plugin import media, production, settings  # noqa: E402


def _take(status="succeeded", clip=None, root=None, **extra):
    entry = {"generation": {"id": f"gen-{clip or status}", "status": status}, **extra}
    if root:
        entry["rerollOf"] = root
    if clip:
        entry["downloaded"] = {"path": str(clip)}
    return entry


class TakesTestBase(unittest.TestCase):
    def setUp(self):
        tp.bind()
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / "productions"
        self.root.mkdir()
        self.patches = [mock.patch.object(production, "root", lambda: self.root),
                        mock.patch.object(production, "_broadcast", lambda *a, **k: None)]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def clip(self, name: str) -> Path:
        path = self.base / "clips" / f"{name}.mp4"
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"mp4")
        return path

    def make(self, pid: str, scenes: dict, decisions: dict | None = None, **state) -> Path:
        folder = self.root / pid
        (folder / "work").mkdir(parents=True)
        record = {"id": pid, "title": pid, "state": "idle", "needs": None, "decisions": decisions or {},
                  "runs": [], "log": [], "updatedAt": 1, **state}
        (folder / "state.json").write_text(json.dumps(record), encoding="utf-8")
        (folder / "ledger.json").write_text(json.dumps({"scenes": scenes}), encoding="utf-8")
        (folder / "production.json").write_text(json.dumps({"title": pid}), encoding="utf-8")
        return folder


# --------------------------------------------------------------------------- 1. one current take


class CurrentTakeTest(TakesTestBase):
    def test_the_chosen_take_wins_then_the_newest_delivered_reroll_then_the_scene(self):
        scenes = {"sc09": _take(), "sc09.r2": _take(root="sc09"), "sc09.r10": _take(root="sc09"),
                  "sc09.r11": _take("failed", root="sc09"), "sc09.r12": {"rerollOf": "sc09", "quote": {}}}
        ledger = {"scenes": scenes}
        # by reroll number, not by dict order or text order (r10 after r2), and only delivered takes
        self.assertEqual(production.current_take(ledger, {}, "sc09"), "sc09.r10")
        chosen = {"decisions": {"takes": {"sc09": "sc09.r2"}}}
        self.assertEqual(production.current_take(ledger, chosen, "sc09"), "sc09.r2")
        kept_first = {"decisions": {"takes": {"sc09": "sc09"}}}
        self.assertEqual(production.current_take(ledger, kept_first, "sc09"), "sc09")
        # a choice naming a take of another scene, or one the ledger does not have, is ignored
        other = {"decisions": {"takes": {"sc09": "sc10.r1"}}}
        self.assertEqual(production.current_take(ledger, other, "sc09"), "sc09.r10")
        self.assertEqual(production.current_take({"scenes": {"sc01": _take()}}, None, "sc01"), "sc01")
        # productions recorded before decisions['takes'] existed: the reroll's own take
        legacy = {"decisions": {"rerolls": {"sc09": {"take": "sc09.r2"}}}}
        self.assertEqual(production.current_take(ledger, legacy, "sc09"), "sc09.r2")

    def test_scene_ids_sort_by_number(self):
        ids = ["sc100", "sc11", "sc02", "sc09.r10", "sc09.r2", "sc09", "production"]
        self.assertEqual(sorted(ids, key=production.scene_order),
                         ["sc02", "sc09", "sc09.r2", "sc09.r10", "sc11", "sc100", "production"])

    def test_the_studio_shows_the_take_the_film_uses(self):
        first, kept, rejected = self.clip("sc09"), self.clip("sc09.r1"), self.clip("sc09.r2")
        scenes = {"sc02": _take(clip=self.clip("sc02")), "sc09": _take(clip=first),
                  "sc09.r1": _take(clip=kept, root="sc09"), "sc09.r2": _take("failed", root="sc09"),
                  "sc100": _take(clip=self.clip("sc100")), "sc11": _take(clip=self.clip("sc11"))}
        folder = self.make("film", scenes, {"takes": {"sc09": "sc09.r1"}})
        with mock.patch.object(media, "artefact", lambda src, kind, **_: {"state": "ready", "src": src}):
            out = media.production_media("film")
        # the scene strip: the kept reroll, keyed by the scene's own id, in scene order
        self.assertEqual(list(out["scenes"]), ["sc02", "sc09", "sc11", "sc100"])
        self.assertEqual(out["scenes"]["sc09"]["src"], kept.resolve())
        # the list's picture without a film: the last scene in film order, not the text-largest id (sc11)
        with mock.patch.object(media, "artefact", side_effect=lambda src, kind, **_: {"state": "x", "src": src}) as art:
            media.thumbs(["film"])
        self.assertEqual(art.call_args.args[0], (folder.parent.parent / "clips" / "sc100.mp4").resolve())
        # the production's rows agree: the failed later reroll does not stand in for the kept take
        row = next(r for r in production.summary("film", detail=True)["scenes"] if r["id"] == "sc09")
        self.assertEqual((row["clip"]["name"], row["status"], row["take"]), ("sc09.r1.mp4", "succeeded", 2))
        self.assertNotEqual(row["clip"]["path"], str(rejected))

    def test_a_reroll_in_flight_shows_in_its_scene_row(self):
        scenes = {"sc01": _take(clip=self.clip("sc01")), "sc01.r1": {"rerollOf": "sc01", "quote": {"amountUnits": 44}}}
        self.make("film", scenes, {"rerolls": {"sc01": {"quote": {"take": "sc01.r1", "amountUnits": 44},
                                                        "approved": None, "take": None}}})
        rows = production.summary("film", detail=True)["scenes"]
        self.assertEqual([(r["id"], r["status"], r["take"], r["rerolled"]) for r in rows],
                         [("sc01", "quoted", 2, True)])

    def test_locate_finds_a_reroll_and_names_its_scene(self):
        reroll = self.clip("sc09.r1")
        self.make("film", {"sc09": _take(clip=self.clip("sc09")), "sc09.r1": _take(clip=reroll, root="sc09")})
        self.assertEqual(media.locate(path=str(reroll)), {"productionId": "film", "sceneId": "sc09"})
        self.assertEqual(media.locate(generation_id=f"gen-{reroll}"), {"productionId": "film", "sceneId": "sc09"})

    def test_a_derived_direction_reads_the_current_takes_check(self):
        scenes = {"sc01": _take(shotCheck={"issues": [{"description": "the first take's problem"}]}),
                  "sc01.r1": _take(root="sc01", shotCheck={"issues": [{"description": "the helmet vanishes"}]})}
        self.make("film", scenes, {"takes": {"sc01": "sc01.r1"}})
        direction = production._derived_direction("film", "sc01")
        self.assertIn("the helmet vanishes", direction)
        self.assertNotIn("first take's problem", direction)


# --------------------------------------------------------------------------- 2. an approval buys one take


class RequoteTest(TakesTestBase):
    def ask(self, **extra):
        return {"quote": {"take": "sc01.r1", "amountUnits": 44}, "approved": 44, "submitted": False, "take": None,
                **extra}

    def quoted(self, ask, take="sc01.r1", units=44):
        state = {"decisions": {"rerolls": {"sc01": ask}}, "log": []}
        production._record_quote(state, ask, {"needs": "approval", "scene": take, "amountUnits": units})
        return state

    def test_the_same_unsent_take_requoted_no_higher_keeps_its_approval_once(self):
        ask = self.ask()
        state = self.quoted(ask, units=40)
        self.assertEqual((ask["approved"], ask["carried"]), (40, 1))
        self.assertIn("quoted again at 40, within the approved 44", state["log"][-1])
        self.quoted(ask, units=40)  # expired again: this time the person is asked
        self.assertIsNone(ask["approved"])

    def test_a_higher_price_another_take_or_a_sent_take_is_asked_again(self):
        higher = self.ask()
        self.quoted(higher, units=45)
        self.assertIsNone(higher["approved"])
        other = self.ask()
        self.quoted(other, take="sc01.r2", units=40)  # the driver opened a new take (the approved one failed)
        self.assertIsNone(other["approved"])
        sent = self.ask(submitted=True)
        state = self.quoted(sent, take="sc01.r2", units=40)
        self.assertIsNone(sent["approved"])
        self.assertFalse(sent["submitted"])
        # the sent take's spend still counts toward the film's ceiling
        self.assertEqual(state["decisions"]["reroll_credits_before"], 44)

    def test_a_fresh_approval_may_carry_over_once_more(self):
        ask = self.ask(approved=None, carried=1)
        self.make("film", {}, {"rerolls": {"sc01": ask}}, state="needs", needs="reroll_approval")
        production.record_decisions("film", {"approve_reroll": 44})
        stored = production.load_state("film")["decisions"]["rerolls"]["sc01"]
        self.assertEqual((stored["approved"], stored["carried"]), (44, 0))


# --------------------------------------------------------------------------- 3 and 7. stopping


def _python() -> str:
    # a Windows venv's python.exe starts the real interpreter as a child: use the real one so the pid is its own
    return getattr(sys, "_base_executable", None) or sys.executable


class StopTest(TakesTestBase):
    def driver(self, folder: Path) -> subprocess.Popen:
        """A stand-in driver: takes the ledger lock the way the real one does, then works until killed."""
        script = ("import json, os, sys, time\n"
                  "lock = sys.argv[1]\n"
                  "open(lock, 'x').write(json.dumps({'pid': os.getpid(), 'startedAt': 'now'}))\n"
                  "time.sleep(60)\n")
        proc = subprocess.Popen([_python(), "-c", script, str(folder / "ledger.json.lock")])
        deadline = time.time() + 20
        while not (folder / "ledger.json.lock").is_file() or not (folder / "ledger.json.lock").read_text():
            self.assertLess(time.time(), deadline, "the stand-in driver never took its lock")
            time.sleep(0.05)
        return proc

    def test_stop_ends_the_driver_and_removes_only_its_own_lock(self):
        folder = self.make("film", {})
        runner = production._Runner("film", 1)
        runner.proc = proc = self.driver(folder)
        runner.stop()
        self.assertIsNotNone(proc.poll())
        self.assertFalse((folder / "ledger.json.lock").exists())

        (folder / "ledger.json.lock").write_text(json.dumps({"pid": proc.pid + 1}), encoding="utf-8")
        self.assertFalse(production._release_driver_lock(folder / "ledger.json", proc.pid))
        self.assertTrue((folder / "ledger.json.lock").exists())  # another command's lock is never touched

    def test_a_stopped_runner_starts_no_further_driver_call(self):
        self.make("film", {}, {"rights_version": "v1"})
        runner = production._Runner("film", 1)
        runner.stopped = True
        with mock.patch.object(production, "node_status", lambda: {"ok": True, "node": "node"}), \
                mock.patch.object(production.auth, "driver_token", lambda pid: types.SimpleNamespace(token="t")), \
                mock.patch.object(production.subprocess, "Popen", side_effect=AssertionError("launched")):
            runner._run()
            self.assertIsNone(runner._call(["node", "driver", "run"], {}))
        state = production.load_state("film")
        self.assertEqual(state["state"], "idle")
        self.assertIn("Stopped", state["message"])

    def test_exiting_hermes_stops_live_drivers_and_forgets_their_sessions(self):
        folder = self.make("film", {})
        runner = production._Runner("film", 1)
        runner.proc = proc = self.driver(folder)
        forget = mock.Mock()
        with mock.patch.dict(production._runners, {"film": runner}), \
                mock.patch.object(production.auth, "forget_driver", forget, create=True):
            production._stop_children_at_exit()
        self.assertIsNotNone(proc.poll())
        self.assertFalse((folder / "ledger.json.lock").exists())
        forget.assert_called_once_with("film")

    def test_forget_driver_is_optional(self):
        with mock.patch.object(production, "auth", types.SimpleNamespace()):
            production._forget_driver("film")  # an auth module without it: nothing happens


# --------------------------------------------------------------------------- 4. cancelling keeps the cut


class CancelTest(TakesTestBase):
    def test_cancelling_a_second_reroll_keeps_the_first_in_the_cut(self):
        scenes = {"sc01": _take(clip=self.clip("sc01")), "sc01.r1": _take(clip=self.clip("sc01.r1"), root="sc01"),
                  "sc02": _take(clip=self.clip("sc02"))}
        decisions = {"approved_credits": 100, "takes": {"sc01": "sc01.r1"},
                     "rerolls": {"sc01": {"take": "sc01.r1", "approved": 44, "submitted": True}}}
        folder = self.make("film", scenes, decisions, state="done")
        production.record_decisions("film", {"reroll": [{"scene": "sc01", "direction": "again"}]})
        with production._editing("film") as state:  # quoted: the runner stopped at the approval
            state["decisions"]["rerolls"]["sc01"]["quote"] = {"take": "sc01.r2", "amountUnits": 50}
            state.update(state="needs", needs="reroll_approval", needsDetail={"amountUnits": 50})
        with mock.patch.object(production, "start") as start:
            production.decide("film", {"gate": "reroll_approval", "cancel": True})
        start.assert_called_once()
        decisions = production.load_state("film")["decisions"]
        self.assertNotIn("rerolls", decisions)
        self.assertEqual(decisions["takes"], {"sc01": "sc01.r1"})
        self.assertEqual(decisions["reroll_credits_before"], 44)  # the first reroll's spend still counts
        args = production._driver_args(folder, decisions, production.CONCURRENCY)
        self.assertEqual(args[0], "cut")
        self.assertEqual(args[args.index("--takes") + 1], "sc01=sc01.r1")

    def test_a_delivered_reroll_becomes_the_scenes_take(self):
        state = {"decisions": {"rerolls": {"sc01": {"approved": 44, "submitted": True, "take": None}}}, "log": []}
        self.assertTrue(production._record_reroll(state, "sc01", 0, {"ok": True, "scene": "sc01.r1",
                                                                     "rerollOf": "sc01"}))
        self.assertEqual(state["decisions"]["takes"], {"sc01": "sc01.r1"})


# --------------------------------------------------------------------------- 5. state writes


class StateWriteTest(TakesTestBase):
    def test_concurrent_changes_are_never_lost(self):
        self.make("film", {})

        def note(who):
            for i in range(40):
                with production._editing("film") as state:
                    state["log"].append(f"{who}{i}")

        threads = [threading.Thread(target=note, args=(w,)) for w in "ab"]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(production.load_state("film")["log"]), 80)
        self.assertEqual([p.name for p in (self.root / "film").iterdir() if p.suffix == ".tmp"], [])

    def test_each_write_has_its_own_temp_file(self):
        target = self.base / "state.json"
        seen = []
        real = os.replace

        def replace(src, dst):
            seen.append(Path(src).name)
            real(src, dst)

        with mock.patch.object(production.os, "replace", replace):
            threads = [threading.Thread(target=production._write_json, args=(target, {"n": n})) for n in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(len(set(seen)), 4)
        self.assertNotEqual(seen[0], "state.json.tmp")

    def test_an_unreadable_state_file_is_never_reset(self):
        folder = self.make("film", {})
        (folder / "state.json").write_text('{"decisions": {"approved_cre', encoding="utf-8")  # cut short
        spec = {"title": "film", "song": str(self.clip("song")).replace(".mp4", ".mp3"),
                "transcript": str(self.base / "words.json")}
        Path(spec["song"]).write_bytes(b"ID3")
        Path(spec["transcript"]).write_text("{}", encoding="utf-8")
        for change in (lambda: production.write_production("film", spec),
                       lambda: production.record_decisions("film", {"rights_version": "v1"}),
                       lambda: production.remember_session("film", "chat"),
                       lambda: production.start("film")):
            with self.assertRaises(production.ProductionError) as caught:
                change()
            self.assertEqual(caught.exception.code, "state_unreadable")
        self.assertEqual((folder / "state.json").read_text(encoding="utf-8"), '{"decisions": {"approved_cre')
        self.assertIsNone(production.load_state("film"))  # readers still see "nothing to show"


# --------------------------------------------------------------------------- 6. the driver's environment


class DriverEnvTest(unittest.TestCase):
    def test_only_what_the_driver_needs_is_passed(self):
        tp.bind()
        inherited = {"PATH": "/bin", "SYSTEMROOT": "C:\\Windows", "HOME": "/home/x", "TZ": "UTC",
                     "HERMES_HOME": "/h", "HERMES_SECRET": "s", "OPENAI_API_KEY": "sk", "ANTHROPIC_API_KEY": "sk",
                     "GITHUB_TOKEN": "g", "SLOPCANNON_FFMPEG_DIR": "/ff", settings.TOKEN_ENV: "slop_inherited"}
        with mock.patch.dict(os.environ, inherited, clear=True):
            env = production._driver_env("slop_minted")
        self.assertEqual(env[settings.TOKEN_ENV], "slop_minted")
        self.assertEqual(env["SLOPCANNON_AGENT_ORIGIN"], settings.api_origin())
        self.assertEqual(env["SLOPCANNON_FFMPEG_DIR"], "/ff")
        for kept in ("PATH", "SYSTEMROOT", "HOME", "TZ"):
            self.assertEqual(env[kept], inherited[kept])
        for dropped in ("HERMES_HOME", "HERMES_SECRET", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"):
            self.assertNotIn(dropped, env)


# --------------------------------------------------------------------------- 9. node is checked once


class NodeStatusTest(unittest.TestCase):
    def setUp(self):
        self.saved = production._node_checked
        production._node_checked = None
        self.addCleanup(setattr, production, "_node_checked", self.saved)

    def test_a_good_answer_is_kept_and_a_failure_is_retried_at_most_once_a_minute(self):
        answers = [{"ok": False, "message": "no node"}, {"ok": True, "node": "node", "version": "v22.13.0"}]
        check = mock.Mock(side_effect=lambda: answers.pop(0))
        clock = [1000.0]
        with mock.patch.object(production, "_check_node", check), \
                mock.patch.object(production.time, "monotonic", lambda: clock[0]):
            self.assertFalse(production.node_status()["ok"])
            clock[0] += 30
            self.assertFalse(production.node_status()["ok"])  # within the minute: not run again
            self.assertEqual(check.call_count, 1)
            clock[0] += 31
            self.assertTrue(production.node_status()["ok"])  # a minute on: checked again, now installed
            clock[0] += 3600
            for _ in range(5):
                self.assertTrue(production.node_status()["ok"])
        self.assertEqual(check.call_count, 2)


# --------------------------------------------------------------------------- 10. small fixes


class SmallFixesTest(TakesTestBase):
    def test_a_mismatched_reroll_approval_is_refused(self):
        ask = {"quote": {"take": "sc01.r1", "amountUnits": 44}, "approved": None, "take": None}
        self.make("film", {}, {"rerolls": {"sc01": ask}}, state="needs", needs="reroll_approval")
        with self.assertRaises(production.ProductionError) as wrong:
            production.record_decisions("film", {"approve_reroll": 40})
        self.assertEqual(wrong.exception.code, "stale_decision")
        with production._editing("film") as state:
            state["needs"] = "shot_review"
        with self.assertRaises(production.ProductionError) as stale:
            production.record_decisions("film", {"approve_reroll": 44})
        self.assertEqual(stale.exception.code, "stale_decision")
        self.assertIsNone(production.load_state("film")["decisions"]["rerolls"]["sc01"]["approved"])

    def test_the_take_check_names_each_flagged_take(self):
        detail = production._needs_detail({"needs": "shot_review",
                                           "flagged": [{"scene": "sc02", "take": "sc02.r1", "issues": []}]})
        self.assertEqual(detail["flagged"][0]["take"], "sc02.r1")

    def test_the_session_store_is_read_through_hermes_state(self):
        class SessionDB:
            def __init__(self, read_only=False):
                assert read_only, "the session store is only read"

            def get_session(self, session_id):
                return {"id": session_id} if session_id == "alive" else None

            def close(self):
                pass

        fake = types.ModuleType("hermes_state")
        setattr(fake, "SessionDB", SessionDB)
        with mock.patch.dict(sys.modules, {"hermes_state": fake}):
            self.assertEqual(production._live_session("alive"), "alive")
            self.assertIsNone(production._live_session("deleted"))
        broken = types.ModuleType("hermes_state")  # an older Hermes: no SessionDB, so the id is kept
        with mock.patch.dict(sys.modules, {"hermes_state": broken}):
            self.assertEqual(production._live_session("alive"), "alive")


if __name__ == "__main__":
    unittest.main()
