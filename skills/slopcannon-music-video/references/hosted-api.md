# Hosted API and MCP

The canonical hosted API origin is `https://api.slop.cc`; preserve a different explicitly supplied deployment origin. With a shell, the bundled `scripts/slopcannon-agent.mjs` drives the client-managed production flow with a ledger, idempotency, caps, and approval discipline; see [agent-cli.md](agent-cli.md) and [company-integration.md](company-integration.md). Authenticate private operations with a SLOPCANNON `slop_live_...` bearer token created by the user at `/account`; do not ask for or forward the user’s Stripe or OpenRouter credentials.

## Discover

Start with `GET https://api.slop.cc/v1/capabilities`. It is public. Use its absolute `endpoints` URLs for later calls. The app at `https://slop.cc` has a separate `/api/v1` deployment; its readiness does not describe the partner API. The supported workflow keeps one project and requires submission, content, workspace and server slicing readiness; default server finishing additionally requires server assembly readiness. If a required operation is unavailable, preserve prepared work and report the missing capability before spending. Do not silently switch providers, create per-scene projects or request payment to fix readiness.

Read `contract.generation` before planning. It owns the limits the docs used to restate, and the values differ between deployments:

- `sceneDurationMs` bounds every scene.
- `maximumScenesPerQuote` is the number of scenes one quote may hold. At `1`, quote one scene at a time; the project keeps the master, while each scene names its server-created `sourceAudioAssetId`.
- `sourceAudioDurationMs` and `sourceAssetMaxBytes` bound audio/reference inputs supplied to generation. Whole masters for server slicing may use the hosted 50 MiB upload limit; the 768 KiB generation limit applies to scene chunks and generation image references, not every upload.
- `audioReferenceSupport` says how the song asset reaches the provider. `complete-source-asset` means the uploaded song asset is used whole as the scene's audio reference, beginning at local zero, so use the exact server-created scene slice, not the full master. `provider-capability-check-required` means the deployment has not committed to an audio-reference path; do not assume lip-sync input reaches the provider.
- `minimumCannonCreditsPerGeneration`, when present, is a billing floor per generation; a deliberately short clip costs the same as a clip of that length.
- `downloadUrlTtlSeconds` is how long a delivered artifact URL stays valid; fetch content within it or request the metadata again.

Three further contract blocks decide what the rest of a production can do on this deployment:

- `contract.workspace.readReady` and `writeReady` say whether the project's saved scenes, takes and selections can be read and written.
- `contract.assembly` carries `serverReady`, `engine`, `pricingSet` and `creditsPerOutputMinute`. Read it before choosing where the master is built.
- `contract.organizations.ready` says whether the reseller surface answers. `customerTokensViaApi` describes how it works when it does.

`contract.productionWorkflow.guide` is the URL of the [integration quickstart](company-integration.md), which walks the whole flow with copy-pasteable `curl`. The partner API reference is `https://api.slop.cc/docs`.

