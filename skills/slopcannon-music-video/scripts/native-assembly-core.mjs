/** Local-only native renderer. The service owns authentication, leases and R2;
 * this module owns deterministic media and never contacts a provider. */
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assembleMaster,
  NATIVE_ASSEMBLY_ENCODING_POLICIES,
  NATIVE_ASSEMBLY_ENCODING_POLICY,
  nativeAudioInputFormat,
  validateAssemblyManifest,
} from "./assemble-master.mjs";

export { NATIVE_ASSEMBLY_ENCODING_POLICY };
/**
 * What one native render may carry. The ceiling is 30 minutes and 360 scenes (the 5-second minimum scene
 * for 30 minutes); inputs and the finished master are each bounded at 4 GiB.
 */
export const NATIVE_ASSEMBLY_LIMITS = Object.freeze({
  maxScenes: 360,
  maxDurationMs: 30 * 60 * 1000,
  maxInputBytes: 4 * 1024 ** 3,
  maxOutputBytes: 4 * 1024 ** 3,
});

/**
 * Time and scheduling for one render, a function of the cut alone. Measured on production (323 completed native renders
 * with full phase timings, 4 vCPU): about 2.4 s of render per second of film plus 0.63 s per scene and 86 s fixed, so
 * the longest film completed so far (8.7 minutes, 59 scenes) used 75% of the 30-minute budget. A cut beyond 60 scenes
 * or 9 minutes ("long form") gets 15 minutes plus four times its length, runs two scene encodes at a time (one
 * encode keeps only about 2.6 of the 4 vCPUs busy) and decodes the finished master on four threads. Measured against
 * the sequential render, the master is byte-identical and the render 1.54 times quicker (a 52-scene 2560x1440 film; 1.60
 * times on a 61-scene one); the observed spread of
 * production render times is 2.1 times the mean, which four times the film covers. The service contract
 * (`nativeAssemblyDeadlinesMs` in native-assembly-contract.ts) carries the same deadline; a test pins both.
 */
export const NATIVE_ASSEMBLY_STANDARD_BUDGET = Object.freeze({
  longForm: false,
  timeoutMs: 30 * 60 * 1000,
  toolTimeoutMs: 10 * 60 * 1000,
  sceneConcurrency: 4,
  verifyDecoderThreads: 4,
});

