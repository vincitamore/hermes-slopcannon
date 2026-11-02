# Hosted agent plane CLI

Use `slopcannon video run --production production.json --ledger production-ledger.json` for a managed production. The agent authors the production file from the creative brief, manages one project, uploads the master once and uses server scene-audio preparation and server assembly. The person supplies rights assent after disclosure, budget approval and first-take feedback. Local assembly is an explicit finishing option, `--assembly local`, using the same project and verified ledger takes. The direct script entry point is `scripts/slopcannon-agent.mjs`.

## Requirements

| dependency | purpose | check |
| --- | --- | --- |
| Node 22.13 or newer | ESM, `fetch`, `node:test` | `node --version` |
| `ffmpeg` and `ffprobe` on `PATH`, or explicit media-tool environment paths | Only explicitly chosen local assembly or standalone local media helpers; default `run` needs neither | `ffmpeg -version` when choosing local finishing |
| `SLOPCANNON_AGENT_TOKEN` in the environment | every authenticated call | `caps` then any verb |
| Managed API readiness | Default origin `https://api.slop.cc`; require submission/content, shared workspace, server slicing and default server assembly readiness | `caps --origin https://api.slop.cc` |
| a word-timed transcript (optional) | lip-sync `<d>` spans | `plan --transcript` |

There are no npm dependencies. The token is read only from the environment; it is never a flag and never written to the ledger. It is sent only over HTTPS to `https://api.slop.cc`, or to the one origin the human sets in `SLOPCANNON_AGENT_ORIGIN` (plain HTTP only for a loopback address). An `origin` in the production file or ledger must match it; neither file can send the token anywhere else. The human creates the token at `/account`.

## Grammar

```text
node <skill-directory>/scripts/slopcannon-agent.mjs <verb> --flag value [--flag value ...]
```

Flags are strict pairs; an unknown or duplicate flag, or a flag without a value, exits 1 with usage. Success writes one JSON object to stdout and exits 0. A failure writes `{"ok":false,"error":...}` to stderr and exits 1. A human gate reached by `run` writes `{"ok":false,"needs":...}` to stdout and exits 2. Capture both streams.

State lives in a JSON ledger (`--ledger`, default `./slopcannon-agent.json`). Every idempotency key is written to the ledger before the call it protects and reused on an ambiguous outcome. An exclusive lock rejects simultaneous mutating commands against one ledger. A stale lock after a crash requires verifying that process stopped before cleanup; retain its original job keys. Whole-project integration and installation are documented in [company-integration.md](company-integration.md). The installed entry point is `slopcannon video <verb>`.

## Verbs

