---
name: hermes-workflow
description: Make a SLOPCANNON music video, source-video remix or audio-first ad from inside Hermes with the slopcannon plugin tools. Load before any SLOPCANNON production in Hermes; it maps the canonical workflow onto the plugin's tools and gates.
---

# SLOPCANNON in Hermes

The plugin registers every SLOPCANNON server tool under its own name (`slopcannon_create_project`, `slopcannon_create_quote`, `slopcannon_submit_generation`, ...), exactly as the canonical skill and `references/hosted-api.md` name them, plus tools only a local agent has: whole productions in one call, uploads from disk, song timing, waiting, and video home as native media. Together they replace the CLI and browser hand-offs the canonical skill describes; the creative and safety rules in `slopcannon:slopcannon-music-video` still apply in full. Load it with `skill_view("slopcannon:slopcannon-music-video")` before writing a treatment or a timed plan, and read its references when a step names them.

| Need | Tool |
|---|---|
| A whole music video from a song, gates and all | `slopcannon_produce`, then `slopcannon_production_status` |
| Word-timed lyrics for a song (no credits) | `slopcannon_transcribe` |
| Stop a running production | `slopcannon_production_stop` |
| Connection, balance, limits, rights statement | `slopcannon_account` |
| Song or reference picture from disk into a project | `slopcannon_upload` |
| Everything the server does (projects, analysis, scene audio, planning, direction, references, quotes, generation, takes, assembly, characters, audio spots, ad pitches, Slop TV) | the `slopcannon_*` server tools, called directly |
| Wait for renders or the final cut, and bring them home | `slopcannon_wait` |
| Fetch one clip or the master now | `slopcannon_download` |

## Rules that differ from other hosts

- **Never handle a credential.** Hermes holds the sign-in and the plugin holds only short-lived sessions. If `slopcannon_account` says not connected, tell the person to run `hermes auth add slopcannon:slop` in a terminal on the Hermes machine (it cannot start from a chat), or to enter a slop.cc/account token as the plugin's Agent token setting, and stop. Never ask for a token in chat and never put one in a file.
- **Uploads go from disk.** Use `slopcannon_upload`, not upload links, when the file is on this machine. Use `slopcannon_create_upload_link` only when the person has the file somewhere Hermes cannot read (their phone).
- **The film card is where the person decides.** On Hermes desktop a production's gates (rights sign-off, the credit quote, the first scene, keep or reroll each flagged take, a reroll's quote) are answered on the film card: its buttons record the person's answer and resume the film, and the card shows each next step live. So at a gate, write the result's `show` lines and one short sentence on what the card asks, then end your turn; never answer a gate yourself and never ask them to type "I agree" or "yes". Only when the person answers you in chat, or the surface has no card (CLI, messaging), pass their answer to the tool (`rights_version`, `approve_credits`, `review_first`, `accept_checks`, `reroll`, `approve_reroll`): Hermes then asks them in its approval prompt, which carries the rights statement verbatim with the exact files. For the per-scene tools, spends and sign-offs always go through that approval prompt. A Deny is final for that call: tell the person and stop.
- **Files in the folder.** Use only the files the brief names. Anything else there (old receipts, notes from another run) is not part of this production: ignore it without comment.
- **Rerolls.** To replace delivered scenes, make ONE `slopcannon_produce` call with the production_id, `reroll: [{scene, direction}, ...]` listing every scene to replace, and `accept_checks` for the flagged scenes kept. Answer the combined quote with `approve_reroll` (one approval prompt). The new takes render together and the production cuts them into the film. Never rebuild a scene with the per-scene tools: that work is outside the film, and the plugin refuses it.
- **Spend.** Quote with `slopcannon_create_quote`, show the exact Cannon Credits, and call `slopcannon_submit_generation` with `approval.amountUnits` equal to the quote. Hermes shows its own approval prompt with that figure; the server refuses any figure other than the quote. Do not retry a refused or denied call with a different amount.
- **First scene first.** Submit one scene, `slopcannon_wait` for it, show it, and get the person's review before submitting the rest. Then keep several in flight (capabilities `contract.generation.inFlight`).
- **The schemas are the contract.** Each server tool carries the server's own schema and rules; read its description before the first call and do not guess field names. If a tool you expect is missing, the person can run `/slop sync` and start a new session.
- **Idempotency.** Every paid submission carries a durable `idempotencyKey`. After a timeout, call `slopcannon_recover_generation` with the same key; a new key buys again.