export function nativeAssemblyBudget({ sceneCount, durationMs }) {
  if (sceneCount <= 60 && durationMs <= 9 * 60 * 1000) return NATIVE_ASSEMBLY_STANDARD_BUDGET;
  return Object.freeze({
    longForm: true,
    timeoutMs: 15 * 60 * 1000 + 4 * durationMs,
    toolTimeoutMs: 10 * 60 * 1000 + Math.ceil(durationMs / 2),
    sceneConcurrency: 4,
    verifyDecoderThreads: 4,
  });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function freezeTree(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

/** Canonical copy made before the first asynchronous operation. Customers
 * cannot change a scene, source, or encoding option while it is rendering.
 * @param {*} input
 * @param {string} [encodingPolicyVersion] the policy the request was accepted under; the third's when omitted */
export function createNativeAssemblyPlan(input, encodingPolicyVersion = NATIVE_ASSEMBLY_ENCODING_POLICY.version) {
  const encodingPolicy = NATIVE_ASSEMBLY_ENCODING_POLICIES[encodingPolicyVersion];
  if (!encodingPolicy) throw new Error("Unknown native encoding policy.");
  const source = structuredClone(input);
  const issues = validateAssemblyManifest(source);
  if (issues.length) throw new Error(`Native manifest is invalid: ${issues.map(({ field, message }) => `${field} ${message}`).join(" ")}`);
  if (source.scenes.length > NATIVE_ASSEMBLY_LIMITS.maxScenes || source.durationMs > NATIVE_ASSEMBLY_LIMITS.maxDurationMs) {
    throw new Error("This cut exceeds the native renderer's scene or duration limit.");
  }
  if (source.scenes.some((scene) => scene.takeInPointMs !== undefined) && !encodingPolicy.takeInPoint) {
    throw new Error("This cut starts a take partway in, which the accepted encoding policy does not render.");
  }
  const endCard = source.scenes.at(-1).endCard;
  if (endCard && !encodingPolicy.endCard) throw new Error("This cut has an end card, which the accepted encoding policy does not draw.");
  // A cut has graphics under the graphics policies (v9, v10) and only those: an older policy never renders it without them.
  if (Boolean(source.graphics) !== Boolean(encodingPolicy.graphics)) {
    throw new Error(source.graphics ? "This cut has on-screen graphics, which the accepted encoding policy does not draw." : "This encoding policy draws graphics, and this cut has none.");
  }
  if (!source.masterAudio.sha256 || source.scenes.some((scene) => !scene.clip.sha256) || (endCard && !endCard.image.sha256)) {
    throw new Error("Native rendering requires SHA-256 checksums for the master, every selected take and the end card.");
  }
  nativeAudioInputFormat(source.masterAudio.filename);
  const manifest = {
    schemaVersion: 1,
    durationMs: source.durationMs,
    masterAudio: { filename: source.masterAudio.filename, sha256: source.masterAudio.sha256.toLowerCase() },
    scenes: source.scenes.map((scene) => ({
      id: scene.id,
      startMs: scene.startMs,
      endMs: scene.endMs,
      requestSeconds: scene.requestSeconds,
      ...(scene.blackAfterLocalMs === undefined ? {} : { blackAfterLocalMs: scene.blackAfterLocalMs }),
      ...(scene.takeInPointMs === undefined ? {} : { takeInPointMs: scene.takeInPointMs }),
      clip: {
        filename: scene.clip.filename,
        sha256: scene.clip.sha256.toLowerCase(),
        ...(scene.clip.bytes === undefined ? {} : { bytes: scene.clip.bytes }),
      },
      ...(scene.endCard === undefined ? {} : { endCard: {
        image: {
          filename: scene.endCard.image.filename,
          sha256: scene.endCard.image.sha256.toLowerCase(),
          ...(scene.endCard.image.bytes === undefined ? {} : { bytes: scene.endCard.image.bytes }),
        },
        fromLocalMs: scene.endCard.fromLocalMs,
      } }),
    })),
    ...(source.graphics === undefined ? {} : { graphics: {
      version: source.graphics.version,
      accent: source.graphics.accent.toLowerCase(),
      events: source.graphics.events.map((event) => ({ kind: event.kind, zone: event.zone, text: event.text, fromMs: event.fromMs, toMs: event.toMs })),
    } }),
  };
  const manifestSha256 = digest(manifest);
  const encodingPolicySha256 = digest(encodingPolicy);
  return freezeTree({
    manifest,
    encodingPolicy,
    manifestSha256,
    encodingPolicySha256,
    renderIdentitySha256: digest({ manifestSha256, encodingPolicySha256 }),
  });
}

async function copyBoundedInput(source, destination, budget, signal, expectedSha256, label = "Source") {
  const status = await lstat(source);
  if (!status.isFile() || status.isSymbolicLink() || status.size === 0) throw new Error("Native inputs must be nonempty regular files.");
  if (status.size > budget.remaining) throw new Error("Selected media exceeds the native input size limit.");
  const hash = expectedSha256 ? createHash("sha256") : null;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      budget.remaining -= chunk.byteLength;
      if (budget.remaining < 0) return callback(new Error("Selected media exceeds the native input size limit."));
      hash?.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(source, { flags: constants.O_RDONLY | constants.O_NOFOLLOW }), limit,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
  if (hash && hash.digest("hex") !== expectedSha256.toLowerCase()) {
    throw new Error(`${label} SHA-256 does not match the manifest.`);
  }
}

async function observeProgress(callback, event, signal) {
  signal.throwIfAborted();
  if (!callback) return;
  let abort;
  try {
    await Promise.race([
      Promise.resolve().then(() => callback(Object.freeze(event))),
      new Promise((_resolve, reject) => {
        abort = () => reject(new Error("Assembly was cancelled while reporting progress."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally { signal.removeEventListener("abort", abort); }
}

export async function renderNativeAssembly({
  manifest,
  songPath,
  clipsDir,
  outputPath,
  ffmpegPath,
  ffprobePath,
  signal,
  onProgress,
  encodingPolicyVersion,
  drawGraphics,
}) {
  const plan = createNativeAssemblyPlan(manifest, encodingPolicyVersion);
  for (const [name, value] of Object.entries({ songPath, clipsDir, outputPath, ffmpegPath, ffprobePath })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${name} must be an explicit absolute local path.`);
  }
  if (onProgress !== undefined && typeof onProgress !== "function") throw new Error("onProgress must be a function.");
  signal?.throwIfAborted();
  const timing = nativeAssemblyBudget({ sceneCount: plan.manifest.scenes.length, durationMs: plan.manifest.durationMs });
  const deadline = AbortSignal.timeout(timing.timeoutMs);
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const resolvedClips = await realpath(clipsDir);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const workspace = await mkdtemp(path.join(path.dirname(outputPath), ".slopcannon-native-"));
  try {
    // Own a private snapshot: a caller modifying its source directory after a
    // checksum check cannot change the bytes FFmpeg eventually encodes.
    const inputDirectory = path.join(workspace, "inputs");
    const selectedClips = path.join(inputDirectory, "clips");
    await mkdir(selectedClips, { recursive: true });
    const selectedSong = path.join(inputDirectory, "master-audio");
    const budget = { remaining: NATIVE_ASSEMBLY_LIMITS.maxInputBytes };
    await copyBoundedInput(songPath, selectedSong, budget, activeSignal, plan.manifest.masterAudio.sha256, "Master audio");
    for (let index = 0; index < plan.manifest.scenes.length; index += 1) {
      const scene = plan.manifest.scenes[index];
      await copyBoundedInput(
        path.join(resolvedClips, scene.clip.filename),
        path.join(selectedClips, scene.clip.filename),
        budget,
        activeSignal,
        scene.clip.sha256,
        `Scene ${index + 1} clip`,
      );
    }
    // The end card is snapshotted beside the takes, where the assembler reads it and checks its digest.
    const endCard = plan.manifest.scenes.at(-1).endCard;
    if (endCard) {
      await copyBoundedInput(
        path.join(resolvedClips, endCard.image.filename),
        path.join(selectedClips, endCard.image.filename),
        budget,
        activeSignal,
        endCard.image.sha256,
        "The end card",
      );
    }
    const manifestPath = path.join(workspace, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(plan.manifest), { flag: "wx" });
    return await assembleMaster({
      manifestPath,
      songPath: selectedSong,
      clipsDir: selectedClips,
      outputPath,
      nativeVerification: true,
      preverifiedHashes: true,
      preverifiedSongHash: plan.manifest.masterAudio.sha256,
      nativeIdentity: {
        encodingPolicyVersion: plan.encodingPolicy.version,
        encodingPolicySha256: plan.encodingPolicySha256,
        manifestSha256: plan.manifestSha256,
        renderIdentitySha256: plan.renderIdentitySha256,
        selectedTakeSha256Verified: plan.manifest.scenes.length,
        videoEncodePassesPerScene: 1,
      },
      maxOutputBytes: NATIVE_ASSEMBLY_LIMITS.maxOutputBytes,
      sceneConcurrency: timing.sceneConcurrency,
      verifyDecoderThreads: timing.verifyDecoderThreads,
      execution: {
        signal: activeSignal,
        timeoutMs: timing.toolTimeoutMs,
        toolPaths: { ffmpeg: ffmpegPath, ffprobe: ffprobePath },
        localFilesOnly: true,
      },
      onProgress: (event) => observeProgress(onProgress, event, activeSignal),
      // the words are drawn by the renderer that hands them in (the service's app/ad-graphics/render.ts); none here
      ...(drawGraphics ? { drawGraphics } : {}),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
