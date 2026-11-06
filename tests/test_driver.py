"""The bundled production driver's own recovery paths, run under Node."""

from __future__ import annotations

import json
import os
import tempfile
import time
import shutil
import subprocess
import unittest
from pathlib import Path

DRIVER = Path(__file__).resolve().parents[1] / "skills" / "slopcannon-music-video" / "scripts" / "slopcannon-agent.mjs"
NODE = shutil.which("node")

SCRIPT = r"""
const { submitWithRetry } = await import(process.argv[1]);
const submission = { idempotencyKey: "gen-1", quoteId: "q1" };
const run = async (failures, retryable) => {
  const sent = [];
  const call = async (_ledger, tool, params) => {
    sent.push([tool, JSON.stringify(params)]);
    if (sent.length <= failures) throw Object.assign(new Error("generation_admission_unconfirmed"), { retryable });
    return { generation: { id: "generation_1", status: "queued" } };
  };
  try {
    const result = await submitWithRetry({}, submission, call, async () => {});
    return { ok: true, sent, id: result.generation.id };
  } catch (error) {
    return { ok: false, sent, error: error.message };
  }
};
console.log(JSON.stringify({
  recovers: await run(2, true),
  refusal: await run(1, false),
  exhausted: await run(99, true),
}));
"""


@unittest.skipUnless(NODE, "node is not installed")
class SubmitRetryTest(unittest.TestCase):
    def setUp(self):
        out = subprocess.run([str(NODE), "--input-type=module", "-e", SCRIPT, DRIVER.as_uri()],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.result = json.loads(out.stdout.strip().splitlines()[-1])

    def test_unconfirmed_admission_is_sent_again_under_the_same_key(self):
        recovers = self.result["recovers"]
        self.assertTrue(recovers["ok"])
        self.assertEqual(recovers["id"], "generation_1")
        self.assertEqual(len(recovers["sent"]), 3)
        # Every attempt is the identical submission: one key, one quote, never a second purchase.
        self.assertEqual({tuple(s) for s in recovers["sent"]}, {tuple(recovers["sent"][0])})
        self.assertEqual(recovers["sent"][0][0], "slopcannon_submit_generation")

    def test_a_refusal_is_not_retried(self):
        refusal = self.result["refusal"]
        self.assertFalse(refusal["ok"])
        self.assertEqual(len(refusal["sent"]), 1)

    def test_retries_are_bounded(self):
        exhausted = self.result["exhausted"]
        self.assertFalse(exhausted["ok"])
        self.assertEqual(len(exhausted["sent"]), 5)


if __name__ == "__main__":
    unittest.main()


READ_SCRIPT = r"""
const { fetchJson } = await import(process.argv[1]);
const down = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
const run = async (failures, method) => {
  let calls = 0;
  const call = async () => { calls += 1; if (calls <= failures) throw down(); return new Response('{"ok":true}', { status: 200 }); };
  try {
    const got = await fetchJson("https://api.slop.cc/api/v1/capabilities", method ? { method } : {}, { call, wait: async () => {} });
    return { ok: true, calls, status: got.status };
  } catch (error) {
    return { ok: false, calls, error: error.message };
  }
};
console.log(JSON.stringify({ blip: await run(2), write: await run(1, "POST"), down: await run(99) }));
"""


@unittest.skipUnless(NODE, "node is not installed")
class ReadRetryTest(unittest.TestCase):
    def test_a_read_that_never_reached_the_server_is_tried_again(self):
        out = subprocess.run([str(NODE), "--input-type=module", "-e", READ_SCRIPT, DRIVER.as_uri()],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        result = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(result["blip"], {"ok": True, "calls": 3, "status": 200})
        self.assertEqual(result["write"]["calls"], 1)  # a write may have landed: never sent twice
        self.assertFalse(result["down"]["ok"])
        self.assertEqual(result["down"]["calls"], 4)
        self.assertIn("could not be reached (ECONNRESET)", result["down"]["error"])


CHECK_SCRIPT = r"""
const { checkWithRetry } = await import(process.argv[1]);
const run = async (failures, retryable) => {
  let calls = 0;
  const check = async () => { calls += 1; if (calls <= failures) throw Object.assign(new Error("rate limited"), { code: "rate_limited", retryable }); return { scene: "sc04", verdict: "pass" }; };
  const result = await checkWithRetry("sc04", check, async () => {});
  return { calls, verdict: result.verdict };
};
console.log(JSON.stringify({ limited: await run(2, true), refused: await run(1, false), down: await run(99, true) }));
"""


@unittest.skipUnless(NODE, "node is not installed")
class CheckRetryTest(unittest.TestCase):
    def test_a_rate_limited_check_is_tried_again_before_it_counts_as_unchecked(self):
        out = subprocess.run([str(NODE), "--input-type=module", "-e", CHECK_SCRIPT, DRIVER.as_uri()],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        result = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(result["limited"], {"calls": 3, "verdict": "pass"})
        self.assertEqual(result["refused"], {"calls": 1, "verdict": "unchecked"})
        self.assertEqual(result["down"], {"calls": 4, "verdict": "unchecked"})


FRAME_SCRIPT = r"""
const { lastFrame, sceneShownMs } = await import(process.argv[1]);
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-frame-"));
const seeks = [];
const run = (fails) => async (_tool, args) => {
  const seek = args.slice(4, 6);
  seeks.push(seek);
  if (seeks.length <= fails) throw new Error("past the end");
  fs.writeFileSync(args.at(-1), "jpeg");
};
const shown = (await lastFrame("take.mp4", path.join(dir, "a.jpg"), { run: run(0), untilMs: 5640 }), seeks.splice(0));
const short = (await lastFrame("take.mp4", path.join(dir, "b.jpg"), { run: run(3), untilMs: 5640 }), seeks.splice(0));
const plain = (await lastFrame("take.mp4", path.join(dir, "c.jpg"), { run: run(0) }), seeks.splice(0));
// sc02 of a film: its one-scene plan keeps the song clock (durationMs is where it ends, 15114), the slot is 5644.
const slot = sceneShownMs({ schemaVersion: 1, durationMs: 15114, scenes: [{ startMs: 9470, endMs: 15114 }] });
console.log(JSON.stringify({ shown, short, plain, slot }));
"""


@unittest.skipUnless(NODE, "node is not installed")
class ChainFrameTest(unittest.TestCase):
    def setUp(self):
        out = subprocess.run([str(NODE), "--input-type=module", "-e", FRAME_SCRIPT, DRIVER.as_uri()],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.result = json.loads(out.stdout.strip().splitlines()[-1])

    def test_the_next_scene_continues_from_the_last_frame_the_film_shows(self):
        # A 6.6 s take in a 5.64 s scene: the film cuts it at 5.64 s, so the frame is taken there, not at the take's end.
        self.assertEqual(self.result["shown"], [["-ss", "5.520"]])

    def test_a_take_shorter_than_its_scene_falls_back_to_its_own_end(self):
        self.assertEqual(self.result["short"][-1], ["-sseof", "-0.12"])

    def test_without_a_scene_length_the_take_end_is_used(self):
        self.assertEqual(self.result["plain"], [["-sseof", "-0.12"]])

    def test_the_scene_length_is_its_slot_not_the_plans_clock(self):
        self.assertEqual(self.result["slot"], 5644)


LOCK_SCRIPT = r"""
const { saveLedger } = await import(process.argv[1]);
const file = process.argv[2];
const ledger = { version: 1, scenes: { sc01: { assets: {}, log: ["saved"] } } };
saveLedger(file, ledger, "sc01");
console.log(JSON.stringify({ ok: true }));
"""


@unittest.skipUnless(NODE and os.name == "nt", "a held file blocks a rename only on Windows")
class LedgerLockTest(unittest.TestCase):
    def test_a_ledger_held_open_for_a_moment_is_still_saved(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "ledger.json"
            file.write_text(json.dumps({"version": 1, "scenes": {}}), encoding="utf-8")
            held = open(file, "rb")  # Python opens without FILE_SHARE_DELETE: a rename onto it fails meanwhile
            try:
                proc = subprocess.Popen([str(NODE), "--input-type=module", "-e", LOCK_SCRIPT, DRIVER.as_uri(), str(file)],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                time.sleep(1.0)
            finally:
                held.close()
            out, err = proc.communicate(timeout=60)
            self.assertEqual(proc.returncode, 0, err)
            self.assertEqual(json.loads(file.read_text(encoding="utf-8"))["scenes"]["sc01"]["log"], ["saved"])
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["ledger.json"])  # no candidate left behind
