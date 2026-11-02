# Browser workstation workflow

Use this when the user chooses to work in the browser or review an existing project there. API readiness failure does not silently switch a managed production to a different browser/provider workflow. The same saved project is the handoff point; read [hosted-api.md](hosted-api.md) for workspace and take access.

Before uploading, identify the exact song and reference files and ask the human to confirm that they own, are licensed to use, or otherwise have the legal right to upload and authorize SLOPCANNON to process those files to create and deliver the project video, including both sound-recording and composition/lyric rights for music. If the workstation presents a versioned rights confirmation, the human must personally review and activate it. Never infer confirmation, click it for the human, or reuse it after the selected files change.

If the agent's browser cannot control a native file chooser or the human-only rights control, ask the human to perform those upload and confirmation actions. Confirm the resulting duration and thumbnails, then continue directing in the same task. Never request, read, reveal, transmit, or operate a provider credential field.

1. Open **Project Setup** and start a clean project.
2. Upload the song and wait for decoded duration and waveform readiness.
3. Upload each character image, give it a unique name, and confirm its thumbnail.
4. Add the master treatment. Select a pace only as an initial cut suggestion.
5. Prefer importing a validated timed-script plan when lyrics, multiple singers, or a plot require precise control. Keep exact lawful lyric context where it is needed. Declare one named singer-to-speaker-ID map and never remap it. Every visible vocal line needs `localMs = absoluteWordOnsetMs - scene.startMs`, its named singer and fixed ID, and an H3 `<d>[Language]...</d>` span; "sings to camera" alone is insufficient. Explicitly keep visible non-singers' mouths closed. Otherwise run **Write Cast Script** and review every scene to the same standard.
6. If provider access is not ready, pause while the human independently completes the private **Connect** UI. Resume only from its non-secret ready indicator. A provider key must never enter model context, browser-action arguments, project files, prompts, logs, or chat output.
7. Open **Generate** and inspect the estimate. Obtain approval for the exact quoted amount before submitting anything.
8. Generate one scene first and have the user review its identity, motion, vocal ownership, and mouth timing. Then confirm the remaining paid batch once. Allow accepted scenes to poll concurrently.
9. Review the active take in each scene. Approve it or reroll; use take history to restore an older version.
10. Assemble only when every scene has a selected playable take. The workstation trims each take to the exact scene source range, ignores whole-second provider padding and generated clip audio, and places the unshifted, untrimmed master content at PTS 0. Save the verified MP4 to the workspace when local export is available. For an external or CLI handoff, use **Export Agent Assembly Manifest** and keep its exact filenames when downloading local-only takes; follow [assembly.md](assembly.md).
11. Review mouth sync and final soundtrack sync independently. A performer can be off-mouth even when the master audio starts perfectly, and a convincing performance does not prove that final audio/video timestamps align.

## Failure handling

- If submission loses its response before returning a job ID, treat the outcome as uncertain. Check provider activity before allowing another POST.
- If a job ID exists, resume polling or download. Do not reroll merely because the browser refreshed.
- If a reference URL cannot be fetched, fix durable/signed media staging; do not replace the user’s reference silently.
- If a generated clip is good but speaker ownership is wrong, reroll with a shorter, explicit cast list and restated silent-mouth rules.
- If assembly fails or its duration/audio checks do not pass, preserve all generated takes and project state before diagnosing. Never replace the workstation assembly with raw concatenation of provider clips.
