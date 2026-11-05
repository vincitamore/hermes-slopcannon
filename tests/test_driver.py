"""The bundled production driver's own recovery paths, run under Node."""

from __future__ import annotations

import json
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
