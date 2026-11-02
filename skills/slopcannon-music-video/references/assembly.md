# Finish the film

Server assembly is the default. Local assembly is also supported when explicitly chosen; it uses the same project, plan, original master and verified ledger takes. It never requires a new generation or a separate project per scene. Assembly is included: no separate customer fee, credit hold or debit.

## Server assembly

For a source-video project, complete the [video preparation and take-timing
workflow](hosted-api.md#produce-from-an-owned-source-video) first. Every selected
take needs its own completed timing ticket attached to that exact saved take.
Then call `slopcannon_start_assembly` with `projectId`, title and an idempotency
key, omitting `clips`, `durationMs` and `audioMode`. The server derives the source
and selected cut from the workspace, applies verified timing maps and preserves
the original soundtrack. Retain any `timingReviewSceneIds` for visual review;
`syncVerified` verifies export timing, not generated mouth movement. Recover an
accepted assembly with its original key; use a new key for a newly selected cut.
After selecting a creative reroll, omit the original film `customerRequestId`
unless its delivered members still exactly match every selected output. Keep
that original request in production history; do not bind a changed cut to its
first-pass asset selections.

The explicit music-manifest example below is for music projects; do not adapt
it to source video by substituting the video's audio.

Read `https://api.slop.cc/v1/capabilities` and require `contract.assembly.serverReady`. Request `POST /v1/assemblies` with a durable `Idempotency-Key`, or use `slopcannon_start_assembly` with its `idempotencyKey` argument. When `clips` is omitted, the server reads current workspace selections. Explicit `clips` uses the supplied asset IDs; CLI `run` supplies its verified ledger takes in both finishing modes and does not reread later workspace selections. To finish edited workspace selections, call the assembly API or MCP tool with `clips` omitted. Confirm the chosen takes have persisted `assetId` values first.

```json
{
  "projectId": "PROJECT_ID",
  "title": "My music video",
  "durationMs": 20000,
  "audioMode": "song",
  "masterAudioAssetId": "MASTER_AUDIO_ASSET_ID",
  "clips": [
    { "assetId": "TAKE_ASSET_ID_1", "startMs": 0, "endMs": 10000 },
    { "assetId": "TAKE_ASSET_ID_2", "startMs": 10000, "endMs": 20000 }
  ]
}
```

An end card puts exact text on the film, which the video model cannot: add `"endCard": { "assetId": "CARD_ASSET_ID", "fromLocalMs": 7000 }` to lay a PNG asset of the project over the last scene from that many milliseconds into it (here 17.000 s into the film above) to the end. Any whole millisecond inside the last scene is accepted; a moment within its final frame shows the card on that last frame. Draw it at exactly the film's frame size; it is never scaled, and a card of another size, or a file that is not a PNG, is refused in a sentence naming why. Transparent pixels show the moving last shot, an opaque PNG is a full card, and it fades in over about 300 ms. Song films on the server renderer only: a cut with a card is refused before anything starts (`NATIVE_ASSEMBLY_UNSUPPORTED` while the deployed renderer cannot draw one, `ASSEMBLY_EFFECT_UNSUPPORTED` for another engine or audio mode), never assembled without it. The card is part of the cut's identity: the same key with another card is a conflict. Upload the PNG first as an asset (`kind=other`, `image/png`).

All windows use exact integer milliseconds, start at zero, join without gaps and end at `durationMs`. Use original takes and the original master. For music videos, `audioMode: "song"` discards generated take audio; `scene` retains scene audio and `silent` omits audio. These are distinct output choices. Raw take download retains provider audio and is not the song-only master.

The capability `engine` names the configured renderer; the job's `engine` identifies its actual executor. Native rendering keeps picture boundaries on one global frame grid and verifies presentation timing and full decode before publication. Supported controls are bounded: fractional per-scene audio gain is rejected with `ASSEMBLY_EFFECT_UNSUPPORTED`, and black-tail support depends on the renderer. Do not silently drop an unsupported edit or change the requested mix. The portable manifest's bounds do not promise every hosted renderer can admit every film.

Retain the returned assembly ID and poll `GET /v1/assemblies/{id}` or `slopcannon_get_assembly`. A native completed result exposes `syncVerified: true`, `assetId`, `sizeBytes` and `sha256`. The full internal native sync report is not a public artifact; preserve these returned fields and verify the downloaded MP4 against them. No verification field can judge performer mouth movement or visual quality.

A completed song film can also list `lipSyncReviewSceneIds`: one-based scenes whose delivered take carried sound that steps partway through (the provider repeated or skipped a moment of the song), which the server kept exactly as delivered instead of refusing the film. Tell the customer lip sync may slip in those scenes and that rerolling them, then assembling again, gives a cleaner cut. The field is absent when no scene needed this.

Request `POST /v1/assemblies/{id}/download-links` or `slopcannon_assembly_download_links` for a temporary download session. Resolve its URL against the configured API origin; follow the returned URL rather than building a guessed path. The URL is itself a bearer capability, so download without adding an account bearer and keep the URL private. On expiry, request a new session for the same finished assembly. When downloading is supported, verify bytes and SHA-256 before claiming an independent file check.

### Delivery in a consumer chat

On completion, issue the official download link immediately and present **Download full video**, the normal project link, settled credits and a brief quality note. Keep the capability URL only in that customer's private conversation; an expired link needs a new session for the same completed assembly, not a new assembly or generation.

The full-quality master can exceed a host's attachment limit. Prefer the single-file Cannon link in that case. Inline attachment is optional and may be claimed only after success. Do not split the film into parts, require customer concatenation or local computer/shell access, or recompress the master to fit chat. Verify bytes/digest when downloading is supported; otherwise accurately report the server's receipt without claiming an independent file check. Technical receipts do not establish visual quality.

Cancel with `DELETE /v1/assemblies/{id}` or `slopcannon_cancel_assembly`. Native cancellation returns after compatible renderer shutdown is confirmed. A 503 can mean cancellation is recorded but shutdown is unconfirmed: retry the same assembly, not a replacement. Repeated confirmed cancellation returns the terminal view; a completed master wins the race and answers 409 `ASSEMBLY_ALREADY_TERMINAL`. Historical credit holds keep their refund records; new assembly creates no hold.

## Explicit local assembly

Choose `slopcannon video run --production production.json --ledger production-ledger.json --assembly local` when the user wants local finishing. The direct assembler recipe below is also supported. Both CLI finishing modes consume verified takes recorded in the production ledger; changing a workspace selection does not change those inputs. The direct assembler instead consumes the exact take files named in its manifest. Neither creates paid work. Server scene-audio preparation and the shared project are unchanged.

Local requirements:

- Node.js 22 or newer;
- `ffmpeg` and `ffprobe` on `PATH`, or explicit `SLOPCANNON_FFMPEG_PATH` and `SLOPCANNON_FFPROBE_PATH` environment variables;
- one assembly manifest, the exact master song, and every selected take.

## Manifest version 1

```json
{
  "schemaVersion": 1,
  "durationMs": 11115,
  "masterAudio": {
    "filename": "owned-song.mp3",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "scenes": [
    {
      "id": 41,
      "startMs": 0,
      "endMs": 5500,
      "requestSeconds": 6,
      "clip": {
        "filename": "slopcannon-scene-01-take-02.mp4",
        "assetPath": "/api/v1/assets/hosted-asset-id"
      }
    },
    {
      "id": "ending",
      "startMs": 5500,
      "endMs": 11115,
      "requestSeconds": 6,
      "blackAfterLocalMs": 4330,
      "clip": {
        "filename": "slopcannon-scene-02-take-07.mp4"
      }
    }
  ]
}
```

Rules:

- `durationMs`, `startMs`, `endMs`, and `blackAfterLocalMs` are exact integer milliseconds.
- The first scene starts at zero, every scene joins the previous scene exactly, and the last scene ends at `durationMs`.
- `requestSeconds` is an integer from 5 through 15 and must cover the source-scene duration. It records the provider request, not the edit duration.
- Every `clip.filename` is an explicit, unique basename. The assembler never guesses a take filename or searches subdirectories.
- `masterAudio.filename` is descriptive metadata. `--song` selects the actual local file, so capitalization differences do not break Linux clients. Include `masterAudio.sha256` whenever possible to bind the manifest to the exact song bytes.
- `blackAfterLocalMs`, when present, is local to that scene. Frames before it come from the take; everything from it through `endMs` is deterministic black.
- `takeInPointMs`, when present, is a whole number of milliseconds from 1 through 15000 and says where in the take this scene starts. Use it only for a take that was rendered for a longer stretch of the song than the scene covers (a take made for 20.000-31.640 s serves a scene at 24.250-31.640 s from `takeInPointMs: 4250`). Omit it for a take that plays from its first frame. A manifest with it renders under encoding policy `native-assembly-avc-v4`: the take's own sound is measured against the song from that offset, and a take that is too short, or whose sound does not match the song there, is refused rather than rendered misaligned. When `clips` is omitted from a server assembly, the server works the offset out from each saved take's recorded song window.
- `endCard`, on the last scene only, is `{ "image": { "filename": "end-card.png", "sha256": "...", "bytes": 187118 }, "fromLocalMs": 7000 }`: a PNG in the clips directory at exactly the takes' frame size, laid over the scene from the frame `fromLocalMs` falls on (counted on the film's absolute frame grid, like a black tail) to its end, alpha respected and faded in over about 300 ms. It is never scaled: a card of another size, or a file that is not a PNG, stops the assembly before anything is encoded. Its `sha256` and `bytes`, when given, must match. Only the last scene's own encode changes; every other scene, the join and the audio are exactly as without it. A manifest with it renders under encoding policy `native-assembly-avc-v7` (`native-assembly-avc-v8` with a `takeInPointMs`).
- `graphics`, at the top level, is `{ "version": 1, "accent": "#ff6a4d", "events": [{ "kind": "hook", "zone": "upper", "text": "...", "fromMs": 300, "toMs": 3400 }] }`: on-screen words for the film, in order, one at a time, each drawn by the server renderer as a plate inside the platforms' safe area and faded in and out over about 200 ms. Only the server renderer draws them (encoding policy `native-assembly-avc-v9`, `native-assembly-avc-v10` with a `takeInPointMs`); a local assembly refuses a manifest with them. Request them with the assembly's `graphics: { spotId }`, never by writing the words yourself.
- `assetPath` is optional and must be a same-origin relative path. It is only used when the named local clip is absent.