| verb | what it does |
| --- | --- |
| `caps --origin <url>` | Reads `GET /api/v1/capabilities`, records the `endpoints` and `contract.generation` in the ledger, and says whether this origin can quote, submit and deliver. Every later verb uses the recorded endpoints, never the host that served a document. |
| `rights` | Reads the rights discovery endpoint and prints the statement, `requiredVersion`, and both policy links resolved against the site origin (`--site-origin` to override). Present all of it verbatim with the files; only explicit affirmative sign-off licenses `upload --rights`. `I agree` is sufficient, and an unambiguous post-disclosure instruction to relay the attestation or proceed with the upload is equally valid. One sign-off covers the version for the rest of the session. |
| `project --scene <id> --name <title>` | `slopcannon_create_project` with a ledger-held idempotency key; a repeat returns the same project. |
| `upload --scene <id> --kind song\|character_reference\|set_reference --file <path> --label <name> --rights <version>` | Raw-body `POST /api/v1/assets` with `x-content-sha256`, an idempotency key, and the rights header. Where the origin reports `serverSideSlicing`, a song is the whole master: it is bounded by the 50 MiB hosted asset limit and carries no duration header unless `--duration-ms` is given, because the origin decodes it. Otherwise the duration is probed from the file (a supplied `--duration-ms` must match within 250 ms), checked against `sourceAudioDurationMs`, and every file is checked against `sourceAssetMaxBytes` before any byte leaves. A byte-identical repeat is detected locally. |
| `plan --transcript <words.json> --directions <directions.json> --duration-ms <n> --out <plan.json>` | Joins hand-authored direction with a word-timed transcript into a schema 1 timed plan: phrase-safe cuts in the widest inter-word silence inside `sceneDurationMs` (or `--cuts` to pin boundaries), `<d>[Language]...</d>` spans copied verbatim with scene-local onsets, the identity lock restated in every beat, and the silent-mouth rule for named non-singers. A line whose speaker is not in that scene's `cast` is written off screen. Runs `validate-timed-plan.mjs --require-h3-vocals` on the result. |
| `prepare --plan <plan.json> --song <master> --out-dir <new-directory>` | Validates the full plan, decodes the master once to mono 16-bit PCM at the largest common sample rate (48, 32, 24, 16 kHz) that keeps every scene under `sourceAssetMaxBytes`, copies exact absolute sample ranges, and writes one-scene plans under `scene-plans/`. |
| `prepare --server <projectId> --plan <plan.json> [--out-dir <directory>]` | Asks the origin to cut the uploaded master into one `audio_chunk` asset per scene: `POST /api/v1/projects/{projectId}/scene-audio` with the plan's scene windows, then polls the ticket until it completes. Nothing is decoded locally and no media tool is needed. The ticket and the asset IDs land in the ledger, a resumed run polls the same ticket, and `--out-dir` writes one-scene plans carrying each scene's `sourceAudioAssetId` and its real place in the song; `validate-timed-plan.mjs` accepts them as written. Available where capabilities report `contract.generation.serverSideSlicing`. |
| `quote --scene <id> --plan <scene-plan.json> --cast <cast.json> [--bible <file>] [--aspect <ratio>] [--source-audio-asset <assetId>]` | `slopcannon_create_quote`. Refuses a plan with more scenes than `maximumScenesPerQuote`, and a cast member whose asset is not a `character_reference` (a `kind: "product"` member may also be a `set_reference`). A cast member's `kind` is sent with it. `--aspect` (default 16:9) must be the project's frame, the ratio `project --aspect` made it at: the server refuses any other as `project_aspect_ratio_mismatch`, naming both ratios, before anything is priced. Prints the exact Cannon Credit debit, expiry, and line items. |
| `submit --scene <id> --approve-units <n>` | `slopcannon_submit_generation`. `--approve-units` must equal the quoted `amountUnits` exactly. The idempotency key is written before the call; on any error it is kept for recovery, never replaced. |
| `recover --scene <id>` | Finds the original generation by its stored submission key without issuing or consuming another quote. Works across expired/legacy quotes. |
| `retry-failed --scene <id>` | Explicitly stages only a confirmed failed scene for a fresh quote/approval. Retains its attempt history and prior budget exposure. Refuses pending, unknown or successful jobs; this command does not submit paid work. A failed retry the queue never admitted is staged again on the same predecessor. The retry keeps the scene's declared length and cast pictures: `quote` refuses a staged retry whose cast or pictures changed (start a new revision instead). |
| `poll --scene <id>` | `slopcannon_get_generation` until a terminal status. The status carries a `settlement` block with the credits reserved, debited and refunded for that job, which is settled spend rather than the quote's exposure. `succeeded` exits 0; `failed` and `billing_unknown` exit 1 with advice. `submission_unknown` is not terminal: the server is confirming the submission and resolves it by itself with no new charge, so `poll` keeps polling it every `--interval` seconds (default 20, minimum 5) until `--timeout` seconds (default 1800). If the timeout passes while it is still unresolved, `poll` exits 1 saying so and printing the command that resumes the same generation. An ambiguous status is never resubmitted. |
| `content --scene <id> --out <directory>` | Streams a full MP4 response from the same API origin without following redirects. The platform serves its own stored copy of the clip and reports its `bytes` and `sha256`; the CLI verifies both before committing a private temporary file, and a failed transfer leaves an existing output intact. Maximum 512 MiB per clip. |
| `manifest --plan <plan.json> --song <master> --out <manifest.json>` | Writes the schema 1 assembly manifest from the plan: exact ranges, `requestSeconds` as whole seconds covering each scene, the master digest, deterministic clip names. |
| `assemble --manifest ... --song ... --clips-dir ... --output ...` | Runs `assemble-master.mjs` and returns its sync report. |
| `workspace --project <id>` | `slopcannon_get_workspace`. Prints each scene's saved takes, its current selection, and the revision every later change must carry. The revision is printed, never stored: a saved one invites a blind overwrite. |
| `cuts --project <id> [--pace patient\|music\|hyper] [--scene-min-ms <n>] [--scene-max-ms <n>] [--revision <n>]` | `slopcannon_plan_cuts`, the twin of `POST /api/v1/projects/{id}/cuts`. Scores scene boundaries on the server against the project's stored word timings and saves them as the film's timeline. `--revision` is what authorizes replacing an existing timeline; without it a project that already has one answers with the plan and `written: false`. A project with no ready song analysis answers `SONG_ANALYSIS_REQUIRED` and names the analysis endpoints. This debits no Cannon Credits. |
| `direct --project <id> [--scene-id <n>] [--instruction <text>] [--revision <n>]` | `slopcannon_direct_scenes`, the twin of `POST /api/v1/projects/{id}/director`. Drafts scene text and cast for the saved timeline from the project's treatment and its saved references and writes the draft onto the film. Name a `--scene-id` to redirect one scene. This debits no Cannon Credits and spends the account's producer budget. |
| `select --project <id> --scene-id <n> --take <n> --revision <n>` | `slopcannon_select_take`. Sends the revision exactly as given; a newer save is reported as a conflict with the current revision, and the command never retries with a guessed one. Selection is judgment, so this reflects a decision already made. |
| `check --scene <id> --plan <scene-plan.json> --cast <cast.json> [--voice-over yes\|no] [--force yes]` | `slopcannon_check_take` on the scene's delivered take, against the references its plan casts; a `kind: "product"` cast member is checked as a product (on identity, not shape). `--voice-over` defaults to yes unless the plan has an on-camera vocal span. Prints the verdict and each issue with its second, and keeps the verdict in the ledger. Spends no credits; a stored answer is reused unless `--force yes`. It never rerolls. |
| `reroll --scene <id> --plan <scene-plan.json> --cast <cast.json> [--direction <text>] [--bible <file>] [--aspect <ratio>] [--approve-units <n>] [--max-credits <n>]` | A new paid take of one delivered scene, as its own ledger scene `<id>.r<n>` with the same project, references, scene audio, aspect ratio and creative bible. `--direction` (up to 600 characters) is added after the scene text; an edited `--plan` works too. A film with a bible needs the same `--bible` file. The first call declares the take (a one-member `kind: "scene"` render request when the film is tracked) and quotes it: nothing is spent. The second call, with `--approve-units` equal to that quote, submits, waits, downloads beside the film's takes and runs the character check. See [Reroll one scene](#reroll-one-scene). |
| `cut --plan <timed-plan.json> --takes <scene=take,...> --title <title> --output <film.mp4> [--accept-checks all\|<scene,...>] [--end-card <card.png> --end-card-from-ms <ms> --rights <version>] [--graphics <audio spot id>]` | Server assembly of a film made with `run`, with chosen rerolls in place of some scenes (`--takes sc03=sc03.r1`), optionally an exact-text end card over the last scene, and optionally the on-screen graphics an Ad Cannon spot planned (`--takes` may then be left out). A tracked film gets a new film request whose members observe each chosen take; the original film, its request and its assembly are kept. A take whose character check failed is refused unless `--accept-checks` names its scene. Spends no credits. See [End card](#end-card). |
| `usage [--cursor <c>] [--limit <n>]` | `GET /api/v1/usage`. Pages this account's Cannon Credit ledger newest first, one entry per wallet posting, categorized as hold, debit, refund, purchase or grant. |
| `status` | The ledger as a table: origin readiness, rights version presented, and per scene the project, assets, quote, generation, download. |
| `run --production <production.json> [--concurrency 1..16] [--assembly server\|local]` | The resumable shared-project workflow, server finishing by default. `--concurrency` sets how many scenes run at once (default 4). Explicit local finishing keeps the same project and requires FFmpeg/FFprobe. Human gates and cumulative budget apply in both modes. |
| `character --action list\|get\|import\|create\|update\|add-reference\|publish\|unpublish` | Browse or manage Character Lab characters (`character.slop.cc`) and import a published character into a project with its Slop TV starring credit receipt. |
| `publish-link --action create\|get\|films` | Create or poll a single-use Slop TV publish link (`tv.slop.cc/publish/link#token=...`) or list finished publishable films and their Slop TV publication status. |
| `spot --action options\|list\|create\|get\|wait\|edit\|edit-sound\|load\|download` | The Ad Cannon: an exact-length audio spot to film (see [hosted-api.md](hosted-api.md#make-an-audio-first-ad-the-ad-cannon)). `options` prints lengths, prices and voices. `create --project <id> --brief <text> --length <seconds> --cast <cast.json> [--must-say-file <facts.txt>] [--products <products.json>] [--end-card <end-card.json>] --max-credits <the price the person approved> --rights <version> [--energy calm|lively|hype]` writes its idempotency key to the ledger before the call, so repeating the same request returns the original spot (`--key` names a key); a price above `--max-credits` is refused before anything is reserved. `cast.json` is an array of `{name, description, voiceId, photoAssetId?, onCamera?}` (`onCamera: true` needs the photo; `false` is a voice-only role with none). `--energy` (default lively) sets how hard every line is played; hype is over the top, best with ElevenLabs voices. `--must-say-file` lists the facts the spot must say aloud, one per line (at most 8, each up to 160 characters; list markers and blank lines are ignored), and a refusal or failure on them names the length to try. `--products` makes it a product ad: a JSON array of at most 4 `{name, photoAssetId, description}`, each name UPPER_SNAKE (`MARGHERITA`) and each photo a reference image in the project; `--end-card` is a JSON object `{name, street?, phone?, website?}` whose facts the closing line says (the card itself is drawn later). `wait --spot <id>` reads until done or failed; `edit --spot <id> --beat <beatId> --text <line> [--direction <text>]` re-records one line and `edit-sound --spot <id> --kind sfx --beat <beatId> --prompt <text>` (or `--kind music --cue <index>`) remakes one sound, both free, and `edit-sound --spot <id> --kind sfx --beat <beatId> --remove yes` takes one effect out (free, no new sound seconds); `load --spot <id> --rights <version>` makes it the project's song with one scene per shot; `download --spot <id> --out-dir <dir>` saves `master.wav`, the three stems, `captions.srt` and `cutlist.json`: every file is checked against the server's SHA-256 (a file without one is refused) and they are moved into the folder together only once all have verified. `wait` takes `--timeout` (30-86400 s) and `--interval` (5-3600 s). |
| `pitch --action create\|get\|wait` | Ad pitches: research a business and pitch 4 ad directions to fire as spots (see [hosted-api.md](hosted-api.md#pitch-ad-directions-for-a-business)). `create [--project <id>] [--website <url>] [--name <text>] [--address <text>] [--notes <text>] --max-credits <the price the person approved> [--rights <version>]` needs at least one of website, name or address, and `--rights` with a website (its photos become the person's references); the idempotency key is written to the ledger before the call, so repeating the same request returns the original pitch. `wait --pitch <id>` reads until done or failed (each read runs a stage) and takes `--timeout` and `--interval` like `spot`; `get` and `wait` print the whole pitch, each direction with its `kind` and `heroPhotos` (asset ids and names). Fire a direction with `spot --action create ... --pitch <id> --direction <0-3>`; the pitch is part of the spot's ledger fingerprint, and its credits come back once that spot is finished (`pitchCredit` reads `pending` until then). Each action takes only its own flags. |

Read `contract.assembly` before finishing. Default `run` uses server assembly with verified persisted take IDs from its production ledger and retains its assembly ID for recovery. Both finishing modes use those ledger takes, not later workspace selections. To finish the current workspace selections, call `slopcannon_start_assembly` with `clips` omitted. Assembly is included: `creditsPerOutputMinute` is zero and no separate credits are reserved or debited. Explicit `--assembly local` finishes the same film with the bundled deterministic assembler. An unavailable server is not permission to switch modes silently. Retry unconfirmed cancellation against the same assembly; confirmed native cancellation stops its renderer. See [assembly.md](assembly.md).

## The production file

```json
{
  "origin": "https://api.slop.cc",
  "title": "Owned Song",
  "song": "owned-song.wav",
  "references": [{ "id": "lead", "name": "LEAD", "label": "lead", "path": "lead.jpg" }],
  "singer": { "name": "LEAD", "speakerId": "S1" },
  "language": "English",
  "identityLock": "LEAD is ... The lock persists in every shot.",
  "transcript": "owned-song.words.json",
  "cuts": [10000],
  "scenes": [
    { "shot": "Interior. LEAD performs straight down the lens ...", "cast": ["LEAD"] },
    { "shot": "LEAD steps outside as the chorus opens ...", "cast": ["LEAD"] }
  ],
  "aspectRatio": "16:9",
  "bible": "bible.txt",
  "workDir": "./production"
}
```

Paths resolve relative to the production file. A reference may carry `kind`:

- `character` (the default) is a recurring subject kept exactly as pictured.
- `product` is food, a product, an object or a place as the business photographed it, for example `{ "name": "MARGHERITA", "path": "margherita.jpg", "kind": "product" }`.

A product picture is uploaded as a `set_reference`, and the kind goes into `cast.json`, every quote and every character check. Its scenes keep its ingredients, colours, textures and style, and it may be cut, sliced, held, plated or seen from any angle. The check judges it on identity, not shape: it fails only as a different product, one deformed or melted wrong, or garbled text. `run`, `quote`, `check` and `reroll` read `kind` from production.json or cast.json. A cast without kinds quotes and checks exactly as before.

`scenes` is the direction, one entry per scene in cut order (or a single entry reused). A scene-level `singer` overrides the default singer without changing the immutable speaker mapping. `transcript` is Whisper JSON (`segments[].words[]` with `start`/`end` seconds) or `{ "phrases": [{ "words": [{ "text", "startMs", "endMs" }] }] }`; obtain it from the platform's song analysis when `songAnalysisControlReady` is true, or from any local transcriber that emits word timestamps.

### Several voices: duets and dialogue

For a production with more than one voice, add a `speakers` roster and attribute each transcript phrase (or Whisper segment) to its speaker:

```json
{
  "speakers": [{ "name": "KAYLEIGH", "speakerId": "S1" }, { "name": "BRODIE", "speakerId": "S2" }, { "name": "NIGEL", "speakerId": "S3" }],
  "delivery": "says",
  "transcript": "episode.words.json",
  "scenes": [
    { "shot": "Confessional, close on KAYLEIGH, leaning in to the lens." },
    { "shot": "BRODIE at the pool edge, turning to camera.", "cast": ["BRODIE"] },
    { "shot": "The empty pool at night.", "cast": ["POOL"] }
  ]
}
```

```json
{ "phrases": [
  { "speaker": "KAYLEIGH", "words": [{ "text": "Is", "startMs": 580, "endMs": 700 }] },
  { "speaker": "NIGEL", "offScreen": true, "words": [{ "text": "Mic's", "startMs": 7200, "endMs": 7600 }] }
] }
```

- `speakers` gives every voice one immutable speaker ID for the whole production. `singer` becomes optional; without it the first roster entry is the default voice. A phrase with no `speaker` is voiced by the scene's singer, as before.
- `delivery` is `"sings"` (the default) or `"says"`, the verb written before each `<d>` span.
- An on-screen phrase becomes `NAME (Sn) says, <d>[Language]...</d>` with its own performance window. When a scene omits `cast`, its cast is the speakers on camera in that scene, in order of first line. With nobody speaking on camera, it is the singer, unless the singer is heard off screen in that scene or only ever off screen (a narrator whose every line is `offScreen`); then the cast is empty.
- A voice heard off screen is never added to a scene's cast. `"cast": []` stays empty: nobody is on camera, every line in that scene plays off screen, and the plan validates against the production's references.
- An `offScreen` phrase gets no `<d>` span, because the model would move a visible mouth to it. The plan names its window instead: every rostered character in the scene keeps a closed mouth while it plays. Use it for a narrator, an intercom, or a reply from someone the camera is not on.
- Off screen is also decided per scene. When a scene lists its `cast`, a line whose speaker (or, for an unattributed phrase, the scene's singer) is not in that cast is written exactly like an `offScreen` line in that scene; the same speaker's lines in scenes that cast them keep their `<d>` spans. A narrator heard over a product shot cast as `["FIZZ"]` therefore gets no mouth, and nobody is invented to voice the line. Add the speaker to the scene's `cast` to put the line on camera.
- Rostered characters in a scene's cast who do not speak in it are kept silent automatically; `silentCast` still works as before.
- A scene with nobody on camera (an establishing or location shot) gives `"cast": []`, or casts a `kind: "product"` reference (a photo of the place or object, which may be a set picture), so no character is placed in it.
- `plan` warns when two speakers voice lines on camera in one scene (keeping each line on the right mouth is not yet proven; expect rerolls), when an off-screen line overlaps an on-camera line, and when a speaker talks in a scene whose cast leaves them out. Mark the phrase `offScreen` when it is meant as voice-over wherever it plays; that warning then stops.
- `validate-timed-plan.mjs --require-h3-vocals` refuses any visible sing, rap, whisper, lip-sync or perform-the-line verb in a scene with no exact `<d>` span, including background action such as "guests whisper". A cast name sung inside a lyric does not map a speaker ID to the cast.

The ledger is content-bound to the production JSON (excluding human gate acknowledgements) and every referenced source file. If the song, transcript, directions, bible, or reference bytes change, `run` stops with `needs: "new_revision"`. Keep the old ledger for paid-job recovery and start the edited revision with a new `--ledger` and `workDir`; stale plans, uploads, and quotes are never silently reused.

`run` reads capabilities and the rights disclosure, uploads the master once after assent, obtains decoded duration through server scene-audio preparation, builds and validates the plan, saves the shared workspace and prepares exact scene chunks. It quotes the scenes, checks total approval, generates and downloads one first scene for review, runs remaining approved scenes in parallel lanes (`--concurrency`, 1–16, default 4), and finishes on the server by default. Four is only the default, not an account limit. Raising it is safe: a scene that cannot start right away waits its turn. Agents submitting scene by scene over MCP or HTTP read `contract.generation.inFlight` instead. No local FFmpeg or FFprobe is required for this managed path. Explicit local finishing happens after the same preparation and generation.

Rights assent, spend approval and the credit ceiling are read only from the command line. The agent writes the production file and ledger, so `rightsAccepted`, `approve` or `maxCredits` placed there are ignored. The driver stops with `needs: "rights"` until `--rights-accepted <requiredVersion>` follows explicit post-disclosure human assent. Approval requires `--approve all` (or a per-scene cap) and a whole-project `--max-credits` ceiling. Prior and uncertain attempts remain in that ceiling. Resume after actual first-take review with `--review-first <its exact SHA-256>`. Re-running reuses accepted jobs and verifies cached files; it does not repeat paid work. `--concurrency 1..16` changes parallelism, not production identity.

`run` requires `serverSideSlicing` and `sourceAudioAssetIdAccepted` and keeps the whole film in one project. Quote each chunk with its original master `startMs` and `endMs`. Check `workspaceAttachment` before assuming every persisted take is placed. There is no per-scene-project fallback. Respect `contract.workspace.maximumScenes` and `maximumBytes`: the current shared-project limit is 120 scenes and 512 KiB, with up to 50 takes per scene. `contract.productionWorkflow.maximumDurationMs` currently caps the managed plan at 1,800,000 ms (30 minutes); renderer admission can be tighter.

Quotes include only cast named in that scene, while reference inventory, approvals, submission keys, deliveries and assembly identity remain in the production ledger. Neither choosing local finishing nor refreshing a capability manifest authorizes a second project or duplicate paid attempts.

## Human gates

1. **Rights.** The statement, both links, and the files with byte counts and digests are presented; the human's explicit affirmative sign-off is relayed as `--rights-accepted`. `I agree` is sufficient, as is an unambiguous post-disclosure instruction to relay the attestation or proceed with the upload. One sign-off covers the statement version for the rest of the session: pass the same `--rights-accepted` on later productions and revisions without asking again, naming the new files as information, until `requiredVersion` changes, another person directs the work, or the human withdraws it. The CLI never ticks a control or infers assent, and refuses a version that differs from the one it presented.
2. **Approval.** Every quote is presented with its exact `amountUnits`; `--approve all` or a per-scene cap covers it, and `--max-credits` limits cumulative project exposure. A submission that does not echo the exact quoted amount is refused before any call is made.
3. **Review.** The sync report proves soundtrack alignment only. Identity, mouth timing, and take quality are the human's judgment on the delivered clips; a failed scene is rewritten in the production file and re-run, not retried unchanged.

## Failure handling

- Where the server lists `slopcannon_check_take`, `run` checks every delivered take before assembly (and the first take at first-scene review). A flagged take stops the run with `needs: "shot_review"` and `flagged` issues; nothing is assembled. Show the person each issue; resume with `--accept-checks all` or `--accept-checks sc03,sc07` for the takes they accept, or, with their approval, `reroll` the flagged scene and finish with `cut`.
- A failed generation is not automatically a prompt problem or proof of refund. Preserve its error and inspect the cause. An explicit `retry-failed` stages one confirmed failed scene only; unknown jobs remain recovery-only. Changed creative inputs require a new revision.
- `submission_unknown`: the server is confirming the submission with the video service and resolves it by itself with no new charge; the status `message` states the longest it can take. Status reads and recovery with the same key return the same status until then. `poll` keeps polling it; after a `--timeout` it exits saying it is still unresolved, and the same `poll --scene <id>` resumes it. Never resubmit.
- `billing_unknown`: do not resubmit. Poll again later with the same generation id.
- A quote expires in its stated window; `run` re-quotes only never-submitted scenes, then checks the standing per-scene and cumulative caps. An unresolved submission is recovered by its original key, never requoted.
- A download failure can be network, expiry or service related; preserve the status/error and generation id, refresh metadata and retry `content` later. The metadata's `expiresAt` says how long the URL stays valid.
- `STORAGE_LIMIT_EXCEEDED` (HTTP 413) means the account's project storage is full: a new quote, render, upload, song analysis or audio spot is refused before any credit moves. Preserve the ledger, read `GET /v1/storage`, tell the account holder how full it is and that they can add storage on the Account page, and wait. Never delete or schedule deletion of a project to make room unless the account holder names it, and never retry the refusal in a loop; work already paid for is still saved.

### Reroll one scene

A creative reroll is a new take of a scene that was delivered: a defect the check or the person found, or new direction for one shot. It is a new paid generation, and only that scene is made again.

```sh
# 1. Quote the new take. Nothing is spent; show the person the amount.
node slopcannon-agent.mjs reroll --scene sc03 --plan production/scene-audio/scene-plans/sc03.json \
  --cast production/cast.json --direction "MUSE is seen only from the front, facing the camera."
# 2. Once they approve that exact amount: submit, wait, download and check.
node slopcannon-agent.mjs reroll --scene sc03 --plan production/scene-audio/scene-plans/sc03.json \
  --cast production/cast.json --direction "MUSE is seen only from the front, facing the camera." --approve-units 40
# 3. Assemble the film with the new take in place of sc03.
node slopcannon-agent.mjs cut --plan production/timed-plan.json --takes sc03=sc03.r1 --title "My film" --output production/my-film-v2.mp4
```

- The take is ledger scene `sc03.r1` (then `.r2`, ...): same project, references and scene audio, with its own quote, key and generation. It is quoted at the aspect ratio the scene's own quote recorded, since a take of another size cannot be cut into the film; a different `--aspect` is refused, and a ledger from before ratios were recorded needs `--aspect` with the film's ratio. A scene quoted with a creative bible needs the same file as `--bible` (and one quoted without needs none), so the take keeps the film's look. The approval output shows the ratio and whether the film's bible is used. Changing the scene text, direction, cast, ratio or bible before approval quotes again. A reroll that is quoted, running or unresolved is continued, never replaced; changing `--direction` before it is submitted quotes it again, and a quote made in a call is always shown before anything is sent.
- In a tracked film the take is declared first as a one-member `kind: "scene"` render request (key saved before the call, a lost reply replays it) and its submission binds to that member. The original film request and its successful scene stay as they were. An untracked film's reroll is untracked.
- The reroll counts toward the production ceiling with every earlier attempt. If it does not fit, the submission is refused before anything is sent; `--max-credits` on the approving call sets a new ceiling the person chose.
- Only a delivered take is rerolled. A failed scene uses `retry-failed`; a running or unknown one is polled or recovered.
- `cut` takes one `scene=take` pair per changed scene; every take must be a reroll of that scene. In a tracked film it declares a new film whose members observe the chosen takes' own members (the original film's for unchanged scenes) and assembles under that film with `customerRequestId`; its assembly and film journals are kept under `cuts` in the ledger, so a repeat resumes or reuses the verified master. `run` keeps finishing the original cut.
- `cut` uses server assembly. For a local master, a reroll downloads as `<take>.mp4` (for example `sc03.r1.mp4`) beside the film's takes: copy it over that scene's manifest name (`slopcannon-scene-03-take-01.mp4`) in a separate clips folder, then use `manifest` and `assemble`.
- `cut` checks that every take is delivered before it declares anything. A cut is one set of takes, one title and one end card: a repeat resumes it, and a new title or card is a new cut.

### End card

The video model cannot be trusted with lettering, so a business ad's closing card (name, street, phone, website) is a picture you draw and the server lays over the last scene:

```sh
node slopcannon-agent.mjs cut --plan production/timed-plan.json --title "My ad" --output production/my-ad.mp4 \
  --end-card production/end-card.png --end-card-from-ms 27000 --rights <version>
```

- Draw the card as a PNG at exactly the film's frame size (1440x2560 for a 9:16 2K film). It is never scaled: any other size is refused with both sizes named, and so is a file that is not a PNG or an interlaced PNG.
- Transparent pixels show the moving last shot; an opaque PNG is a full card. The card fades in over about 300 ms (7 frames at 24 fps) and stays to the end.
- `--end-card-from-ms` is a moment in the film. The card lies over the last scene only, so the CLI converts that moment to the last scene's own time and refuses a moment before the last scene starts or at or past the film's end. A moment within the film's final frame shows the card on that last frame. Keep the last scene's shot calm and free of text so the card reads.
- The card is uploaded once to the film's project as an `other` image under `--rights` (the same sign-off as any upload), then sent as the assembly's `endCard`. `--takes` is optional with a card: every original take plus the card is a new cut. Add `--accept-checks` for any original take whose character check was accepted.
- Only the verified server renderer draws cards. A renderer that cannot yet is refused before anything starts, never assembled without the card. A refused card comes back in the result's `error` in the server's words.

### On-screen graphics

An Ad Cannon spot plans a few supers from its own verified facts (its must-say facts and its end card): a hook in the first 3 seconds, offers and prices shown while the voice says them, and the town as a lower third. `cutlist.json` lists them as `graphics`, and each shot one lands in already asked the video model to keep that part of the frame plain. Draw them over a film cut to that spot's master with:

```sh
node slopcannon-agent.mjs cut --plan production/timed-plan.json --title "My ad" --output production/my-ad.mp4 --graphics <audiospot_...>
```

- Only the spot is named. The server takes the spot's planned graphics, checks each one again (its words are a verified fact, a number or offer is fully on screen as the voice says those exact words and never while it says another, the hold, the safe area, one at a time, clear of the end card), draws them in the end card's typeface and accent, and refuses the request when one fails, before anything starts.
- The film must be cut to the spot's current master, byte for byte: after the spot is edited, load its new song before you cut, or the graphics are refused (`GRAPHICS_SPOT_MISMATCH`). A must-say fact an edit stops saying is listed in the spot's `mustSay.missing` and never shown.
- Only the verified server renderer draws them; a renderer that cannot yet is refused before anything starts. Combine with `--end-card` freely: the graphics always clear before the card.

### Local completion and recovery

For a tracked film, `video run --assembly local` verifies the master, uploads its
exact bytes as `final_export` and reports completion against the original film.
Both upload and report identities are journaled before their calls. Resume the
same command and ledger after a lost reply; it reuses those keys, including when
new queue intake is disabled. If a previously uploaded master is missing or
damaged locally, it downloads and checks the original bytes without rendering
again. A changed cut requires its own film revision.

Inspect `report.localCompletion.reported` separately from local `report.ok`.
The CLI obeys the advertised final-export upload limit (currently 90 MiB).
An oversized master or unknown limit leaves the full-quality local file intact
with `localCompletion.reason: "upload_limit"` and hosted reporting pending;
it never reduces quality to make the upload fit. Other reporting errors retain
the completed file and journal for retry. This does not certify local rendering
on the server or add client timestamps to server completion metrics.

For an already uploaded local master, `slopcannon request report-local --file receipt.json`
records its attributed completion without rendering or spending. Keep the exact
body and `idempotencyKey` for replay; inspect `localAssembly` with `request get`.
The [local receipt contract](hosted-api.md#complete-render-requests)
distinguishes client-reported timing from server-verified output. This command
does not upload a master; managed `video run` performs its own upload/report flow.

### Stop a queued generation

Use `slopcannon generation cancel GENERATION_ID` when the customer wants to stop
that generation. It uses `slopcannon_cancel_generation` and requires
`generations:create`. Only the new durable queue supports this operation; older
jobs return 409 and must continue normal recovery. `reconciling` means paid work
may already be running: credits remain held and a successful clip can still
arrive. `settled` means the durable final outcome has settled; inspect the
returned generation and settlement. Retry the same ID after an unconfirmed
response. Never submit replacement work merely because cancellation is pending.


For deployment-gated queue request tracking, `slopcannon request create --file request.json` declares ordered membership without spending, and `slopcannon request get <request-id>` recovers it. Include the original `idempotencyKey` in the creation file. Each member still needs its own quote and approved `fire` call with `customerRequest` in its JSON. See [the render-request contract](hosted-api.md#complete-render-requests). `video run` automatically declares the whole approved film in ready queue mode before its first paid scene. Declaration and generation keys are saved before network calls; resumes retain every member and the original acceptance clock. Existing bound scene generations are composed through their original direct members; frozen submission bodies/keys and retry predecessors are preserved. A missing film journal can be restored from an owned complete scope only when ordered membership and every saved binding agree. A composite film has its own clock; failed-scene retries retain the original source member. Foreign, changed-cohort or mismatched generation receipts stop before new purchases. Unbound paid history requires a reviewed import. First-scene review still gates the remaining paid submissions. A disabled/unavailable queue never causes an existing tracked film to fall back to untracked purchases. For a tracked failed scene, `retry-failed` verifies the exact settled server execution and journals its predecessor before clearing the local quote/generation for a new approved purchase. Repeating staging does not archive twice. It refuses unsettled/unknown/changed executions; the original film clock and all old attempt exposure remain. New retries require `memberRetryReady`; an uncertain submission replays its frozen key/body even after intake is disabled. Legacy untracked ledgers retain their existing retry behavior.
