# Timed script plan

Import JSON shaped as:

```json
{
  "schemaVersion": 1,
  "durationMs": 20000,
  "scenes": [
    {
      "startMs": 0,
      "endMs": 10000,
      "cast": ["LEAD", "FRIEND"],
      "beat": "[Shot 1] LEAD (toward camera; static) and FRIEND (3/4 left, facing LEAD; static) stand in a hallway. At 00:00.000, LEAD (S1) sings, <d>[English]We carry the morning home.</d> FRIEND listens and FRIEND's mouth remains closed for the full line. At 00:04.200, track toward the doorway. End on FRIEND (profile, facing frame-right; static) turning toward the sound."
    },
    {
      "startMs": 10000,
      "endMs": 20000,
      "cast": ["FRIEND"],
      "beat": "[Shot 1] Continue the doorway motion; FRIEND (toward camera; static) stands in the doorway. At 00:01.240, FRIEND (S2) sings, <d>[English]I hear it beyond the door.</d> LEAD remains offscreen and silent. End on a clean final pose."
    }
  ]
}
```

This example passes `scripts/validate-timed-plan.mjs --require-h3-vocals`. The silent-mouth rule must use one of the forms the validator recognizes, such as `mouth remains closed`, `mouths stay closed`, `closed-mouth`, `remains silent`, or `stays vocally silent`; a phrasing such as "with mouth closed" is not recognized.

## Hard constraints

- UTF-8 JSON, at most 256 KB.
- `schemaVersion` is `1`.
- `durationMs`, `startMs`, and `endMs` are integer milliseconds.
- The first scene begins at `0`; every later `startMs` equals the prior `endMs`. The one exception is a plan of exactly one scene that carries `sourceAudioAssetId`, the one-scene quote plan described at the end of this page: it begins at the scene's own `startMs` in the song.
- Every scene lasts within `contract.generation.sceneDurationMs` from the capability manifest (`5,000` through `15,000` ms).
- The final `endMs` equals `durationMs` exactly. `durationMs` may differ from decoded audio by at most 250 ms to accommodate decoder rounding.
- At most 512 scenes in the plan format, nine cast names per scene, 40 characters per cast name, and 4,000 characters per beat. A hosted quote accepts fewer scenes; read `contract.generation.maximumScenesPerQuote`. The managed shared project also has a tighter `contract.workspace.maximumScenes` limit (currently 120) and 512 KiB workspace size limit. Keep workspace scene text within its 2,000-character limit even though the portable beat field accepts 4,000.
- Cast names must exactly match the loaded named cast after case-insensitive normalization.
- Every beat is non-empty and self-contained because scenes are generated independently.
- Assign each visible singer one immutable speaker ID for the complete production, such as `LEAD=S1, FRIEND=S2`. Reusing or remapping an ID to another singer invalidates the plan even when individual scenes read plausibly.

## Beat construction

- Use local scene timestamps such as `00:03.420`; never repeat global song time inside a scene prompt.
- Treat `scene.cast` as membership only. SLOPCANNON keeps provider reference labels in stable project-cast order.
- Put vocal annotations inside `beat` in chronological order, beginning with the first vocal event. This prompt order does not reorder reference labels.
- Keep the exact lyric context the user supplied or that was lawfully transcribed when it is needed for direction and sync. Do not paraphrase a line that the visible performer must mouth.
- Compute every visible vocal timestamp as `localMs = absoluteWordOnsetMs - scene.startMs`. Then write the explicit named singer, its immutable speaker ID, and an H3 control span: `At 00:03.420, LEAD (S1) sings, <d>[English]Exact lawful lyric.</d>`.
- Use the correct language tag in every `<d>[Language]...</d>` span. A generic phrase such as "sings to camera" is not sufficient for visible vocal performance. The strict validator refuses any visible sing, rap, whisper, lip-sync or perform-the-line verb in a scene with no `<d>` span, including background action such as "guests whisper". To show a crowd singing, give it a span or keep the singing out of the visual.
- Spoken lines use `says` in place of `sings`: `At 00:01.410, KAYLEIGH (S1) says, <d>[English]Brodie! Hi!</d>`.
- A line heard from someone who is not on camera (a narrator, an intercom, an off-screen reply) gets no `<d>` span. Name its window and close the visible mouths instead: `From 00:01.620 to 00:05.120 an off-screen voice speaks; KAYLEIGH's mouth stays closed during it.`
- Off screen is decided per scene: a speaker who is not in a scene's `cast` is off screen in that scene. The validator refuses a `<d>` span whose speaker ID maps to no cast name in the scene's direction text; a cast name inside the lyric, such as a product named in the line, does not map it.
- State which visible characters remain silent and keep their mouths closed for the full conflicting line or interval.
- Stage every named subject in every shot: its orientation (facing relative to camera and frame) and motion vector (direction of travel with a pace) in round brackets straight after its name, as in the example above and [direction.md](direction.md#staging-orientation-and-motion). Put the staging in the shot's setup, not between a name and its `(S1)` tag. The validator does not check staging.
- Every recurring visible singer needs a named cast reference. If a requested singer has no reference, ask for one, keep the voice offscreen, or make the event explicitly nonverbal.
- Include one visual continuity anchor entering and leaving the scene.
- Avoid relying on the previous generated frame unless the provider explicitly supports it and the current job supplies it.

## Two independent sync checks

- **Mouth sync:** use the matching server-created scene-audio chunk as `sourceAudioAssetId`, then inspect whether the named visible singer follows the local timestamped `<d>` line. The WAV must contain exactly `[startMs,endMs)` beginning at local zero, followed only by silence through `requestSeconds`. This is a generation/take quality check.
- **Soundtrack sync:** inspect whether deterministic assembly trims video to every exact `startMs`/`endMs` range, removes clip audio, and muxes the unshifted, untrimmed master content from PTS 0. This is an export quality check; the CLI encodes the master content to AAC once for MP4 compatibility.

Whole-second provider request durations must never be written back into the timed plan. A provider may return padded video beyond `endMs - startMs`; the assembler must trim that padding rather than allowing cumulative drift. Arbitrary millisecond boundaries quantize once to the single global output frame grid, within half a frame, rather than once per scene.

For the one-scene hosted quote, retain absolute source times, set `timedPlan.durationMs` to that scene's `endMs`, and name the server chunk as `sourceAudioAssetId`. This differs from the complete continuous plan above; see [hosted-api.md](hosted-api.md). `validate-timed-plan.mjs` accepts such a plan as written, with every other rule unchanged; pass `--duration-ms` only as the scene's `endMs`, or omit it. Workspace scenes use seconds (`start`/`end`), not this format's integer milliseconds.