The MCP endpoint is `POST /mcp` using standard stateless Streamable HTTP. Use `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. Supported negotiated versions are `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`. The server does not issue `Mcp-Session-Id`; clients must accept JSON and SSE even though SLOPCANNON returns bounded JSON responses and does not provide a standalone GET event stream.

Configure authentication in the MCP client's private transport settings, not in agent chat or tool arguments. A generic environment-backed configuration is:

```json
{
  "mcpServers": {
    "slopcannon": {
      "type": "http",
      "url": "https://api.slop.cc/mcp",
      "headers": {
        "Authorization": "Bearer ${SLOPCANNON_AGENT_TOKEN}"
      }
    }
  }
}
```

The human creates a narrowly scoped SLOPCANNON token and stores it using the client's documented secret/environment mechanism before the agent connects. Never substitute a provider key here, place a literal token in a committed file, or ask an agent to copy a token. Inspect `contract.mcp` in the capability manifest for exact tool names and versions before connecting. MCP preserves the HTTP API's authentication, ownership, quote, approval, idempotency, and recovery semantics.

The MCP control plane has 56 tools, which `contract.mcp.toolNames` reports exactly:

| Tool | Purpose |
| --- | --- |
| `slopcannon_capabilities` | The same manifest `GET /v1/capabilities` returns |
| `slopcannon_create_project` | Idempotent project creation |
| `slopcannon_get_project` | Member-scoped project read |
| `slopcannon_start_song_analysis` | Start timestamped transcription of an owned song asset |
| `slopcannon_get_song_analysis` | Analysis status and result location |
| `slopcannon_create_quote` | An exact, expiring Cannon Credit quote |
| `slopcannon_create_render_request` | Declare a complete ordered scene, batch or film request before generation; reserves and spends nothing |
| `slopcannon_get_render_request` | Read a request's original clock and every member, including unsubmitted ones; never refreshes providers or spends |
| `slopcannon_get_project_local_assembly` | Find the latest recorded local export of a project and whether its artifact is still available; read only |
| `slopcannon_report_local_assembly` | Record a local export for a tracked film against an already-uploaded `final_export`; verifies the stored artifact, not the client's render |
| `slopcannon_submit_generation` | Guarded paid submission against an approved quote |
| `slopcannon_get_generation` | Live generation status, with its settlement block |
| `slopcannon_get_generation_content` | Completed artifact metadata and private download link through the existing OAuth connection |
| `slopcannon_cancel_generation` | Stop unclaimed queue work; accepted/unknown work reconciles and may still deliver. Requires generations:create; legacy jobs return 409. |
| `slopcannon_recover_generation` | Find an existing generation by its original idempotency key |
| `slopcannon_list_generations` | Page stored generation records, newest first |
| `slopcannon_get_workspace` | The project's saved scenes, takes, selections and revision |
| `slopcannon_save_workspace` | Save a custom plan through the Studio schema and current revision; retain every existing take |
| `slopcannon_select_take` | Choose which take a scene uses |
| `slopcannon_delete_take` | Remove a take and release its stored video |
| `slopcannon_check_take` | Check a stored take against its characters' reference pictures for defects (an extra tail, face or limb, a duplicate, a changed shape, a mouth moving in a voice-over shot); stored with the take |
| `slopcannon_plan_cuts` | Score the timeline against the song's stored word timings and save it |
| `slopcannon_direct_scenes` | Draft scene text and cast onto the saved timeline |
| `slopcannon_prepare_source_video` | Unpaid owned-video inspection, shot preparation or timing measurement; not video rendering/export |
| `slopcannon_get_source_video` | Advance and recover the same video preparation ticket |
| `slopcannon_cancel_source_video` | Cancel preparation with confirmed media shutdown and cleanup |
| `slopcannon_add_reference` | Put an uploaded reference asset on the film as one of its cast |
| `slopcannon_remove_reference` | Take a reference off the film, unless a scene still casts it |
| `slopcannon_create_upload_link` | A single-use link the person opens to upload one song or picture |
| `slopcannon_get_upload_link` | An upload link's state, and the stored assetId once uploaded |
| `slopcannon_create_publish_link` | A single-use link the person opens to publish one finished film on Slop TV |
| `slopcannon_get_publish_link` | A publish link's state, and its publication once published |
| `slopcannon_list_publishable_films` | List finished `final_export` films, their confirmed starring Character Lab credits, and their Slop TV publication state |
| `slopcannon_list_characters` | Browse or search published Character Lab characters (`character.slop.cc`), or list your own character drafts (`owned: true`) |
| `slopcannon_get_character` | Read a published Character Lab character by slug or an owned draft by `characterId`, including references and rights statements |
| `slopcannon_import_character` | Import a published Character Lab character into a project (`character_reference` asset + workspace `characterSource` + Slop TV credit receipt) |
| `slopcannon_create_character` | Create a private Character Lab draft |
| `slopcannon_update_character` | Update a private Character Lab draft under its current revision |
| `slopcannon_add_character_reference` | Copy an owned `character_reference` or `set_reference` asset into a Character Lab draft after upload rights assent |
| `slopcannon_publish_character` | Publish a Character Lab character version after publish rights assent and return its `showOnSlopTvUrl` |
| `slopcannon_unpublish_character` | Unpublish a Character Lab character under its current revision |
| `slopcannon_audio_spot_options` | Ad Cannon availability, lengths, the Cannon Credit price of each length, stock voices and the account's clone voices, cast limit; read only |
| `slopcannon_create_audio_spot` | Write, voice, score and master an audio spot; reserves its price, refused above the person's approved `maxCredits` |
| `slopcannon_get_audio_spot` | A spot's progress, script with `beatId`s, files and credits; a read runs the next stage of a spot no workflow is driving |
| `slopcannon_list_audio_spots` | Your recent audio spots, optionally in one project |
| `slopcannon_edit_audio_spot_line` | Re-record one line of a finished spot and re-mix it, free |
| `slopcannon_edit_audio_spot_sound` | Generate one sound effect or music cue of a finished spot again from a new description, or take one effect out (`remove: true`), and re-mix it, free |
| `slopcannon_load_audio_spot` | Put a finished spot into its project as the song, its cast as references and one scene per shot |
| `slopcannon_create_ad_pitch` | Research a business (website, name or address) and pitch 4 ad directions with a picture each; reserves its price, refused above `maxCredits` |
| `slopcannon_get_ad_pitch` | A pitch's progress, profile, site photos and 4 directions; a read runs its next stage |
| `slopcannon_slice_scene_audio` | Cut the song into one source-audio asset per scene, on the server |
| `slopcannon_get_scene_audio` | Advance one scene-audio job and read what it produced |
| `slopcannon_start_assembly` | Start included server assembly without a new credit hold or debit |
| `slopcannon_get_assembly` | Assembly progress, its credits and its finished output |
| `slopcannon_cancel_assembly` | Cancel a native assembly after confirmed renderer shutdown |
| `slopcannon_assembly_download_links` | Issue a temporary download session for a finished master |

Read the argument schemas from `tools/list`, not only the tool names. Project creation requires an `idempotencyKey` argument; reuse it only for the identical request. `slopcannon_submit_generation` also takes its `idempotencyKey` as a tool argument, where the HTTP twin uses the `Idempotency-Key` header. `slopcannon_create_quote` takes none: quotes are freely repeatable, and every call issues a new expiring quote. Analysis start is available only when `songAnalysisControlReady` is true and is idempotent on owner, source asset and digest, analysis version, and optional language. `slopcannon_list_generations` reads stored state only: it never asks the provider for fresh status and never settles credits, so use `slopcannon_get_generation` for live status. `GET /v1/generations` is its HTTP twin, taking `projectId`, `cursor` and `limit` on the query string and reading the same durable records; `/v1/generation/jobs` is the browser lane's own listing and a different set of rows. Tool results contain authenticated JSON resource links, not credentials or media bytes.

When saving a custom plan with `slopcannon_save_workspace`:
- Keep `state.project.treatment` to visual world, style, character identity and story arc only; it is compiled into every video generation prompt, so never include quote, approval or workflow instructions in it.
- Each `character_reference` image must depict one recurring individual, never a multi-character lineup or grid sheet indexed by position in `sceneText`.
- For `lipSyncMode: "required"` scenes, frame 1–2 singers in medium or close-up facing the camera, and when automatic song transcription missed or misheard words in that window, put the exact sung words in `sceneAudioGuidance[].whisperTranscriptOverride` (with `ignoreWhisperLyrics: false`). Omit `whisperTranscriptOverride` to use the analyzed song words; an empty string `""` marks an `auto` scene wordless and is stripped on `required` scenes.
- State camera tracking direction relative to subject travel explicitly (`"backward-tracking camera"` when characters walk toward a frontal lens; `"seen from behind, backs to camera"` when tracking forward behind them).
- In every shot of `sceneText`, give each named subject an explicit orientation and motion vector in round brackets after its name: `NAME (profile, facing frame-left; walks right to left, easy pace)`. Orientation is facing relative to camera and frame (toward or away from camera, 3/4, profile, or toward a named subject in the shot); the motion vector is the direction of travel (left to right, right to left, toward camera, away into depth, static) with a pace. Movement goes forward in the direction faced, and subjects look at each other or their path rather than the lens unless the shot calls for a look to camera. Never use square brackets for this: they name references. See [direction.md](direction.md#staging-orientation-and-motion).

## Create durable inputs

Before sending any source-media bytes, call `GET /v1/rights-attestation` and read the `data` object in its response. Use the exact `statement`, `requiredVersion`, `termsUrl`, and `acceptableUseUrl` it carries. The two URLs may be site-relative; resolve them against the SLOPCANNON site origin the human signs in to, not against the API origin, and confirm both resolve before presenting them. Present the complete statement and both links to the human verbatim, resolved as above, identify the matching files and the disclosed service purpose of creating and delivering the project video, and wait for explicit affirmative sign-off. `I agree` is sufficient, but an unambiguous post-disclosure instruction to relay the displayed attestation or proceed with the upload also counts. One sign-off covers the statement version for the rest of the session: later files the same human supplies or directs you to create ride it without asking again; name each file as you upload it. Ask again only when the version changes, another person directs the work, or the human withdraws it. Only then may the agent place the unchanged `requiredVersion` in the named rights-attestation header on the matching upload. A token, project, local path, file possession, a previous session, silence, or a general or pre-disclosure instruction is not confirmation. Never synthesize or alter the statement or version, invent operator sign-off, set the header before assent, carry assent into a new session or statement version, or guess or fabricate a receipt. Do not intentionally send a media request to elicit the statement: a client may transmit its body before receiving a response. Treat `RIGHTS_ATTESTATION_REQUIRED` or `RIGHTS_ATTESTATION_OUTDATED` from an upload only as recovery: stop, fetch the discovery endpoint again, present the current text and links, and obtain fresh human assent before retrying. If the discovery flow is unavailable or the human does not affirm, stop before uploading source media and hand the rights step to the browser workstation.

1. `POST /v1/projects` with JSON `{ "name": "...", "concept": "...", "aspectRatio": "16:9", "targetResolution": "2K" }`. The `aspectRatio` is the project's frame: every quote for the project must ask for the same `output.aspectRatio`.
2. Upload the song and each named reference with raw request bodies:

```text
POST /v1/assets?projectId=<id>&kind=song&filename=<encoded-name>
POST /v1/assets?projectId=<id>&kind=character_reference&filename=<encoded-name>
Content-Type: the exact media type
Authorization: Bearer <SLOPCANNON token>
Idempotency-Key: a new 16-200 character client attempt key
X-Slopcannon-Rights-Attestation: the unchanged requiredVersion accepted by the human for this upload
```

Character references must be uploaded as `kind=character_reference`. The assets endpoint also accepts `kind=set_reference` for the same image types. A quote accepts a `set_reference` only for a cast member of `kind: "product"` (food, a product, an object or a place as the business photographed it), or in an edit of existing footage. It rejects any other cast member whose reference is not a `character_reference` and reports it as `character_asset_not_found`; a "not found" error on an asset ID you are holding means the kind is wrong, not that the asset is missing.

A `character_reference` or `set_reference` picture smaller than 512 px on its shorter side is still stored, but the response (and an upload link's, and `slopcannon_add_character_reference`'s) carries a top-level `warnings` array saying it will look soft (256–511 px) or blurry (under 256 px) in renders. Tell the person and offer to use a larger photo before quoting; pictures are sent to the video model in their own shape and never padded.

Song uploads require an `Idempotency-Key`. Upload the full master once; `x-media-duration-ms` is optional for server slicing, which decodes and records the song duration. If supplied, the declared duration must agree with the decoded duration within 250 ms. Upload itself does not verify duration. Idempotency binds project, kind, sanitized filename, content type, byte count, SHA-256 and declared duration: exact replay returns the original asset and changed input returns 409. The optional `x-content-sha256` header is a lowercase 64-character digest. Keep asset IDs; do not embed media in quote JSON.

`POST /v1/projects` is replay-safe when it carries an `Idempotency-Key`: the first project is returned again under `Idempotency-Replayed: true`, and the same key with a different request is a 409. HTTP and MCP project creation share one key namespace, so a key minted on either surface replays on the other. Raw asset creation is idempotent when it carries a valid `Idempotency-Key`, and song uploads require one. After an ambiguous asset response, retry the exact same body, headers, and key; never reuse that key with changed input. If the original asset was deliberately deleted, start its replacement with a new key.

## Produce from an owned source video

Use this path when live discovery and the connected tools expose source-video
upload, preparation, generation and assembly. Keep one normal Cannon project,
its named references and every take. Preparation does not spend generation
credits and does not prove paid rendering or export readiness.

1. Call `slopcannon_create_upload_link` with `kind: "source_video"`. Give the
   person its `uploadPageUrl`; the existing page accepts MP4/MOV up to 500 MiB,
   records their rights confirmation and resumes interrupted uploads. Recover
   the stored `assetId` with `slopcannon_get_upload_link`. Do not pass video bytes
   in MCP arguments or extract audio as a substitute.
2. Call `slopcannon_prepare_source_video` with the project, a stable
   `idempotencyKey`, and `operation: {action: "inspect", sourceAssetId}`. Poll
   `slopcannon_get_source_video` with that returned ticket until completed.
   Preserve the returned `source`, including its hosted asset, fingerprint,
   duration and cuts, as the workspace's `project.sourceVideo`. Save a complete
   normal scene plan under the current workspace revision.
3. Prepare each retained scene with `operation: {action: "prepare",
   inspectionTicketId, sceneIndex, startFrame, endFrame, ratio}`. Frame bounds
   use the 24 fps source grid; keep each section within a measured shot. Poll
   the same ticket to completion and retain its verified chunk and prepared
   asset. Do not invent preparation receipts or use request padding as timeline
   length.
4. Quote one scene through `slopcannon_create_quote`, using that completed
   ticket ID as `sourceVideoPreparationId` **instead of** `songAssetId`. Omit
   `sourceAudioAssetId`. Derive exact scene milliseconds from the ticket's
   `keepStartFrame` and `keepEndFrame` with `Math.round(frame * 1000 / 24)`;
   the single-scene plan's `durationMs` is its absolute `endMs`. Match the
   prepared aspect ratio. Present the exact server quote totals and follow the
   ordinary approval, first-scene review and durable generation workflow.
5. After a generation succeeds and its content metadata supplies the persisted
   `assetId`, call `slopcannon_prepare_source_video` with
   `operation: {action: "timing", preparationTicketId, generatedAssetId}` and
   a stable key for that exact take. Poll to completion. Require
   `timingAttachment: "attached"` and read the saved workspace back before
   export. An unattached result needs placement recovery for the existing take;
   preserve it and its timing ticket, and never buy a replacement to fix
   placement. Each reroll needs its own measured timing. Recover a save race
   by polling the same ticket; never copy timing from a different take.
6. Export current selected takes with `slopcannon_start_assembly`, omitting
   `clips`, `durationMs` and `audioMode`. The server recognizes the source-video
   project, verifies its saved preparation/timing evidence and preserves the
   original soundtrack. Inspect `timingReviewSceneIds` and the actual picture
   separately from `syncVerified`; a correct export clock does not prove lips
   follow speech. See [assembly.md](assembly.md) for delivery and recovery.

## Analyze an owned song

If `hostedRuntime.songAnalysisControlReady` is true, an agent with the existing asset scopes can use the hosted timestamped-transcription control plane for an existing private song asset no larger than 25 MB:

1. `POST /v1/song-analyses` with `{ "assetId": "...", "language": "en" }` and `assets:write`.
2. Recover status from the returned `Location` with `assets:read`.
3. When status is `ready`, HTTP clients retrieve private timestamped JSON from its `contentUrl` with `assets:read`. MCP clients call `slopcannon_get_song_analysis` to receive the first word page directly over their existing connection. Follow `transcription.nextOffset` with `wordOffset` until null; `wordLimit` defaults to 500 (maximum 1,000). Keep absolute times and timing provenance unchanged. No exposed bearer key or second login is needed.

The equivalent MCP tools are `slopcannon_start_song_analysis` and `slopcannon_get_song_analysis`, but start is unavailable unless `hostedRuntime.songAnalysisControlReady` is true. A deployment that does not run managed transcription reports both `songAnalysisControlReady` and `songAnalysisBrowserChunkReady` false; word timing then comes from a transcription tool the agent supplies locally, there is no general transcript-import endpoint; supplied timing can be compiled into a timed plan. `songAnalysisBrowserChunkReady` is a separate browser capability and does not authorize MCP start. The server probes the owned audio and verifies its byte count and digest before reserving managed usage; client-declared duration is not trusted. The request is idempotent for the same owner, source song digest, analysis version, model, and language. A `processing` or failed record is a recovery boundary, not permission to submit another transcription. Whole-asset failures currently replay the original failure; do not promise automatic retry or reupload just to force a second charge. Never send a local path, base64 song, arbitrary fetch URL, provider endpoint, or provider credential; upload the song as a private SLOPCANNON asset first.

MCP does not provide song bytes, chunk manifests, or signed upload preparation. The secure data plane is authenticated bounded binary HTTP, and `songAnalysisLargeMediaDataPlaneReady` is false. For larger source songs, the product-supported path runs in the signed-in browser: it decodes and normalizes the song locally, creates a private digest-bound chunk session, uploads raw WAV chunks over authenticated HTTP, and resumes server processing one chunk at a time. That browser preparation/orchestration is not an MCP tool and must not be described as browserless support. A client without its own authorized binary HTTP and audio-normalization path cannot complete ingest. For the managed workflow, use a supported-size binary upload and server slicing. Hosted transcription remains optional: use a supplied timed plan or word timing when it is unavailable, and do not claim automatic whole-song transcription.

Keep exact lawful lyrics and word timing available to the directing workflow when they are needed. Do not confuse a client host's content-policy behavior with a SLOPCANNON timing or media capability, and do not rewrite, obfuscate, or disguise material to evade a host safeguard.

Use server scene-audio slicing: `POST /v1/projects/{projectId}/scene-audio` takes `{ scenes: [{ id, startMs, endMs, requestSeconds }] }` covering the master contiguously from zero, each 5000–15000 ms, and answers 202 with a ticket. `requestSeconds` defaults to the whole seconds needed to cover the scene. Poll `GET /v1/projects/{projectId}/scene-audio?ticketId=...`; on `phase: "completed"`, `sceneAudio` lists each `sceneId`, `assetId`, `bytes`, `sha256` and `durationMs`, with the decoded master duration in `songDurationMs`. Each chunk is mono 24 kHz 16-bit PCM, the exact master range at local zero with silence only for request padding. Retain the ticket; identical windows reuse stored assets. MCP twins are `slopcannon_slice_scene_audio` and `slopcannon_get_scene_audio`. Check `contract.generation.serverSideSlicing` first; slicing readiness is independent of transcription readiness.

## Quote

At `maximumScenesPerQuote: 1`, keep the full master as `songAssetId` and quote one scene. Set its `sourceAudioAssetId` to the returned chunk and retain its original absolute `startMs`/`endMs`; the single-scene plan's `durationMs` is that scene's absolute `endMs`. The chunk must belong to the same project, current song and exact window. This supports parallel scenes in one project. Do not replace the project song while generation is pending.

`POST /v1/quotes` accepts `schemaVersion` as the string `"1.0"` (quoted: the bare number `1` is refused; the timed plan's own `schemaVersion` is the number `1`), project/song asset IDs, a named cast whose `referenceAssetId` values point to uploaded assets, a contiguous validated timed plan, and `{resolution:"2K", aspectRatio, container:"mp4"}`. A cast member's optional `kind` is `character` (the default: a recurring subject kept exactly as pictured) or `product`. A product keeps its ingredients, colours, textures and style, and may be cut, sliced, held, plated or seen from any angle. A scene that casts one names what each reference picture is, and a scene without one keeps its prompt as before. `product` is for song scenes; an edit of existing footage takes `prop` for an object. A quote performs no generation. The public customer total uses `cannon-credit` and is the exact wallet debit: `ceil(quoted duration in seconds × creditsPerOutputSecond)`. The quote stores that debit and rate; a later rate change does not reprice an issued approval. A client batch budget is the sum of its exact scene quotes. Provider pricing remains internal and is not a second customer charge.

The quote's `output.aspectRatio` must equal the project's frame: the `aspectRatio` the project was created with (`slopcannon_get_project` returns it), or the shape a person has since chosen for it in the Studio, whose saved workspace wins over the project record. Every scene of a film is one size and the provider renders the ratio the quote names, so a quote for any other ratio is refused `409 project_aspect_ratio_mismatch` before it is priced, with `details.requestedAspectRatio` and `details.projectAspectRatio` naming both. A submission checks the project again: a quote for a frame the project no longer has is refused there with nothing held. Quote at the project's frame, or create a new project at the ratio you want.

The whole-second value is a render request and billing unit only. It never changes `scene.startMs`, `scene.endMs`, or the final timeline. A 7,125 ms source scene may request an 8-second provider clip, but assembly must consume exactly 7,125 ms of its video. Never concatenate the full provider-returned durations.

Present `price.customerTotal`, expiry, duration, and scene count to the user. Obtain explicit approval of the exact amount. Do not round the approval value.

## Submit exactly once

`POST /v1/generations` requires an `Idempotency-Key` of at least 16 characters and JSON:

```json
{
  "schemaVersion": "1.0",
  "quoteId": "quote-id",
  "approval": {
    "amountUnits": 80,
    "currency": "CANNON_CREDIT",
    "creditUnit": "cannon-credit"
  },
  "clientReference": "optional-user-label"
}
```

Reuse the same key only for recovery of the identical request. A timeout or `submission_unknown` result is not permission to generate again. `submission_unknown` means the server is confirming the submission with the video service: it resolves by itself with no new charge, and until then reads and same-key recovery return the same status with a `message` giving the longest it can take. Poll the returned `recoveryUrl` every 30 seconds with the same bearer token. Read content metadata only when the generation reaches `succeeded`.

The key is the only identity of a submission that carries no `customerRequest`. The server cannot tell an accidental repeat from an intended reroll, so a second key with a second quote for the same scene is a second paid render, by design. To buy a scene once, declare it as a render-request member and bind every submission to it (see Complete render requests): the member admits one initial execution whatever the key, and a second key for it is refused 409 `customer_request_conflict`.

If the response containing the generation ID was lost, call `POST /v1/generations/recover` with only `{"idempotencyKey":"the-original-key"}`, or use MCP `slopcannon_recover_generation`. This owner-scoped lookup needs `generations:read` and does not submit or reserve funds. It does not require a still-valid quote, so old accepted work remains recoverable after a quote-format transition. Missing records do not authorize new keys. Legacy quote envelopes without a frozen credit amount require requoting for **unsubmitted** work; never use that advice to replace an already-submitted attempt.

## Read the delivered clip

For a persisted generated take, content metadata issues a private 15-minute
`/v1/generation-downloads/{token}` capability. It supports GET, HEAD and byte
ranges without exposing OAuth credentials. Treat the URL as a secret and request
metadata again after expiry. Access is rechecked if the account, project or asset
is disabled/deleted. Before persistence supplies an `assetId`, the legacy
generation download URL still requires authentication; poll the same generation
instead of asking the customer for credentials or purchasing another render.

For MCP clients, use `slopcannon_get_generation_content` with `{generationId}` after success. This is the authenticated content endpoint through the existing connection; no manual bearer token or cloud browser login is needed.

Keep accepted generation, preparation, timing and assembly IDs and stable keys in a durable private production record. You may keep several generations in flight at once: read `contract.generation.inFlight` (start at its `default`, go up to its `maximum` for the account) rather than assuming 4 or waiting for each to finish. More in flight is safe: a generation that cannot start right away waits its turn. If a submission is refused because the account is full, wait briefly and submit the same request again with the same `idempotencyKey`. Poll active work at the returned Retry-After interval; without one, use a bounded 15–30 second interval and bounded concurrency. Generation reads reconcile completion, persistence and queue release, so do not leave finished generations unobserved for several minutes while asking for new slots. Stop terminal polling. After interruption, reconcile the recorded IDs before creating new work. A host that cannot continue executing must say so instead of promising background monitoring. Show phase changes and completed/total scene counts; do not expose internal IDs and JSON in routine customer chat.

`GET /v1/generations/{id}` carries the live status. `GET /v1/generations/{id}/content` is readable once the status is `succeeded`, and `GET /v1/generations/{id}/download` streams the MP4 with byte ranges.

SLOPCANNON persists a completed generation as a `generated_take` asset. When present, `/content` reports `bytes`, `sha256`, `assetId` and `workspaceAttachment`. Verify byte count and digest against the downloaded MP4. Before persistence, metadata may omit these fields and download may proxy the provider; a locally computed digest is not a server-verified digest. Refresh expired metadata and retain the original generation ID. Placement is separate from persistence: `workspaceAttachment.status` may be `attached`, `pending` or `unattached`. An `unattached` reason (`scene_not_in_workspace`, `scene_take_limit` or `project_unavailable`) is terminal for automatic placement. Retrieve the saved asset, inspect the current workspace and make any placement repair deliberately under its revision; never regenerate to repair placement. `GET /v1/assets?projectId=...&kind=generated_take` also discovers saved media.

## Review the film where it lives

The same copy is appended to the project's saved workspace, so scenes, takes and selections are durable and readable by both an agent and a person.

`GET /v1/projects/{projectId}/producer-workspace` returns the scenes, every take under each, the current selection, and a `revision`. `PUT` on the same path writes the whole state as `{ expectedRevision, state }`. A stale revision is rejected with 409 and the current revision rather than overwriting someone else's newer save: read again and re-apply, never retry with a guessed number.

MCP supports the same complete-state save through `slopcannon_save_workspace` with `{projectId, expectedRevision, state}`. Read the workspace first, edit its complete state, preserve project identity, source media and all take history, then save against that exact revision. If a newly created project returns `workspace_not_found`, initialize a complete state with `state.project.id` equal to the hosted project ID and `expectedRevision: 0`; the first save uses the same membership and concurrency checks. Scene times in state are seconds. This supports custom cuts without hosted transcription and keeps OAuth credentials in the connector. It refuses stale saves and dropped or reassigned takes; use the explicit take deletion tool only when requested. It never renders or spends. Rights fields may reflect only actual human assent.

A take carries an optional `providerJobId`, the render job that made its clip: a render request member's `executionJobId`, or, when you place a finished clip yourself, the generation ID you were given (`generation_...`). On save, a generation ID that is your account's own generation in this project, and whose published clip is the take's `hostedAssetId`, is replaced by that generation's execution job ID, the job that source-video timing attaches by and export checks. The save's answer and every later read show the stored ID, and the next save corrects a take already saved under a generation ID. Any other `providerJobId` is stored exactly as sent.

The take tools remain available. `slopcannon_get_workspace` takes `{projectId}`; `slopcannon_select_take` and `slopcannon_delete_take` take `{projectId, sceneId, takeId, expectedRevision}` and send the revision exactly as read. Deletion releases the take's stored video permanently, refunds nothing, and is refused on a scene's selected take — select another take first. Selection is the user's judgment about identity, mouth timing and continuity, not the agent's.

**Retention.** Rules delete the takes of a person's own project, never its films: a take they did not pick, 7 days after another is chosen for its scene (each such take shows its own date where they choose between takes); every take of a project with a saved film, after the named day 28 days after its last activity (saving a film is activity); every take of a project without one, after 90 days without activity. Nothing is deleted under any of them until a dated notice has stood in the product, and an email has been delivered, for at least 7 days, and never before the named UTC day has ended in every time zone. **A project an agent generated into is exempt from all three:** the API keeps every take in it until the agent deletes it with `slopcannon_delete_take`. The hosted job list the Studio reads (`GET /api/v1/generation/jobs`, with `generations:read`) lists a generation whose take a rule deleted as `takeDeleted: true`, `canDownload: false`, `canResume: false`; the partner records of `GET /v1/generations` and `slopcannon_list_generations` carry no such fields, so read the job list to learn that a take is gone.

`slopcannon_check_take` takes `{assetId, references: [{assetId, name, kind?}], voiceOver?, force?}`: the take's asset id (from `slopcannon_get_generation_content`), up to six reference pictures from the same project with the names the scene's prompt uses, and `voiceOver: true` for a shot where nobody on screen speaks. Give a reference `kind: "product"` when the quote cast it as a product. A product is judged on what it is, not on the shape it was photographed in: a slice in a hand against a whole-pie photo passes. It fails only as a different product, one deformed or melted wrong, or garbled text. A reference without a kind is a character. It answers `{check: {verdict, issues: [{kind, character, atSeconds, description}], model, references, voiceOver, checkedAt, cached}}`; `kind` is `tail`, `ears`, `extra_face`, `extra_limb`, `duplicate`, `shape`, `mouth` or `other`. Asking again with the same references returns the stored answer free (`cached: true`); `force` asks the model again. The take must be one generated shot (at most 16 s) in a project where you are owner or editor. Checks have hourly and daily limits per account (429 `shot_check_limit`, with a retry time) and count toward the account's daily fair-use budget; a check can take a few minutes. A failed check does not reroll anything: show the person the issue and the second it is at, and reroll only with their approval, which is a new paid generation. The check is a second pair of eyes, not a guarantee; a passing take still deserves a look at any back or side view.

`contract.workspace.readReady` and `writeReady` gate all of this.

## Plan and cast on the server

`POST /v1/projects/{projectId}/cuts` needs stored ready song analysis; otherwise it answers 409 `SONG_ANALYSIS_REQUIRED`. If hosted analysis is unavailable, use a supplied timed plan or word timing and save the complete workspace under its read revision. Repeating cuts cannot create missing transcription. `POST /v1/projects/{projectId}/director` drafts text and cast on a saved timeline; register references first. Both use `expectedRevision`, and without it return an existing timeline with `written: false`. Neither debits Cannon Credits: direction consumes producer fair-use budget, while cuts reach no provider. Discovery of planning tools does not remove these prerequisites.

The director may only name references the film already carries. `POST /v1/projects/{projectId}/references` puts an uploaded `character_reference` or `set_reference` asset on the film as one of its cast, taking `{ assetId, name, kind, visualDescription, expectedRevision }`; a new entry answers 201 and a repeat of the same asset answers 200 with the entry that exists. `DELETE /v1/projects/{projectId}/references/{referenceId}` takes one off and answers 409 `REFERENCE_IN_USE` with the scene ids that still cast it. The MCP twins are `slopcannon_plan_cuts`, `slopcannon_direct_scenes`, `slopcannon_add_reference` and `slopcannon_remove_reference`.

## Make an audio-first ad (the Ad Cannon)

The Ad Cannon writes, voices, scores and masters an exact-length audio spot (15 to 120 seconds, or a 3 or 5 minute documentary or true crime piece) from a brief and up to 8 cast members, then hands it to the Cannon to film. The HTTP twins are `/v1/audio-spots` (`options`, list, create, `{spotId}`, `{spotId}/files/{name}`, `{spotId}/lines`, `{spotId}/sounds`, `{spotId}/cannon`) and `GET /v1/audio-voices`.

1. `slopcannon_audio_spot_options` reports `available`, the `lengths`, `prices` (Cannon Credits for each length) and `creditsPerSecond`, `voices.stock` (id, label, family, gender, character), the account's own `voices.clones`, `maxCast`, and the `energies` a spot can be played at with the `defaultEnergy`. Pass `energy`: `"calm"` (measured, natural reads), `"lively"` (the default: expressive, alive) or `"hype"` (over the top, every line shouted or roared); a flat read is the most common complaint, so match it to the person's idea and pair hype with ElevenLabs voices (`eleven:Adam`, `eleven:Callum`, `eleven:Jessica`), which act it best. Give every cast member a voice id, or `"design"` to have their `description` designed into a voice (say gender, age, accent and sound), and a `photoAssetId` (a `character_reference` or `set_reference` asset in the project) when they appear on camera. Say which with `onCamera`: `true` with the photo, `false` for a voice-only role with none (it wins over anything the description says; omitted, a photo means on camera). A clone is recorded and consented to by the person on the Ad Cannon page. No tool makes one; never record, upload or ask for anyone's voice sample.
2. **Must say.** Put every fact the person needs said aloud (a deadline, a price, a sponsor, a web address) in `mustSay`, at most 8, each 1-160 characters, rather than only in the brief: the writer may cut brief details to fit the length, never a must-say fact. Facts that cannot fit the length at all are refused before anything is reserved (`must_say_does_not_fit`, `details.suggestedLengthS`); a script that still misses one after a repair, or a fit that would cut one, fails with `MUST_SAY_DOES_NOT_FIT`, its credits returned, with `spot.mustSay.missing`, `spot.mustSay.suggestedLengthS` and `spot.mustSay.retry` (the same request at that length). Offer the person that length and its price, then create `retry` in the spot's `projectId` with a new idempotency key. `MUST_SAY_CHECK_FAILED` means the check itself could not run (refunded): create again later at the same length.
3. **Product ads.** When the person sells a thing (a dish, a product, a shop's goods), send `products`: up to 4 (`maxProducts`), each an UPPER_SNAKE `name` (`MARGHERITA`, `WHITE_PIE`; not a cast member's name and not a speaker id like `S1`), the `photoAssetId` of its real photo (a `set_reference` or `character_reference` image in the project) and a short `description`. Products are never speakers or cast. The writer then makes a premium commercial with a product on screen from the first second and in most shots, every scene told in 2-4 angles that the cut list times as hard cuts inside each shot of about 6 seconds, every shot naming the products it shows; loading adds each photo as a `prop` reference on the scenes that show it (when you film the cut list with the CLI instead, give each product photo `kind: "product"` in the production's references, so quotes and checks treat it as a product). The end card's facts are held to the closing lines like must-say facts (a missing one fails the spot, refunded, with `mustSay.missing`: `END_CARD_NOT_SAID` when the script says it but not at the close, so create it again at the same length with a new idempotency key (the old key returns the failed spot); `MUST_SAY_DOES_NOT_FIT` with a longer length to offer otherwise). A product is held back only when the brief explicitly asks for it ("reveal the pizza at the end"). Add `endCard` (`name`, optional `street`, `phone`, `website`) when the ad ends on a card: the closing line says those facts in the last 2-3 seconds and the last shot is a calm, text-free hero picture with room for the card, which is drawn later (`cutlist.json` has `endCard` and `endCardFromS`, where the closing line starts; to lay the drawn card over the film with `cut --end-card <card.png>`, pass `--end-card-from-ms` as `endCardFromS` in milliseconds, or the last scene's start if that is later, since the card lies over the last scene only). Every ad with a brand opens by 0.5 s, never goes quiet for more than about 0.35 s except a deliberate stop, and has music under every second; the spot's `timing` reports its first sound, longest gap and each shot's cuts.
4. **Spend gate.** Tell the person the length and its price from `prices`, and create only after they approve that number. Pass it as `maxCredits`: a spot that costs more is refused with `audio_spot_over_budget` and `details.priceCredits`, and nothing is recorded or reserved. The price is held when the spot is created, charged when the master is finished and returned if it fails. Creating needs `assets:write` and `generations:create`.
5. **Rights.** `rightsAttestationVersion` is the person's own sign-off on the content-rights statement, presented as in [Create durable inputs](#create-durable-inputs); the spot records it. Never supply it for them.
6. Send a stable `idempotencyKey` and reuse it after a timeout: the same key and request return the original spot. Without one, a repeated call buys a second spot.
7. Poll `slopcannon_get_audio_spot` every 10-20 seconds until `status` is `done` or `failed`; a read runs the spot's next stage when no background workflow is driving it. A finished spot carries its `script` (every line with its `beatId`), its `sounds` (every effect and music cue with its `id` and prompt), `files` (`master.wav`, `dialogue.wav`, `music.wav`, `effects.wav`, `captions.srt`, `cutlist.json`: paths on this origin, read with the same bearer), `loudness` and `warnings`. At most 3 spots run at once per account.
8. Play the master to the person. `slopcannon_edit_audio_spot_line` changes the line they name (`beatId`, `text`, optional `direction`); `line_too_long` says how many words fit. `slopcannon_edit_audio_spot_sound` makes one sound again from a new description: `{kind: "sfx", beatId, prompt}` or `{kind: "music", cueIndex, prompt}`, with the ids from `sounds`; describe the sound and never name an artist (`invalid_sound`). `{kind: "sfx", beatId, remove: true}` takes an effect out instead (it leaves `sounds`; one already removed answers `sound_already_removed`). All are free and share 20 edits a spot; sound edits that make a new sound also draw on `soundSeconds`. The spot reads as `running` (stage `mix`) until its new master is ready.
9. `slopcannon_load_audio_spot` (`projects:write` and `assets:write`, with the person's rights version) makes the master the project's song, the cast photos its references (and product photos its props) and every shot of the cut list a scene carrying its timed lip-sync prompt, and returns `cannonUrl` for the person. Loading again after an edit keeps unchanged scenes with their takes. Then film to the cut list: the scenes already hold each shot's window, who is on camera and who speaks, so quote, approve and generate them like any scene, and finish with the spot's master as the song. Do not re-cut it.

## Pitch ad directions for a business

When the person has a business but no idea yet, `slopcannon_create_ad_pitch` researches it and pitches 4 directions to fire as audio spots. The HTTP twins are `POST /v1/ad-pitches`, `GET /v1/ad-pitches` and `GET /v1/ad-pitches/{pitchId}`.

1. Name the business with `website`, `name` and/or `address`, and add the person's `notes` (an offer to push, a tone, up to 1,000 characters). With a website it reads the home page and up to 4 of the site's own pages (robots.txt honoured) and keeps up to 6 of the site's own photos as references in the project, after a vision model has looked at them (logos and text graphics are left out), so it needs the person's `rightsAttestationVersion`; tell the person the site's text and photos are sent to the model providers. With only a name or address it searches the web. It never searches for images. Without `projectId` it makes a project named `Ad: <business>`.
2. **Spend gate.** The price is `adPitch.credits` in `slopcannon_audio_spot_options`. Tell the person, and create only after they approve it, passing it as `maxCredits` (`ad_pitch_over_budget` otherwise, nothing reserved). It is held now, charged when the pack is done, returned if it fails, and given back once a spot fired from one of its directions is finished and paid for. Creating needs `assets:write` and `generations:create`.
3. Poll `slopcannon_get_ad_pitch` every 10-20 seconds until `status` is `done` or `failed`; each read runs a stage (research, photos, the 4 directions, then one picture each). A done pitch carries `business` (what the person typed, `notes` included), the `profile` (with `card`: the end card's `name`, `street`, `phone` and `website`, each only as the sources state it, else null), `photos` (asset ids, each with `subject`, what it actually shows, and `productName`) and 4 product-first `directions` in this order of `kind`: `product` (a straight product showcase from their own photos), `craft` (how it is made), `people` (the people and the occasion) and `bold` (one bolder idea, product still on screen). Each has title, logline, style, energy, `lengthS` (30, or 15; longer only when the notes asked), `heroPhotos` (`index`, `assetId`, an UPPER_SNAKE `name` and a `description` of what it shows, both from the photo itself), a fictional cast that is voice only (each with an ElevenLabs `voiceId`; to put a character on camera, give them a photo or make a picture first), `mustSay` (up to 3 short spoken facts, the business's name always one), `openingLine`, `brief`, `pictureAssetId`, `spots` (the newest 20 audio spots made from it) and `spotCount`. Read `warnings` too.
4. Show the person the 4 directions with their pictures and let them pick. Fire the pick with `slopcannon_create_audio_spot`: its `brief`, `lengthS` and cast (`name`, `description`, `voiceId`), the person's approval of the spot's own price as `maxCredits`, and `pitch: {id, direction}`. The direction's `energy` and `mustSay` are used unless you send your own. When you film the spot, use the direction's `heroPhotos` as the product references, by their names, and `profile.card` for the end card. The answer's `pitchCredit` is `pending`: the pitch's credits come back when this spot is finished (a failed spot gives nothing back), and the pitch then reads `credited back`. The pitch is part of the spot's request, so a retry under the same idempotency key must name the same pitch and direction; a failed spot's `mustSay.retry` body already names it.

## Finish on the server

Where `contract.assembly.serverReady` is true, SLOPCANNON builds the master from persisted takes through its included server assembly. `contract.assembly.engine` names the configured renderer, and the public job view also reports its `engine`. Native assembly uses exact frame boundaries and a sync report with a full-decode check. Read actual verification fields; readiness alone is not proof of output quality. See [assembly.md](assembly.md) for the request, supported controls and delivery checks.

`POST /v1/assemblies` takes an `Idempotency-Key` and `{ projectId, title, durationMs, audioMode, masterAudioAssetId, clips: [{ assetId, startMs, endMs }], endCard? }`. Every clip references an asset this account owns, so takes are persisted first. The optional `endCard: { assetId, fromLocalMs }` lays a PNG of the project, drawn at the film's exact frame size, over the last scene from `fromLocalMs` into it (song films on the server renderer; see [assembly.md](assembly.md#server-assembly)). It answers 202 with the assembly view: `id`, `status`, `progress`, `engine` and `credits: { reserved, captured, released }`. Poll `GET /v1/assemblies/{id}`, or read a project's latest with `GET /v1/assemblies?projectId=…`. At `status: "completed"` the view carries `assetId`, `sizeBytes` and `sha256`.

`POST /v1/assemblies/{id}/download-links` issues a temporary download session; the returned `/v1/assembly-downloads/{token}` path carries no bearer, because the issued token is the whole capability. Keep it out of public logs.

`DELETE /v1/assemblies/{id}` cancels a native attempt once the compatible private service confirms renderer shutdown. Retry an unconfirmed 503 against the same assembly; do not submit a replacement. A repeated confirmed cancellation answers 200 with the same terminal view. A previously completed output wins cancellation and answers 409 `ASSEMBLY_ALREADY_TERMINAL` carrying the state it reached. Historical assembly holds retain their settlement/refund records; new assembly creates no hold.

Server assembly is included. `creditsPerOutputMinute` is zero; no separate assembly fee or credit debit applies. `serverReady` reports configured renderer admission, not a paid-pricing gate. Unsupported cuts remain browser edits.

Server finishing is the default. If it is unavailable, preserve the film and report it. Local finishing may be explicitly selected with `run --assembly local`, using the same project and verified ledger takes; see [assembly.md](assembly.md). Do not silently switch modes or split the film into per-scene projects.

## Settlement and the ledger

Three figures answer three different questions, and conflating them misreports spend.

- The issued quote is **exposure**: what the user approved.
- `GET /v1/generations/{id}` carries a `settlement` block — `reservedCredits`, `debitedCredits`, `refundedCredits`, an optional `providerCostMicros`, and a `state` of `unreserved`, `reserved`, `debited`, `partially_debited` or `refunded`. That is what one job settled, read from the authorization row rather than recomputed.
- `GET /v1/usage` pages the credential's own Cannon Credit ledger, newest first, one entry per wallet posting. Each carries a `category` of `hold`, `debit`, `refund`, `purchase`, `grant`, `grant_reversal` or `adjustment`, signed `availableDeltaUnits` and `reservedDeltaUnits`, and the `referenceType` and `referenceId` of the work that moved it. Page with `cursor` and `limit`; it needs `billing:read`.

Report exposure and settled spend separately. Missing settlement evidence is unavailable, not zero. Provider USD is internal accounting and is never a second customer charge.

## Storage

Every account has an included allowance (35 GiB) and may add blocks of 10 GiB (at most 50 blocks), each 10 Cannon Credits per 30-day period, bought by a person on the Account page; an agent never buys one. `GET /v1/storage` needs `billing:read` and returns `usedBytes`, `allowanceBytes`, `includedBytes`, `paidBlocks`, `bytesByKind`, `filmsBytes` (finished films, shown and not counted up to `filmsCeilingBytes`, 100 GiB), `scheduledForDeletionBytes` (counted bytes a project already scheduled for deletion will free) and the `plan` (`status` of `active`, `grace`, `lapsed` or `cancelled`, `blocks`, `nextBlocks`, `periodEnd`). Counted storage leaves out finished films up to that ceiling and counts byte-identical copies of a file once between the first two; each further copy counts in full.

At or over the allowance a new quote, generation, upload, song analysis or audio spot answers **413 `STORAGE_LIMIT_EXCEEDED`** before any credit is reserved, with `usedBytes`, `allowanceBytes`, `includedBytes`, `paidBlocks`, `blockBytes`, `creditsPerBlockPerPeriod` and `actions` in `details`. Replays of work already accepted still answer, and work already paid for is saved past the allowance: a delivered take, a render's staged inputs, scene audio, an assembled film. A plan that lapses stops counting its blocks and nothing is deleted.

Report the figures to the account holder and wait for their decision. A deleted project frees its space only after its 3-day recovery window, so deleting is no immediate remedy; never delete a project, take or asset, or schedule a project for deletion, to make room unless the account holder has named it. A `/v1/usage` entry with `referenceType` `storage_plan_charge` is the monthly storage charge, shown with category `debit`.

## Delegated session tokens

A host that holds the user's credential and runs other code (Hermes Agent signing in with OAuth and running plugins) gives that code a narrower credential instead of its own. `POST /v1/agent-sessions` with the host's bearer (an OAuth connected-app grant or a personal token) and a JSON body `{ "name"?, "scopes"?, "ttlSeconds"? }` answers `201` with `data` `{ object: "agent_session", id, token, tokenType: "Bearer", name, scopes, expiresAt, expiresIn, createdAt }`; `expiresAt` is epoch milliseconds, and the `token` is shown only in that response. `scopes` are the requested ones the bearer holds; omitted, every scope it holds except `billing:purchase`, which is granted only by name. `ttlSeconds` runs from 60 to 43200 (default 7200) and never past the bearer's own expiry. The session works like any token until it expires or its parent is revoked or expires, whichever comes first, and it cannot mint another session (`403 AGENT_SESSION_CANNOT_DELEGATE`). Organization credentials and browser sessions are refused. A parent keeps at most 10 live sessions, so minting another retires its oldest, and an account mints at most 30 an hour (`429 AGENT_SESSION_RATE_LIMITED`). The session never mints account tokens and spends nothing by being created. Mint a new one before the old expires, and keep it out of committed files and logs like any token.

## Organization credentials

A token may be issued by an organization rather than an account, and then it spends the organization owner's wallet under a ceiling set for it. It says so plainly: `GET /v1/billing/balance` answers with `scope: "organization-customer"`, the `organizationId`, an `availableCredits` that is the smaller of the remaining ceiling and the owner's spendable balance, and a `reservedCredits` counting only the reservations that customer opened. That `availableCredits` is exactly what the next reservation may draw, so treat it as the real limit. `GET /v1/usage` on such a credential pages only the postings that customer is answerable for.

Paid generation reservations above the customer ceiling are refused without moving credits. Included assembly does not reserve credits or consume the ceiling and remains available even at zero headroom. Report a generation ceiling refusal as a limit the reseller set, not a platform fault, and never ask for it to be raised on the user's behalf. The administration side of the surface — creating customers, issuing and revoking their credentials, setting ceilings, reading per-customer usage — is in [company-integration.md](company-integration.md) and requires the `organizations:manage` scope.

## Payment boundary

Agents may create quotes and spend already funded credits after explicit user approval. Human credit purchase is a Stripe-hosted action initiated from `/account`. Do not automate card entry, wallet signing, token creation, or account secrets. Rerolls are new billable work and require a new quote or an already-declared user cap that covers them.

## Machine-funded Cannon Credits

Read `GET /v1/billing/credit-packs` for the authoritative pack catalog and
the `creditSystem` rate card plus `machinePayments` availability object. A pack's
`cannonCredits`, `outputMinutesByResolution`, and `pricePerOutputMinuteMinor`
fields are the customer-facing contract; the legacy `minutes` and `creditUnits`
fields exist only for storage compatibility. When `machinePayments.mpp.available`
is true, an agent holding the `billing:purchase` scope may send `POST
/v1/billing/mpp/purchase?packId=<pack-id>` with a stable 8–200 character
`Idempotency-Key` and `X-SLOPCANNON-Authorization: Bearer <SLOPCANNON token>`.
Retain that dedicated authentication header on every attempt: the standard
`Authorization` header belongs to the MPP payment credential on the paid retry.
The first response is an MPP HTTP 402 challenge. Complete it with an MPP client
that supports Stripe Shared Payment Tokens; replay the same request and key
after an ambiguous transport failure. A paid response includes an MPP receipt
and the exact `creditsAdded`. Never retry with a new key after a response says
reconciliation is required.

`machinePayments.x402.available` is authoritative for Base-USDC x402. Do not
infer availability from the endpoint existing or from a generic HTTP 402. When it
is true, the same object names `x402Version` (2), `scheme` (`exact`), `network`
(`eip155:8453` is live money; `eip155:84532` is the Base Sepolia rehearsal) and
`livemode`. An agent holding `billing:purchase`, and the user's authorization
covering this merchant, rail, currency and amount, sends `POST
/v1/billing/x402/purchase?packId=<pack-id>` with `Authorization: Bearer <SLOPCANNON
token>` and a stable 8–200 character `Idempotency-Key`. The first response is an
HTTP 402 whose `PAYMENT-REQUIRED` header carries the x402 v2 requirements; pay it
with an x402 v2 client, which retries the same request and key with
`PAYMENT-SIGNATURE` (the v1 `X-PAYMENT` header is not read). Outcomes:

- `200` with `status: "paid"`, `creditsAdded` and `transaction`, plus a
  `PAYMENT-RESPONSE` header: settled and credited.
- `200` with `Idempotency-Replayed: true`: this key was already paid; nothing
  was charged again.
- `202` with `status: "settled"` and `creditsPending`: the payment settled and
  credits are being issued. Do not pay again; read `GET /v1/billing/balance`.
- `503` `x402_reconciliation_required`: the attempt is unresolved or held for
  review. The key is locked: never pay again with it. If no charge appears, a new
  purchase needs a new key.

To fund one render, quote it first, compare the quote's credits with
`GET /v1/billing/balance`, and buy the smallest pack whose `cannonCredits` covers
the shortfall. Credits from a pack stay in the balance for later renders.

## Delivery

Use the assembly status and temporary download session described in [assembly.md](assembly.md). Verify the returned MP4 bytes, digest and server verification evidence. Native status exposes `syncVerified`, not the full internal report. Preserve that status with the assembly ID, byte count, digest and selected-take record. Local assembly returns its own full JSON report. Neither proves performer mouth sync, identity or aesthetic quality. A downloaded raw take can contain generated audio; it is not the finished song-only master.


## Complete render requests

When `contract.renderRequests.localAssemblyReceiptReady` is true, a locally
assembled master can be reported with `POST /v1/render-requests/{requestId}/local-assembly`
or `slopcannon_report_local_assembly`. This is a report, not an assembly job.
Upload the master as `final_export` first, then send `{assembly, renderer,
outputAssetId, sha256, sizeBytes, completedAt, renderOptionsHash?}` with a stable
idempotency key (header for REST; `idempotencyKey` in MCP arguments).
`assembly` carries the complete normalized cut with `customerRequestId`, project,
duration, audio mode, optional master audio, and ordered saved clip IDs/ranges.
Use `renderer: "browser"` or `"ffmpeg"`; `completedAt` is the client's Unix
millisecond observation. Include a SHA-256 `renderOptionsHash` for additional
local settings/effects, such as captions, not expressed in that cut.

Reporting requires `generations:create` and current access to the original film.
The server atomically checks delivered member outputs and the owned uploaded
master's size/hash. It does not verify the local encoder, timeline or client clock.
Readback exposes `localAssembly.verification: "client_reported"`, separate
`reportedCompletedAt`/`recordedAt`, and current `artifact.available`; these are
not verified server-completion/calibration samples. It spends no credits and
works for existing films with intake disabled. Retry a lost response with the
identical body/key; a different cut or artifact requires a new film scope.
For tracked films, managed `video run --assembly local` uploads the verified
master and reports automatically, retaining both operation keys for replay.
It recovers an uploaded master by its original size/hash if the local file is
lost, without rendering again. Inspect `report.localCompletion`: unavailable
upload readiness or a file beyond supported size leaves reporting pending with
`reason: "upload_limit"` and preserves full local quality. The single-request
limit remains 90 MiB. Larger MP4s use the resumable transport only when the
origin advertises it and authenticated readiness permits new uploads. The browser workstation
and the CLI freeze that choice and the exact file manifest before sending;
retries keep the original session even if new intake is later paused. The browser workstation
hashes incrementally and keeps the local bytes until a published asset exists.
Project reopen discovers the saved local master and its original film receipt
without rendering or uploading again.

Resumable discovery: `endpoints.exportUploads` and
`contract.assetUploadLimits.resumable.readinessEndpoint`. A manifest pointer is
not an availability claim: GET the authenticated readiness endpoint before a
new session. A saved session skips new-intake checks and goes directly to
recovery. The transport supports original MP4s above 90 MiB and up to 4 GiB in
fixed 32 MiB parts (last may be shorter).

For a custom HTTP client, POST the exact `{projectId,filename,contentType,
sizeBytes,sha256}` manifest with rights and Idempotency-Key to `/v1/export-uploads`.
Persist the key/body before sending and the returned upload ID before proceeding.
GET `/{uploadId}` for saved part receipts. PUT `/{uploadId}/parts/{partNumber}`
with unencoded octet-stream, exact Content-Range and X-Content-SHA256; repeat the
rights header. Send `{}` to `/{uploadId}/finish` with rights, then verify complete
status and an available download. Send `{}` to `/{uploadId}/abort` to cancel;
202 is cancellation intent, not confirmed storage cleanup. Respect Retry-After
on admission limits. Never replace an uncertain session with another key, change
its bytes, recompress a master to fit, or send media through MCP arguments.
The browser workstation and the CLI use the shared `scripts/resumable-export.mjs` state machine; byte
transport remains authenticated HTTP and completion reporting remains MCP/REST.

Use `GET /v1/projects/{projectId}/local-assembly`, MCP
`slopcannon_get_project_local_assembly({projectId})`, or
`slopcannon request latest-local <project-id>` to discover your latest recorded
local completion. `contract.renderRequests.localAssemblyDiscoveryReady` describes
current storage/adapter readiness. This requires `generations:read` and current
owner/editor access to the project. The response is `{projectId,localAssembly}`:
`null` means no report exists; unavailable storage is an error, not empty history.
The record carries `requestId`, original `acceptedAt`, `filename`, server
`assetCreatedAt` (nullable for missing media), and `receipt`. Reports order by
server `recordedAt`, then receipt ID; client completion times never pick a winner.
A deleted or changed output remains the latest receipt with
`receipt.artifact.available: false`. Do not silently replace it with an older cut
or regenerate it. The browser workstation keeps existing saved downloads available if a separate
history read fails, with an explicit warning that the latest cut is unconfirmed.
This read does not upload, render, poll providers or debit credits.
Local completion stays explicitly client-reported even when a client has verified
its local decode.

`POST /v1/render-requests` declares a complete ordered scene, batch or film manifest. Use `generations:create` and an `Idempotency-Key` (16–200 safe ASCII characters); repeat the exact body and key after a lost response. New declarations require queue intake enabled on the serving deployment. A 503 is not permission to switch identities or submit an untracked purchase. `GET /v1/render-requests/{requestId}` uses `generations:read` and remains available for existing requests when intake is disabled. Both require the caller's current project owner/editor access.

```json
{"projectId":"project-example","kind":"batch","members":[{"key":"scene-1","seconds":5,"resolution":"2K","audio":true,"visual":true},{"key":"scene-2","seconds":5,"resolution":"2K","audio":true,"visual":true}]}
```

The returned `pcr_…` ID, original `acceptedAt` (Unix milliseconds), and ordered `members` survive reconnect. `audio` and `visual` mean audio/image **input references**, not generated audio. Declare actual prepared inputs; a mismatching render is rejected. Limits: 1–1,000 members, exactly one for `scene`, unique keys up to 120 characters, at most 200 new declarations per user per rolling 24 hours. Replays do not consume that limit. Changing a manifest under the same key returns 409.

A member may include `source: {"requestId":"pcr_…","memberKey":"original-scene"}`
to include an existing direct member in a new batch or film. It must belong to the
same account and project with the same duration, resolution and reference shape.
References are immutable and cannot point to another reference. The new scope
observes the original member's current execution, including later approved retries;
its own acceptance clock remains distinct. Submit or retry through the **source**
binding, never the new scope's reference member, which cannot create a purchase.
Already usable output adds no new generation time. The browser workstation's bulk first-pass preparation
automatically includes scenes with recovered original membership, preserving the
original binding and submitting only unfinished scenes. It can recover a lost local
journal from a matching owned film record. Inspector and chat single-scene actions
also journal first-time membership before submission, preserving original recovery
for accepted or uncertain jobs. Producer batch and whole-film reroll controls
record complete passes, skip delivered siblings on recovery, and resume accepted
jobs under the same pass. `video run` also composes existing bound scene generations,
preserving original submissions and retry predecessors. It can recover a missing
film journal from a matching owned complete scope; unbound paid history still
requires a reviewed import.
Composition does not start assembly.

This operation makes no provider call and reserves no credits. Bind each separately quoted and approved generation with `customerRequest: {"requestId":"pcr_…","memberKey":"scene-1"}` in its normal submission body. Retain that binding and the generation idempotency key on retries. A member has one initial execution and an immutable chain of explicitly approved retries. Queued agent intake must be enabled; a bound request never falls through to a legacy submission when unavailable.

MCP equivalents are `slopcannon_create_render_request` (same body plus `idempotencyKey`) and `slopcannon_get_render_request` (`requestId`). CLI equivalents are `slopcannon request create --file request.json` and `slopcannon request get <request-id>`. The creation file includes `idempotencyKey`. Recovery reports `not_submitted` or `admitted`, generation/job IDs and published `usableAt` when known; it does not poll providers. Unsubmitted members are retained. A film declaration does **not** start or certify final assembly. `contract.renderRequests.mode` distinguishes `legacy`, `queue` and `unavailable`; `boundSubmissionReady` requires migrated storage, partner intake and an installed atomic submitter. These are admission prerequisites, not a promise of available provider capacity. Where the manifest advertises tracked render requests, the managed `video run` workflow automatically declares the complete approved film before its first paid scene. It journals the declaration key before the network call, binds every scene and preserves the original request through first-scene review and reconnect. Existing request recovery never switches to untracked purchases when intake is disabled. Old partially paid unbound ledgers require a reviewed import before attaching queue identity.


To retry a settled failed member, first read its render request. Each member now
includes `executionId`, `revision`, `previousExecutionId`, `closedAt`, `failureCode`
and `retryable`, in addition to generation/job identity and `usableAt`. The read is
an observation, not permission to bypass approval. Only the latest failed execution
with released settlement and no live/uncertain or successful output is retryable.
Request a fresh quote and submit its exact approved debit with:

```json
{"customerRequest":{"requestId":"pcr_…","memberKey":"scene-1","previousExecutionId":"pqr_…"}}
```

Use the observed `executionId` as `previousExecutionId`. The server rechecks it
atomically with the new financial reservation; competing replacements cannot both
purchase. An old or mismatching predecessor returns 409 before admission. A retry
buys the same member again, so it keeps that member's declared shape: its length,
resolution, audio and whether it uses reference pictures (`visual`). A retry whose
cast or pictures changed returns 409 `customer_request_conflict` before any
generation is recorded or any quote is used; that is a new revision with its own
request, not a retry.

A bound submission the queue refuses for good (a changed shape, a stale
predecessor, missing inputs) answers 4xx with `retryable: false` and never leaves
an `accepted` generation behind; one refused after its record was claimed is
returned as `failed` with the refusal as its `errorCode`. A submission whose
admission could not be confirmed (503 `generation_admission_unconfirmed`) stays
`accepted` and recoverable under its key while its quote is valid. Once that quote
has expired it can never be admitted, and the server ends it `failed` with
`generation_not_admitted` within a few minutes; nothing was held or charged for it. Preserve
the full submission and new generation idempotency key after an uncertain response;
changing keys is not recovery. Provider-policy retries remain attempts under one
hold and do not use this new-purchase flow. Readback reports only the latest execution
for each member; prior generation receipts remain recoverable by their own IDs.
The original request clock and membership never reset.

`contract.renderRequests.memberRetryReady` reports new customer retry admission
readiness. Managed `slopcannon video retry-failed --scene sc13 --ledger …` verifies
settlement and stages the predecessor without spending. The next run presents the
fresh quote against the production ceiling. It retains prior failed exposure rather
than assuming refunds increase that ceiling; raise it only with explicit approval.

### Creative rerolls versus failed-execution recovery

A requested new take of a **successful** scene is a creative reroll. Read the current workspace, retain the same project/scene and all older takes, then declare a new `kind: "scene"` render request with a new member and stable declaration key. Obtain a new quote and bind the authorized new generation to that new member. Preserve the original film request and original successful execution: a settled successful member cannot accept another initial purchase, and `previousExecutionId` is for a released failed execution, not a creative reroll. Do not overwrite its first-pass identity to hide a conflict. The CLI's `reroll` verb declares and binds the new member this way, and `cut` assembles a new film that observes the chosen takes; neither reads or edits the workspace ([agent-cli.md](agent-cli.md#reroll-one-scene)).

Before promising or submitting a reroll, compute the cumulative exposure plus its fresh quote and compare the exact sum with the approved cap. Count each job once (do not sum its reservation and debit twice). An over-cap quote is not submitted; recover uncertain jobs first and retain prior exposure under the original cap rules.

This is not a new spending allowance. Earlier, pending and uncertain exposure all count toward the same approved production cap; rerolls require standing instructions or separate approval within it. Recover an uncertain new-take submission using its existing generation key and request before doing anything else. Preserve unrelated scene selections, read back the attached take, and measure source-video timing for that exact take. Use workspace-selected assembly after the customer chooses the cut; do not reuse a stale first-pass selection manifest.
