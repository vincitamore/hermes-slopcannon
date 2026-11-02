---
name: slopcannon-music-video
description: Direct, generate, review, reroll, and finish a music video, source-video remix or audio-first ad using SLOPCANNON, named character references, and a creative concept. Use for music videos, MP4/MOV video-to-video edits, changes to style, setting or cast, lyric videos with performed vocals, voiced ads, PSAs and sketches made in the Ad Cannon and then filmed, MiniMax Hailuo 3/H3 video, timed multi-character lip-sync, and scene-by-scene production plans.
---

# SLOPCANNON music video

Turn a song, named cast, and concept into a coherent finished music video. Treat SLOPCANNON as the execution harness and act as the director: establish clean context, align vocals, author a timed plan, control spend, review takes, and verify the master.

The workflow is host-neutral. The optional timed-plan validator requires Node.js 22 or newer with ESM and Unicode property escapes. Hosted paid rendering requires a funded SLOPCANNON account and authorized access; customers do not need a provider account or vendor API key.

## Choose an operating surface

1. For the hosted service, start at `https://api.slop.cc/v1/capabilities`; use a different origin only when the user explicitly supplies one. Treat the returned document as authoritative about current surfaces, provider limits, and payment availability, and use the absolute URLs in its `endpoints` object for every later call rather than the host that served a document. The customer site and partner API run separately: `https://slop.cc/api/v1/capabilities` is not the partner runtime. When `hostedRuntime.submissionReady` is false on the intended API origin, report the missing capability before attempting paid work.
2. Prefer authenticated SLOPCANNON MCP tools only when that manifest enumerates their exact names.
3. Otherwise use the SLOPCANNON HTTP agent API only when the manifest declares the required operation and schema.
   With a shell, drive both through the bundled CLI, `scripts/slopcannon-agent.mjs`, which owns the ledger, idempotency keys, byte caps, duration headers, and the approval check; read [references/agent-cli.md](references/agent-cli.md) first.
4. Otherwise operate the browser workstation at the URL the user supplies. For a local checkout, try `http://localhost:3000` only when the user says SLOPCANNON is running locally.
5. Do not invent endpoints or claim a job was submitted without a returned job identifier.

Read [references/hosted-api.md](references/hosted-api.md) before using the hosted HTTP API or MCP server. Read [references/agent-cli.md](references/agent-cli.md) before driving the hosted agent plane from a shell. Read [references/app-workflow.md](references/app-workflow.md) before operating the browser workstation. Read [references/timed-plan.md](references/timed-plan.md) before creating or importing a timestamped script. Read [references/direction.md](references/direction.md) for multi-character vocals, continuity, and prompting. Read [references/assembly.md](references/assembly.md) before submitting server assembly or delivering the master. Read [references/spend-and-safety.md](references/spend-and-safety.md) before any paid submission or payment.

For companies integrating whole productions into their own product or queue, read [references/company-integration.md](references/company-integration.md) — the end-to-end quickstart, from minting a token to reconciling the ledger, including the organizations surface a reseller uses. Prefer one production manifest and total budget with durable batch progress, not manual clip-by-clip orchestration. Distinguish the client-managed whole-project workflow from the underlying per-scene API: upload the master once, use server scene-audio slicing, and retain one project for the film. The platform offers no whole-project batch endpoint and no project-completion webhook. If a required managed capability is unavailable, preserve the project and report the missing capability before spending.

## Gather the production brief