## Prepare exact scene audio references

Do not seek independently through an MP3 or other compressed master for each provider request. That can reintroduce encoder-delay and rounding differences. Decode the master once, then prepare exact 48 kHz, 16-bit PCM WAV references. Mono stays mono; multichannel masters are downmixed to stereo. These WAVs are provider-reference inputs and are often larger than a hosted source asset may be: at 48 kHz/16-bit a stereo second is 192,000 bytes and a mono second is 96,000 bytes, so compare each prepared file against `contract.generation.sourceAssetMaxBytes` from the capability manifest before any upload and re-encode it (a lower PCM sample rate, mono, or a compressed audio type the assets endpoint accepts) when it does not fit:

```text
node <skill-directory>/scripts/prepare-scene-audio.mjs \
  --manifest assembly-manifest.json \
  --song owned-song.mp3 \
  --output-dir prepared-scene-audio
```

For each scene, the preparer copies exactly `[startMs,endMs)` from the one decoded PCM timeline. It then pads silence to `requestSeconds`. It never borrows audio from the following scene. Output names mirror clip names, replacing the video extension with `.audio.wav`.

The output directory must not already exist. Treat any nonzero exit as a hard failure. Every script in this package writes its success JSON to stdout and its failure JSON to stderr; capture both streams, or an empty stdout will be misread as a silent pass. The JSON result reports sample counts for the active interval and silence padding; use those WAVs as the scene audio-reference inputs.