## Showing video

`slopcannon_wait` and `slopcannon_download` save MP4s under the plugin's download folder and return `media` lines such as `MEDIA:C:/.../scene.mp4`. Put each one alone on its own line in your reply: Hermes desktop plays it inline, and messaging platforms receive it as a native video. In the terminal UI, which has no attachment channel, give the path instead. Do not paste capability download links into shared chats.

## A music video: the managed path (use this by default)

`slopcannon_produce` runs SLOPCANNON's own production driver in the background: project, uploads, server scene audio, the timed plan, quotes, one first scene for review, parallel renders, character checks and server assembly. It is resumable and never buys a scene twice.

1. `slopcannon_account`: connected, `submissionReady`, `rights.requiredVersion`, the aspect ratios.
2. Brief: the song path, the cast pictures, the concept, the aspect ratio. If the person already supplied a timed plan, pass it as `timed_plan` unchanged (the production validates it; do not run node or the skill's scripts, which belong to the plugin) and skip steps 3 and 4's cuts and scenes.
3. Otherwise `slopcannon_transcribe` with the song and `rights_version` (Hermes shows the person the rights prompt). Read the excerpt.
4. Write the production (canonical skill `references/agent-cli.md`, "The production file"): `title`, `song`, `references` (`name` in capitals, `path`, and `kind: "product"` for a set, place or object; people need no kind), `singer`, `identityLock`, `transcript` (the path from step 3), `cuts`, `scenes` [{`shot`, `cast`}], `aspectRatio`. Apply the canonical skill's direction rules to every shot.
5. `slopcannon_produce` with `production` (and `timed_plan`), without `rights_version`: the driver uploads, hashes and quotes by itself (do not hash files or call the API by hand) and stops at each human gate. At each one, write the `show` lines (the film card, plus the clip being judged) and one sentence, then end your turn: the person answers on the card (rights, the quote, the first scene, flagged takes) and the film continues by itself. `next` says what to do if they answer you in chat instead.
6. Finished: the master arrives as a MEDIA line. Ask the person to judge identity, mouth timing and take quality.

Never pass an answer the person did not give. To change the direction after paid work began, start a new `production_id`; the old one stays recoverable.

Every production result carries `show`: the film card line (`::slopcannon-film{id="..."}`) and the clips the person is about to judge (the first scene, the flagged takes, the finished film). Write those lines in your message text as soon as you get them. On surfaces without the desktop keep only the MEDIA lines. The desktop's SLOPCANNON studio page (sidebar) shows every production live, with the same buttons.

## A music video, tool by tool (when the person wants scene-level control)

1. `slopcannon_account`: confirm connected and `submissionReady`; note `rights.requiredVersion` and `generation` limits.
2. Brief: song, concept, cast pictures, aspect ratio (it fixes the project's frame).
3. `slopcannon_create_project` (with an `idempotencyKey`), then `slopcannon_upload` the song (`kind: song`, with `rights_version`; Hermes shows the rights prompt) and each reference (`character_reference` or `set_reference`), then `slopcannon_add_reference` for each.
4. Analysis and plan: `slopcannon_start_song_analysis` / `slopcannon_get_song_analysis` when vocals matter, `slopcannon_plan_cuts`, `slopcannon_direct_scenes` (or write the timed plan yourself per the canonical skill), then `slopcannon_slice_scene_audio` / `slopcannon_get_scene_audio`.
5. Quote scene one, submit it (Hermes shows the figure), `slopcannon_wait`, show the clip, get review. `slopcannon_check_take` on every take.
6. Quote and submit the remaining scenes (one approval prompt each); `slopcannon_wait` with all IDs.
7. Select takes (`slopcannon_get_workspace`, `slopcannon_select_take` with the revision), then `slopcannon_start_assembly` and `slopcannon_wait` with `assembly_id`. Deliver the master's MEDIA line.