For a source-video remix, use [the hosted source-video workflow](references/hosted-api.md#produce-from-an-owned-source-video), after live discovery confirms preparation, generation and assembly readiness. Keep the original footage as video; do not run the song-analysis or audio-slicing steps below as a substitute. A remix may change style, setting, action or cast and supports named references within live limits. Continue in the same project when revising an existing production.

For an ad, PSA, sketch or other spoken piece, where the words come first, go audio-first with the Ad Cannon ([steps](references/hosted-api.md#make-an-audio-first-ad-the-ad-cannon)):

1. Read the lengths, prices and voices with `slopcannon_audio_spot_options`, and cast each character with a voice (an existing clone, a stock voice or `"design"`) and, if they appear on camera, a reference picture in the project.
2. Tell the person the price of the length, and get their approval of it and their rights sign-off. Then create the spot with that price as `maxCredits`; a higher price is refused before anything is reserved.
3. Poll it to done, play it, and change any line, sound effect or music cue they ask for (free).
4. Load it into the Cannon and film to its cut list: each shot is already a scene carrying its timed lines and who is on camera.

Voice clones are made by the person on the Ad Cannon page, never by an agent. From a shell, the bundled CLI's `spot` verb does each step.

For music, require:

- one MP3 or WAV song;
- a concept or intended emotional/comedic arc.

Require a named reference image when the brief needs an identifiable character to remain consistent. References are optional for instrumental, abstract, landscape or other productions without that identity requirement.

Ask only for missing choices that materially change the result. Infer ordinary directing choices. Record optional constraints when provided: aspect ratio (the project's frame: create the project at it and quote at the same one, or the quote is refused), character vocal roles, lyrics or captions, visual references, ending, content limits, budget ceiling, and delivery filename.

Before any song or reference bytes leave the user's device, ask the human to confirm, for the files you will upload (including derived scene WAVs) and the disclosed service purpose of processing and combining them to create and deliver the project video that they own, are licensed to use, or otherwise have the legal right to upload them; for music, this includes both the sound recording and the composition/lyrics. The confirmation must be explicit, and one covers the rest of the session as set out below. Possession, a previous session, silence, project ownership, or a general request to make a video is not assent.

For a browser checkbox or other human-only control, the human must personally review and activate it. For a documented CLI or API flow:

- First fetch the current statement, version, and policy links from the platform's pre-upload discovery endpoint; do not send media to discover them.
- Present SLOPCANNON's complete platform-supplied statement verbatim, show the platform-supplied Terms and Acceptable Use links, and identify the exact files (including derived scene WAVs) and the disclosed service purpose.
- Wait for the human's explicit affirmative sign-off in their own words. `I agree` is sufficient, but no magic phrase is required: an unambiguous post-disclosure instruction to relay the displayed attestation or proceed with the upload also counts.
- Only then may you relay the platform-supplied version unchanged with the matching upload. The sign-off authorizes the documented relay, not assent generated without the operator's direction.
- Ask once per session. A sign-off covers that statement version for the rest of the session: every later file the same human supplies or directs you to create for their productions rides it without asking again. Name each file as you upload it, as information, not a question. Ask again only when the platform's `requiredVersion` changes, a different person or account directs the work, or the human withdraws the sign-off.
- Never infer assent or rights from possession, silence, a previous session, or a general or pre-disclosure production request; never invent the operator's sign-off, check a browser control, auto-set a field before assent, alter or invent the statement or version, or fabricate a receipt.
- If the exact statement and links are unavailable or the human does not affirm, pause before upload rather than bypassing the gate.
- If you cannot send files yourself (for example a claude.ai or Claude Desktop connection with no shell), call `slopcannon_create_upload_link` and give the human its `uploadPageUrl`. The page shows the statement, records their confirmation and takes the file; read the `assetId` from `slopcannon_get_upload_link`.
- Preserve any stated attribution, usage, or distribution constraint.

## Start with clean context

Create a new project before attaching the current song or references. Do not reuse earlier treatments, cast, prompts, take descriptions, scene plans, or generated frames unless the user explicitly asks to continue that exact project.

Name every reference unambiguously. Preserve the loaded cast order, but write scene text with character names; let SLOPCANNON compile names into provider reference positions.

Each `character_reference` image must depict one recurring individual. Never upload a multi-character lineup or grid sheet and index individuals by position (`"soldier 3"`, `"top-left figure"`): the video model binds each reference slot as a single subject and will spawn extra figures mid-shot or morph proportions when another character enters.

Give a business's own photos of its food, products, objects or places `kind: "product"`: `cast[].kind` in a quote, `references[].kind` in a CLI production. A product may be cut, sliced, held, plated or seen from any angle while keeping its ingredients, colours, textures and style. The character check judges it on identity, not shape.

## Analyze before generating

1. Measure the exact song duration. The normal hosted workflow uploads the master after rights assent and obtains the decoded duration from server scene-audio preparation; local media tools are not required.
2. Obtain lawful lyrics and word timing when vocals matter, using supplied timing or an available transcription tool appropriate to the user's permissions. Hosted song analysis is optional: check `songAnalysisControlReady` before using it. Keep the exact lawful lines in working context when they are needed for direction and synchronization; do not reduce them to vague semantic cues.
3. Build a cue sheet with absolute start/end times and one speaker or ensemble owner per sung phrase. Declare one immutable named singer-to-speaker-ID map for the production, such as `LEAD=S1, FRIEND=S2`; never remap an ID in a later scene.
4. Mark instrumental sections and uncertain words explicitly.
5. Choose phrase-safe scene boundaries within `contract.generation.sceneDurationMs` from the capability manifest (5,000 through 15,000 milliseconds). Never cut through an intelligible word or sustained syllable when a legal boundary exists.
6. Keep rapid one-to-three-second edit ideas as internal shots inside a provider-valid scene instead of creating invalid generation durations.

If one intelligible phrase or sustained syllable exceeds the provider maximum, report the hard conflict. Prefer an off-mouth visual cut, a perceptually quiet internal split with continuity instructions, or a different model. Audition the result; do not pretend exact continuous lip-sync is possible across an unsupported duration.

Audition uncertain cues. A timestamped lyric is authoritative only after it matches the supplied audio.

## Direct the full arc

Write one compact production bible before individual scenes:

- visual language and camera grammar;
- identity locks for each named character;
- vocal ownership policy;
- continuity anchors between scenes;
- forbidden drift, text, logos, transformations, or prior-project motifs;
- beginning, escalation, climax, and final image.

Keep `project.treatment` (and the production bible) to visual world, style, character identity locks, and story arc only: it is compiled into every scene's video prompt, so never embed workflow, quoting, approval, or credit instructions in it. In every scene, give each named subject in every shot an explicit orientation and motion vector in round brackets after its name, such as `LEAD (profile, facing frame-left; walks right to left, easy pace)`: the way it faces relative to camera and frame, and the way it travels with a pace. Movement goes forward in the direction faced, and subjects look at each other or their path rather than the lens unless the shot calls for a look to camera (see [references/direction.md](references/direction.md#staging-orientation-and-motion)). State camera movement relative to character travel explicitly: when characters walk or march toward a frontal lens, write `"backward-tracking camera"` (camera retreats ahead of them); when tracking forward behind advancing characters, write `"seen from behind, backs to camera"` so front-facing reference portraits are not animated walking backward.

Give every scene a distinct story job. Re-establish the exact cast and identity locks inside each independently generated scene. For a mascot, plush or other non-human character, keep the camera in front of it: the video model invents what the reference does not show, so orbits, back views, riding away, walking off and props that hide the body produce tails, extra faces and duplicates. Describe the body positively ("one smooth seamless egg-shaped body with only two arms and two legs"); writing "no tail" makes tails more likely. Preserve the production's immutable named singer-to-speaker-ID map. For every visible vocal line, compute `localMs = absoluteWordOnsetMs - scene.startMs`, then use that exact local timestamp, the named singer and fixed speaker ID, and an H3 control span such as `At 00:02.180, LEAD (S1) sings, <d>[English]Exact lawful lyric.</d>`. State which visible characters must keep their mouths closed. A generic instruction such as "sings to camera" is not a vocal timing instruction.

## Build and validate the timed plan

Create schema version `1` JSON covering the song continuously. Use exact integer milliseconds, named cast strings, and one self-contained `beat` per scene. Resolve paths relative to this `SKILL.md`, then run:

```text
node <skill-directory>/scripts/validate-timed-plan.mjs <plan.json> --duration-ms <decoded-duration> --cast "NAME 1,NAME 2" --require-h3-vocals
```

The strict vocal flag rejects generic visible-singing instructions unless every H3 dialogue span has an exact local onset, a stable speaker ID mapped to a named scene cast member, and an explicit silent-mouth rule when another cast member is present. Any visible sing, rap, whisper, lip-sync or perform-the-line verb in a scene with no span is refused, including background action such as "guests whisper". A speaker who is not in a scene's cast is heard off screen in that scene, with no `<d>` span and every visible mouth closed while the line plays. A one-scene quote plan that carries `sourceAudioAssetId` validates with its absolute times. Fix every reported issue before importing. Do not omit the flag or soften timing validation to make a lyric-aware plan pass.

## Prepare exact scene audio references

Use the hosted scene-audio tools described in [references/hosted-api.md](references/hosted-api.md). Upload the master once after rights assent, submit the complete contiguous scene windows, and poll the returned ticket. Each resulting chunk is the exact master range at local zero, with silence only for provider padding. Quote with the master as `songAssetId`, the chunk as the scene's `sourceAudioAssetId`, and the scene's original absolute times. If server slicing is unavailable, stop before paid generation; do not silently create a different project for every scene.

## Require a spend gate

Before any paid generation:

1. Obtain a server-issued quote showing the model, resolution, number of new jobs, billable duration, reference surcharges, currency, expiry, and estimated total.
2. Obtain explicit approval for the exact quoted amount, or for a hard cap that covers it.
3. Submit one scene first. Ask the user to review identity, motion, vocal ownership, and audio-driven mouth timing on that delivered take before submitting any further scene. Non-spending project-wide quotes can be presented together; the CLI binds this review to the first downloaded artifact's SHA-256.
4. Obtain explicit approval for each subsequent quote, or an equal-or-lower standing cap that covers it.

A token issued by an organization spends its owner's wallet under a ceiling set for it, and says so: `GET /v1/billing/balance` answers with `scope: "organization-customer"` and an `availableCredits` that is the smaller of the remaining ceiling and the owner's spendable balance. Treat that figure as the real limit — it is exactly what the next reservation may draw — and report a refusal past it as a ceiling the customer's reseller set, not as a platform fault. `GET /v1/usage` on such a credential pages only the postings that customer is answerable for. Never ask for a ceiling to be raised on the user's behalf; that is the reseller's decision.

Where the manifest advertises tracked render requests, the managed CLI declares the complete approved film before its first paid scene, journals its request key and binds every member. Preserve this identity through first-scene review and reconnect; never replace it with an untracked purchase. For a confirmed failed member, `video retry-failed` reads its exact server settlement, retains its predecessor and stages only that member for a fresh quote and approval; it spends nothing. A retry keeps the member's declared length and cast pictures; a changed cast or pictures is a new revision. The new execution stays under the original film clock and scope, while old attempts remain in history and the spending ceiling. Recover pending/unknown submissions with their original keys.

Read `contract.generation.minimumCannonCreditsPerGeneration` before proposing a short test clip: when a generation bills a fixed floor, a deliberately short probe costs the same as a real scene, and the first real scene is the cheaper gate. Where a quote holds one scene, every scene is already its own approval; do not add a separate paid probe in front of it. An earlier approval applies only to the quoted project and cap. Rerolls are new paid work and require the user’s standing reroll instruction or another approval.

## Storage belongs to the account holder

Each account has 35 GiB of project storage, and a person can add blocks of 10 GiB for 10 Cannon Credits a month on the Account page. Finished films sit outside that allowance (up to 100 GiB of films per account), and one duplicate of a file is free: byte-identical copies count once between the first two, and each further copy counts in full. `GET /v1/storage` (needs `billing:read`) reports what is used, the allowance, the paid blocks and the bytes by kind. At or over the allowance, a new quote, render, upload, song analysis or audio spot is refused with `413 STORAGE_LIMIT_EXCEEDED`, carrying `usedBytes`, `allowanceBytes`, `includedBytes` and `paidBlocks` in `details`. Work that is already paid for (a delivered take, a render's inputs, an assembled film) is still saved past the allowance, so an admitted render is never lost to it.

When you see the refusal, stop and tell the account holder: how full storage is, that they can add storage on the Account page (10 credits a month per extra 10 GiB) or choose projects of their own to delete, and that a deleted project frees its space only after 3 days. Then wait for their answer. **Never delete a project, take or asset, and never schedule a project for deletion, to make room unless the account holder has named that project and told you to.** The refusal is not a reason to retry, to open another project, or to spend elsewhere; a person buys storage, an agent never does.

## Drive the hosted agent plane from a shell

When the capability manifest reports `submissionReady` and `contentReady` and a shell is available, the bundled CLI performs the whole drive with the human asked only for the prompt, one explicit rights sign-off per session after disclosure, the quote approval (or a standing cap), and feedback on delivered takes:

```text
node <skill-directory>/scripts/slopcannon-agent.mjs run --production production.json
```

It stops with exit 2 and a machine-readable `needs` at rights, approval, total-budget and first-scene-review gates, and resumes from its ledger. `--max-credits` caps the entire production, including previous or uncertain attempts; it is not a fresh allowance on each run. After actual first-scene review, `--review-first <exact artifact sha256>` unlocks the remaining approved scenes in bounded parallel lanes. Author the production file from the user's brief (title, song, references, singer, direction per scene, transcript when vocals are timed); never author the lyric text yourself, and never pass the token as a flag. Read the installed CLI guide for runtime requirements and the exact managed workflow; do not treat installing the skill as configuring account access. [references/agent-cli.md](references/agent-cli.md) lists every verb, the production file, and the failure handling.

## Generate, review, and finish

1. After the first delivered scene has been reviewed, submit the remaining approved first-pass scenes concurrently. `video run --concurrency` takes 1–16 and defaults to 4; four is only the default, not an account limit. Raising it is safe: a scene that cannot start right away waits its turn. On MCP or HTTP, keep several generations in flight: capabilities give `contract.generation.inFlight` (start at its `default`, go up to its `maximum` for the account). If a submission is refused because the account is full, wait briefly and submit the same request again with the same `idempotencyKey`.
2. Preserve every accepted job ID and prior take. Resume accepted jobs instead of submitting duplicates.
3. Review each take for identity, speaker accuracy, continuity, anatomy, unwanted text/logos, and transition compatibility. `video check --scene <id>` (MCP `slopcannon_check_take`) has a vision model watch the take next to the cast's reference pictures and names defects with the second they appear at: an extra tail, face or limb, a duplicate, a changed shape, or a mouth moving in a voice-over shot (for a product: a different product, one deformed or melted wrong, or garbled text). Use it on every take, then look yourself at any back or side view; a failing check is shown to the user, never rerolled without approval. With approval, `video reroll --scene <id>` makes one new take of that scene and `video cut` finishes the film with it ([agent-cli.md](references/agent-cli.md#reroll-one-scene)).
4. Approve usable takes. Reroll only failed scenes and retain older variants until deliberately deleted.
   - SLOPCANNON persists completed generations as `generated_take` assets; `GET /v1/generations/{id}/content` reports `bytes`, `sha256`, `assetId` and `workspaceAttachment` when available.
   - Check placement separately: `pending` is unresolved, while `unattached` includes a terminal placement reason. Preserve the stored artifact and repair the workspace deliberately; never regenerate to fix placement.
   - Record the decision in the workspace: `workspace --project <id>` prints each scene's takes and the revision a change must carry, and `select --project <id> --scene-id <n> --take <n> --revision <n>` writes the choice back. The MCP twins are `slopcannon_get_workspace`, `slopcannon_select_take` and `slopcannon_delete_take`, each carrying the same revision.
   - Send the revision exactly as read; a conflict means someone saved in between, so read again rather than forcing the write.
   - Deleting a take releases its stored video permanently and refunds nothing, and a scene's selected take is refused until another take is selected — so delete only what the user has decided to discard.
   - Selection reflects the user's judgment, never your own.
5. Assemble the intended takes against the master song. CLI `run` finishes its verified ledger takes, even if workspace selections later change. To finish the current workspace selections, use `slopcannon_start_assembly` with `clips` omitted; an explicit clips list controls its own take choice. The provider's whole-second render duration is billing/input padding, never a timeline duration. Trim each take to its exact scene source range, discard every generated clip audio track, and place the unshifted, untrimmed master content at PTS 0. The renderer encodes master content for MP4 compatibility; "master content" does not promise byte-for-byte audio passthrough.
6. Save a local or durable MP4 with a descriptive filename.
7. Read `contract.assembly.serverReady` before choosing server assembly.
   - `POST /v1/assemblies` uses the included server assembly; there is no separate fee or credit debit. Native assembly uses original takes and verified frame boundaries.
   - Retrieve the finished file through `POST /v1/assemblies/{id}/download-links`, then the issued capability URL.
   - `DELETE /v1/assemblies/{id}` cancels a native render once the compatible service confirms shutdown. A 503 means confirmation is pending; retry the same assembly and do not create a replacement.
   - Follow [references/assembly.md](references/assembly.md), verify the returned artifact, and retain the native `syncVerified` status, bytes and digest.
   - Local assembly is available on explicit choice with `run --assembly local`, using the same project, plan, master and verified ledger takes; only this mode needs local FFmpeg/FFprobe and returns the full JSON report.
   - Read the actual renderer (`engine`) and verification fields; readiness alone is not an output-quality certificate.
8. Check the server completion receipt, native `syncVerified` when applicable, and downloaded artifact byte count and digest. Review the actual picture, soundtrack and requested final beat; a server receipt cannot judge creative quality or mouth movement. For explicit local assembly, also inspect the full decode and sync report. Report issued customer credit exposure separately from settled spend; report actual provider spend only if a trustworthy receipt exposes it. Missing settlement evidence is unavailable, not zero. A generation status read carries a `settlement` block with the credits reserved, debited and refunded for that job, and `usage` pages the same ledger; those are settled spend, and the issued quote is exposure.

For large local masters, let the managed driver select the advertised resumable upload only after authenticated readiness. Preserve its file, manifest, upload key and session across interruptions; an accepted upload keeps its session, so resume it rather than starting another. Never downscale or recompress to fit a transport limit. See [hosted API recovery](references/hosted-api.md) for the HTTP protocol; MCP arguments carry metadata, never media bytes.

Treat mouth sync and soundtrack sync as separate quality gates. Mouth sync means the visible named performer follows the scene's local vocal timestamps and H3 dialogue spans against the exact prepared scene WAV beginning at local zero. Soundtrack sync means the final MP4 contains the unshifted, untrimmed master content from PTS 0 while exact source-range visuals cover the same duration. Arbitrary millisecond boundaries are quantized once onto the global output frame grid, within half a frame; never round each scene independently and accumulate the error. Passing one gate does not prove the other, and the assembler report does not evaluate mouth movement or take quality.

## Success criteria

Deliver:

- the finished MP4 or official full-file download link (refresh its session on expiry);
- actual spend and reroll count;
- a private production record of assembly identity and verification evidence, available on request;
- a concise note about any unresolved visual or transcription weakness;
- the project plan and selected-take state when the user may continue editing.

Do not call a preview, simulated take, pending job, or unverified assembly finished.