## Assemble the master

Place selected takes directly inside one clip directory using their manifest filenames, then run:

```text
node <skill-directory>/scripts/assemble-master.mjs \
  --manifest assembly-manifest.json \
  --song owned-song.mp3 \
  --clips-dir selected-takes \
  --output finished-video.mp4
```

The output path must not already exist. The assembler:

1. validates exact timeline coverage, request durations, IDs, safe filenames, and the optional song hash;
2. probes the master and every take, refusing missing video, mismatched dimensions, and clips shorter than their required visual interval, and measures the master's length by decoding it (a file's header can only estimate it: an MP3 with no Xing/Info header or a raw AAC stream is often 0.1% or more off);
3. maps all takes onto one absolute output-frame timeline, resamples variable input rates to a common frame grid, and honors deterministic black tails without accumulating per-scene rounding; individual boundaries have only the unavoidable global-grid quantization of at most one-half output frame;
4. concatenates only those trimmed video segments;
5. discards all generated clip audio and muxes the complete master audio from PTS zero (encoding it to AAC for MP4 compatibility when necessary);
6. verifies stream starts, durations, dimensions, frame rate, and a full video-plus-audio decode before publishing the output atomically.

The single-line JSON result is the sync report, and the same report is retained next to the video as `<output>.sync-report.json` for later comparison. Both output paths must be absent before assembly. A successful report includes `fullDecodeVerified: true`, `generatedClipAudioDiscarded: true`, every expected-versus-realized scene boundary, the maximum frame-boundary delta, discarded provider padding, stream-start offsets, duration deltas, dimensions, and frame rate. Do not call the video finished when the command exits nonzero.

## Embed the native renderer core

