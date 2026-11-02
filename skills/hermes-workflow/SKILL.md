---
name: hermes-workflow
description: Make a SLOPCANNON music video, source-video remix or audio-first ad from inside Hermes with the slopcannon plugin tools. Load before any SLOPCANNON production in Hermes; it maps the canonical workflow onto the plugin's tools and gates.
---

# SLOPCANNON in Hermes

The plugin registers every SLOPCANNON server tool under its own name (`slopcannon_create_project`, `slopcannon_create_quote`, `slopcannon_submit_generation`, ...), exactly as the canonical skill and `references/hosted-api.md` name them, plus four tools only a local agent has. Together they replace the CLI and browser hand-offs the canonical skill describes; the creative and safety rules in `slopcannon:slopcannon-music-video` still apply in full. Load it with `skill_view("slopcannon:slopcannon-music-video")` before writing a treatment or a timed plan, and read its references when a step names them.

| Need | Tool |
|---|---|
| Connection, balance, limits, rights statement | `slopcannon_account` |
| Song or reference picture from disk into a project | `slopcannon_upload` |
| Everything the server does (projects, analysis, scene audio, planning, direction, references, quotes, generation, takes, assembly, characters, audio spots, ad pitches, Slop TV) | the `slopcannon_*` server tools, called directly |
| Wait for renders or the final cut, and bring them home | `slopcannon_wait` |
| Fetch one clip or the master now | `slopcannon_download` |

## Rules that differ from other hosts

- **Never handle a credential.** The plugin holds the token. If `slopcannon_account` says not connected, tell the person to run `/slop login` (desktop or terminal) and stop. Never ask for a token in chat and never put one in a file.
- **Uploads go from disk.** Use `slopcannon_upload`, not upload links, when the file is on this machine. Use `slopcannon_create_upload_link` only when the person has the file somewhere Hermes cannot read (their phone).
- **Rights sign-off.** Present the statement from `slopcannon_account` verbatim with the exact files, wait for their explicit agreement, then pass `rights_version`. Hermes also shows an approval prompt for the upload; both are needed. One sign-off covers the session for that version (canonical skill, "Gather the production brief").
- **Spend.** Quote with `slopcannon_create_quote`, tell the person the exact Cannon Credits, and on their go-ahead call `slopcannon_submit_generation` with `approval.amountUnits` equal to the quote. Hermes shows its own approval prompt with that figure; the server refuses any figure other than the quote. A refusal is final for that call: do not retry it with a different amount.
- **First scene first.** Submit one scene, `slopcannon_wait` for it, show it, and get the person's review before submitting the rest. Then keep several in flight (capabilities `contract.generation.inFlight`).
- **The schemas are the contract.** Each server tool carries the server's own schema and rules; read its description before the first call and do not guess field names. If a tool you expect is missing, the person can run `/slop sync` and start a new session.
- **Idempotency.** Every paid submission carries a durable `idempotencyKey`. After a timeout, call `slopcannon_recover_generation` with the same key; a new key buys again.

## Showing video

`slopcannon_wait` and `slopcannon_download` save MP4s under the plugin's download folder and return `media` lines such as `MEDIA:C:/.../scene.mp4`. Put each one alone on its own line in your reply: Hermes desktop plays it inline, and messaging platforms receive it as a native video. In the terminal UI, which has no attachment channel, give the path instead. Do not paste capability download links into shared chats.

## A music video, end to end

1. `slopcannon_account`: confirm connected and `submissionReady`; note `rights.requiredVersion` and `generation` limits.
2. Brief: song, concept, cast pictures, aspect ratio (it fixes the project's frame).
3. `slopcannon_create_project` (with an `idempotencyKey`), then rights sign-off, then `slopcannon_upload` the song (`kind: song`) and each reference (`character_reference` or `set_reference`), then `slopcannon_add_reference` for each.
4. Analysis and plan: `slopcannon_start_song_analysis` / `slopcannon_get_song_analysis` when vocals matter, `slopcannon_plan_cuts`, `slopcannon_direct_scenes` (or write the timed plan yourself per the canonical skill), then `slopcannon_slice_scene_audio` / `slopcannon_get_scene_audio`.
5. Quote scene one, get approval, submit, `slopcannon_wait`, show the clip, get review. `slopcannon_check_take` on every take.
6. Quote and submit the remaining scenes on approval; `slopcannon_wait` with all IDs.
7. Select takes (`slopcannon_get_workspace`, `slopcannon_select_take` with the revision), then `slopcannon_start_assembly` and `slopcannon_wait` with `assembly_id`. Deliver the master's MEDIA line.