For a native service embedding this assembler, `scripts/native-assembly-core.mjs` exports `createNativeAssemblyPlan()` and `renderNativeAssembly()`. This is a local media core, not the hosted assembly API. Pass a manifest with SHA-256 digests for the song and every clip, absolute `songPath`, `clipsDir`, `outputPath`, `ffmpegPath`, and `ffprobePath`, plus optional `signal` and `onProgress`. It makes private input snapshots and returns policy/manifest identity, decoded frame count, every-packet presentation-clock verification, and the normal sync report. The native path preserves the complete source audio without a terminal duration cut.

This bounded path supports MP4/MOV video with even yuv420p dimensions up to 4096 per side and 60 fps; master audio must use a supported self-contained MP3, WAV, FLAC, AAC, M4A/MP4, Ogg, or Opus format matching its manifest filename. Playlists and external data references are rejected. Limits are 360 scenes, 30 minutes, and 4 GiB of inputs and of output. A cut of up to 60 scenes and 9 minutes keeps a 30-minute cancellable job deadline and encodes one scene at a time. A longer cut ("long form") has a deadline of 15 minutes plus four times its length, encodes two scenes at a time and decodes the finished master on four threads, under the same encoding policy and the same checks: the master is byte-identical to a sequential render. A service that admits a cut past 64 scenes or 15 minutes should bound its takes at 4 GiB divided by 1.85, the largest master-to-takes ratio measured, so the finished master stays inside the 4 GiB output limit; a cut within 64 scenes and 15 minutes keeps the 4 GiB total. The embedding service remains responsible for authentication, durable ownership, quotas, storage, and recovery. Browser/server parity still requires checking the deployed renderer against actual exports.

The assembler also measures each take's own sound against the song, window by window, because a provider take's sound sometimes steps partway through (it repeats or skips a moment of the song) while its picture carries on. A step the picture can follow invisibly is retimed. A step whose repair would hold or skip the picture past 80 ms, or a take more than 1.5 s off the song over most of its scene, is never retimed. Native encoding policies `native-assembly-avc-v3` and `native-assembly-avc-v4` (v4 adds `takeInPointMs`) refuse the whole film for such a scene (`Selected take timing is damaged in scene N`). Policies `native-assembly-avc-v5` and `native-assembly-avc-v6` (v3 and v4 with `takeSoundVisibleDiscontinuity: "deliver-v1"`) render the scene exactly as delivered, as the browser and the local CLI do, and keep it in the report's `takeSoundSync.scenes` as `unverified` with reason `visible-discontinuity` or `offset-too-large`. A service sends v5/v6 only to a renderer whose `GET /v1/contract` says `takeSoundDelivered: true`. A take that starts partway in (`takeInPointMs`) whose sound does not match the song there is refused under every policy. Policies `native-assembly-avc-v7` and `native-assembly-avc-v8` are v5 and v6 with the last scene's `endCard` (`endCard: "png-rgba-overlay-v1"`, a 300 ms fade, BT.709 limited range); a cut has a card under v7 or v8 and only those, and a service sends them only to a renderer whose contract says `endCard: true`. The card is read with Node's zlib, not FFmpeg's PNG decoder, and reaches FFmpeg as raw RGBA frames.

## Retrieve missing hosted takes

When a manifest contains `assetPath`, a missing local take may be fetched from the authenticated SLOPCANNON origin:

```text
SLOPCANNON_AGENT_TOKEN=<token> node <skill-directory>/scripts/assemble-master.mjs \
  --manifest assembly-manifest.json \
  --song owned-song.mp3 \
  --clips-dir selected-takes \
  --origin https://your-slopcannon.example \
  --output finished-video.mp4
```

The bearer token is read only from the environment and is never placed in the manifest, command output, or sync report. It is sent only to `https://api.slop.cc` or the origin in `SLOPCANNON_AGENT_ORIGIN`, and redirects are accepted only when they remain on that origin. Prefer local clips when they are already available.

## Prove a local media-tool installation is sync-safe

Before the first explicit local assembly on a new machine or media-tool installation, run the bundled sync check:

```text
node <skill-directory>/scripts/run-sync-conformance.mjs
```

It generates six synthetic 6-second provider clips around exact 5.017-second source scenes. It fails unless prepared WAVs contain the exact master slices plus zero-only padding, every absolute color boundary lands within one-half frame, the final streams begin at PTS zero and fully decode, and none of the six loud clip-only audio fingerprints survive the master mux. `ffmpeg` and `ffprobe` are required; use `SLOPCANNON_FFMPEG_PATH` and `SLOPCANNON_FFPROBE_PATH` when they are not on `PATH`. A successful single-line JSON report contains only synthetic measurements—no local paths, media, lyrics, prompts, transcripts, credentials, or tokens. Treat a nonzero exit as a hard failure.
