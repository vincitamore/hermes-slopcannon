#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { trustedOrigin } from "./trusted-origin.mjs";
import {
  guardVisibleTakeSoundDiscontinuity,
  planTakeSoundRetime,
  retimedFrameIndexes,
  takeInPointFrameIndex,
  takeSoundContradictsInPoint,
  TAKE_SOUND_SAMPLE_RATE,
  TAKE_SOUND_SYNC_V1_VERSION,
  TAKE_SOUND_SYNC_VERSION,
  TAKE_SOUND_UNSUPPORTED_COVERAGE,
} from "./take-sound-sync.mjs";
import { decodeEndCardPng, END_CARD_FADE_IN_MS, END_CARD_MAX_BYTES, endCardPlacement, writeEndCardFadeFrames } from "./end-card.mjs";
import { graphicInputArgs, graphicOverlayFilters, graphicPartsInScene, graphicPlacement, validateGraphicsShape, writeGraphicFrames } from "./graphics-overlay.mjs";
import {
  buildAudioWatermarkWav8k,
  buildVideoWatermarkYuv420p,
  deriveProvenanceWatermark,
  detectMediaProvenanceWatermark,
  PROVENANCE_WATERMARK_VERSION,
} from "./provenance-watermark.mjs";

export {
  deriveProvenanceWatermark,
  detectMediaProvenanceWatermark,
  PROVENANCE_WATERMARK_VERSION,
};

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SCENES = 512;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
/** A frame listing costs about 40 bytes per audio frame: two hours of 20 ms frames is under 15 MB. */
const MAX_FRAME_LISTING_BYTES = 32 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ERROR_TEXT = 2_000;
const MIN_REQUEST_SECONDS = 5;
const MAX_REQUEST_SECONDS = 15;
const MIN_SCENE_MS = 5_000;
const MAX_SCENE_MS = 15_000;
/** A take starts at most this far in (a take is at most 15 s and a scene at least 5 s). Matches app/take-in-point.ts. */
const MAX_TAKE_IN_POINT_MS = 15_000;
const SOURCE_DURATION_TOLERANCE_MS = 250;
const FINAL_DURATION_TOLERANCE_MS = 50;
const MAX_FILTER_SCRIPT_BYTES = 1024 * 1024;
const CLIP_DURATION_TOLERANCE_MS = 2;
const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u;
const SHA256 = /^[a-f0-9]{64}$/i;

const IO_CONCURRENCY = 4;
const DEFAULT_FAST_ENCODE_PRESET = "veryfast";

/**
 * Run `fn(item, index)` over `items` with at most `concurrency` in flight.
 * Preserves deterministic sequential error precedence: if multiple items reject,
 * the lowest-index error is thrown.
 */
async function mapConcurrent(items, concurrency, fn) {
  const total = items.length;
  if (total === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, total));
  const results = new Array(total);
  const errors = new Array(total);
  let hasError = false;
  let next = 0;
  const worker = async () => {
    while (!hasError) {
      const index = next;
      next += 1;
      if (index >= total) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        errors[index] = error;
        hasError = true;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  if (hasError) {
    for (let i = 0; i < total; i += 1) {
      if (errors[i] !== undefined) throw errors[i];
    }
  }
  return results;
}
/** The first native policy: every take plays from its first frame as delivered. Retained so an
 * accepted v1 request renders exactly as it was accepted. */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V1 = Object.freeze({
  version: "native-assembly-avc-v1",
  videoCodec: "libx264",
  preset: "medium",
  crf: 18,
  pixelFormat: "yuv420p",
  videoTrackTimescale: 90000,
  audioCodec: "aac",
  audioBitrate: 256000,
  decoderThreads: 1,
  encoderThreads: 4,
  filterThreads: 1,
  timeline: "absolute-nearest-frame",
  masterAudio: "complete-source-from-zero",
});

/** The second native policy. Retained verbatim for already-accepted jobs: its hard frame map can
 * hold or skip picture when a provider take's embedded sound jumps. */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V2 = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY_V1,
  version: "native-assembly-avc-v2",
  takeSound: TAKE_SOUND_SYNC_V1_VERSION,
});

/** The current policy: measure the same provider timing fault, but reject a repair that would
 * manufacture a visible freeze or jump instead of silently shipping a damaged master. */
export const NATIVE_ASSEMBLY_ENCODING_POLICY = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY_V2,
  version: "native-assembly-avc-v3",
  takeSound: TAKE_SOUND_SYNC_VERSION,
  takeSoundVisibleDiscontinuity: "reject-v1",
});

/**
 * The fourth native policy: the third, and a scene whose take starts partway in (`scene.takeInPointMs`), checked
 * at that offset. A take rendered for a longer stretch of the song serves a scene inside it from the offset; the
 * sound check then measures the take from the offset, and a take whose sound does not match the song there is
 * refused rather than rendered misaligned. A cut with no in-point renders under v3, never v4.
 */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V4 = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY,
  version: "native-assembly-avc-v4",
  takeInPoint: "scene-take-in-point-v1",
});

/**
 * The fifth native policy: the third, except that a scene whose take cannot be lined up with the song without a visible
 * freeze or jump (its own sound steps mid-clip and the retiming would hold or skip the picture past 80 ms, or the take sits
 * more than 1.5 s off the song over most of the scene) renders exactly as delivered, as the browser lane renders it, and
 * stays named in the report's `takeSoundSync.scenes` with its reason, instead of refusing the whole film as v3 does.
 */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V5 = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY,
  version: "native-assembly-avc-v5",
  takeSoundVisibleDiscontinuity: "deliver-v1",
});

/** The sixth native policy: the fourth (a scene's take can start partway in) with the fifth's treatment of a take whose sound steps. */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V6 = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY_V4,
  version: "native-assembly-avc-v6",
  takeSoundVisibleDiscontinuity: "deliver-v1",
});

/**
 * The seventh native policy: the fifth, and a last scene that carries an end card (`scene.endCard`): a PNG at exactly the
 * film's frame size, drawn outside the video model so its lettering is exact, laid over the scene from its first frame
 * (`fromLocalMs`, on the absolute grid) to the end, alpha respected and faded in over about 300 ms. A transparent card lies
 * over the moving shot; an opaque one is a full card. Only that scene's encode changes: every other scene, the join and the
 * audio are exactly the fifth policy's. A cut with no end card renders under v5, never v7.
 */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V7 = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY_V5,
  version: "native-assembly-avc-v7",
  endCard: "png-rgba-overlay-v1",
  endCardFadeInMs: END_CARD_FADE_IN_MS,
  endCardColorMatrix: "bt709-limited",
});

/** The eighth native policy: the sixth (a scene's take can start partway in) with the seventh's end card. */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V8 = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY_V6,
  version: "native-assembly-avc-v8",
  endCard: NATIVE_ASSEMBLY_ENCODING_POLICY_V7.endCard,
  endCardFadeInMs: NATIVE_ASSEMBLY_ENCODING_POLICY_V7.endCardFadeInMs,
  endCardColorMatrix: NATIVE_ASSEMBLY_ENCODING_POLICY_V7.endCardColorMatrix,
});

/**
 * The ninth native policy: the seventh (the fifth, with an end card when the last scene carries one), and the film's
 * on-screen graphics (`manifest.graphics`, docs/AD_GRAPHICS.md): exact words drawn outside the video model by the renderer
 * that is handed them, as plates laid over any scene from a frame to a frame, faded in and out over about 200 ms. Only the
 * encodes of the scenes a graphic falls in change. A cut has graphics under v9 (v10 with an in-point) and only those; its
 * end card is optional there.
 */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V9 = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY_V7,
  version: "native-assembly-avc-v9",
  graphics: "ad-graphics-rgba-overlay-v1",
  graphicsFadeMs: 200,
});

/** The tenth native policy: the eighth (a take can start partway in, with the end card) with the ninth's graphics. */
export const NATIVE_ASSEMBLY_ENCODING_POLICY_V10 = Object.freeze({
  ...NATIVE_ASSEMBLY_ENCODING_POLICY_V8,
  version: "native-assembly-avc-v10",
  graphics: NATIVE_ASSEMBLY_ENCODING_POLICY_V9.graphics,
  graphicsFadeMs: NATIVE_ASSEMBLY_ENCODING_POLICY_V9.graphicsFadeMs,
});

export const NATIVE_ASSEMBLY_ENCODING_POLICIES = Object.freeze({
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V1.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V1,
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V2.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V2,
  [NATIVE_ASSEMBLY_ENCODING_POLICY.version]: NATIVE_ASSEMBLY_ENCODING_POLICY,
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V4.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V4,
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V5.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V5,
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V6.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V6,
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V7.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V7,
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V8.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V8,
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V9.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V9,
  [NATIVE_ASSEMBLY_ENCODING_POLICY_V10.version]: NATIVE_ASSEMBLY_ENCODING_POLICY_V10,
});

/** Mono analysis audio for at most about 33 minutes; longer sources skip take sound sync. */
const MAX_ANALYSIS_PCM_BYTES = 64 * 1024 * 1024;

const NATIVE_AUDIO_FORMATS = Object.freeze({
  ".mp3": "mp3", ".wav": "wav", ".flac": "flac", ".aac": "aac",
  ".m4a": "mov", ".mp4": "mov", ".ogg": "ogg", ".oga": "ogg", ".opus": "ogg",
});

export function nativeAudioInputFormat(filename) {
  const format = NATIVE_AUDIO_FORMATS[path.extname(filename).toLowerCase()];
  if (!format) throw new Error("Native master audio must be MP3, WAV, FLAC, AAC, M4A, MP4, Ogg or Opus; playlists are not accepted.");
  return format;
}

function selfContainedInputArgs(format) {
  if (!Object.values(NATIVE_AUDIO_FORMATS).includes(format)) throw new Error("Native input requires an approved self-contained media format.");
  // A file-only protocol allowlist alone still permits HLS/concat to open
  // other local files. Force the demuxer before parsing untrusted bytes and
  // disable MOV external track references even on builds with other defaults.
  return ["-f", format, "-format_whitelist", format, "-protocol_whitelist", "file",
    ...(format === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : [])];
}

function usage() {
  return [
    "Usage:",
    "  node assemble-master.mjs --manifest <manifest.json> --song <master.mp3|wav>",
    "    --clips-dir <directory> --output <final.mp4> [--origin <https://host>]",
  ].join("\n");
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(usage());
    }
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set(["--manifest", "--song", "--clips-dir", "--output", "--origin"]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}\n${usage()}`);
  }
  for (const flag of ["--manifest", "--song", "--clips-dir", "--output"]) {
    if (!values.get(flag)) throw new Error(`Missing ${flag}.\n${usage()}`);
  }
  return {
    manifestPath: path.resolve(values.get("--manifest")),
    songPath: path.resolve(values.get("--song")),
    clipsDir: path.resolve(values.get("--clips-dir")),
    outputPath: path.resolve(values.get("--output")),
    origin: values.get("--origin"),
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeFilename(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && value !== "."
    && value !== ".."
    && !/[\x00-\x1f<>:"/\\|?*]/u.test(value);
}

function normalizeOrigin(value) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--origin must be an absolute HTTP(S) origin.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("--origin must be an absolute HTTP(S) origin without credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("--origin must not contain a path, query, or fragment.");
  }
  return parsed.origin;
}

function validateAssetPath(value, issue) {
  if (value === undefined) return;
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    issue("assetPath must be a same-origin relative path beginning with one slash.");
    return;
  }
  try {
    const parsed = new URL(value, "https://manifest.invalid");
    if (parsed.origin !== "https://manifest.invalid" || parsed.username || parsed.password || parsed.hash) {
      issue("assetPath must stay on the configured origin and must not contain credentials or a fragment.");
    }
  } catch {
    issue("assetPath is not a valid relative URL path.");
  }
}

/** An end card: on the last scene only, a PNG beside the takes, from a frame inside the scene to its end. */
function validateEndCard(card, { field, last, sceneDurationMs, filenames, add }) {
  if (!last) add(field, "Only the last scene can carry an end card.");
  if (!isPlainObject(card)) {
    add(field, "Must be an object with image and fromLocalMs.");
    return;
  }
  if (!Number.isSafeInteger(card.fromLocalMs) || card.fromLocalMs < 0 || !(sceneDurationMs > card.fromLocalMs)) {
    add(`${field}.fromLocalMs`, "Must be an integer inside the scene from zero through its duration - 1.");
  }
  if (!isPlainObject(card.image)) {
    add(`${field}.image`, "Must be an object.");
    return;
  }
  if (!isSafeFilename(card.image.filename) || !/\.png$/iu.test(card.image.filename)) {
    add(`${field}.image.filename`, "Must be a portable .png filename without a directory path.");
  } else if (filenames.has(card.image.filename.toLocaleLowerCase("en-US"))) {
    add(`${field}.image.filename`, "Must differ from every clip filename (case-insensitive).");
  }
  if (card.image.sha256 !== undefined && (typeof card.image.sha256 !== "string" || !SHA256.test(card.image.sha256))) add(`${field}.image.sha256`, "Must be a SHA-256 digest.");
  if (card.image.bytes !== undefined && (!Number.isSafeInteger(card.image.bytes) || card.image.bytes <= 0 || card.image.bytes > END_CARD_MAX_BYTES)) {
    add(`${field}.image.bytes`, `Must be a positive integer byte count up to ${END_CARD_MAX_BYTES}.`);
  }
}

export function validateAssemblyManifest(value) {
  const issues = [];
  const add = (field, message) => issues.push({ field, message });
  if (!isPlainObject(value)) return [{ field: "$", message: "Manifest must be an object." }];
  if (value.schemaVersion !== 1) add("$.schemaVersion", "Must equal 1.");
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs <= 0 || value.durationMs > MAX_DURATION_MS) {
    add("$.durationMs", `Must be an integer from 1 through ${MAX_DURATION_MS}.`);
  }
  if (!isPlainObject(value.masterAudio)) {
    add("$.masterAudio", "Must be an object.");
  } else {
    if (!isSafeFilename(value.masterAudio.filename)) {
      add("$.masterAudio.filename", "Must be a portable filename without a directory path.");
    }
    if (value.masterAudio.sha256 !== undefined && (typeof value.masterAudio.sha256 !== "string" || !SHA256.test(value.masterAudio.sha256))) {
      add("$.masterAudio.sha256", "Must be a 64-character hexadecimal SHA-256 digest.");
    }
  }
  if (!Array.isArray(value.scenes) || value.scenes.length === 0 || value.scenes.length > MAX_SCENES) {
    add("$.scenes", `Must contain 1-${MAX_SCENES} scenes.`);
    return issues;
  }

  let expectedStartMs = 0;
  const ids = new Set();
  const filenames = new Set();
  value.scenes.forEach((scene, index) => {
    const field = `$.scenes[${index}]`;
    if (!isPlainObject(scene)) {
      add(field, "Must be an object.");
      return;
    }
    const idValid = (Number.isSafeInteger(scene.id) && scene.id >= 0)
      || (typeof scene.id === "string" && SAFE_ID.test(scene.id));
    if (!idValid) add(`${field}.id`, "Must be a non-negative safe integer or a portable 1-80 character string.");
    else {
      const key = `${typeof scene.id}:${String(scene.id)}`;
      if (ids.has(key)) add(`${field}.id`, "Must be unique.");
      ids.add(key);
    }
    if (!Number.isSafeInteger(scene.startMs) || scene.startMs < 0) add(`${field}.startMs`, "Must be a non-negative integer.");
    if (!Number.isSafeInteger(scene.endMs) || scene.endMs <= 0) add(`${field}.endMs`, "Must be a positive integer.");
    if (Number.isSafeInteger(scene.startMs) && scene.startMs !== expectedStartMs) {
      add(`${field}.startMs`, `Must equal the previous end ${expectedStartMs}.`);
    }
    let sceneDurationMs;
    if (Number.isSafeInteger(scene.startMs) && Number.isSafeInteger(scene.endMs)) {
      sceneDurationMs = scene.endMs - scene.startMs;
      if (sceneDurationMs < MIN_SCENE_MS || sceneDurationMs > MAX_SCENE_MS) {
        add(`${field}.endMs`, `Scene duration must be ${MIN_SCENE_MS}-${MAX_SCENE_MS} ms.`);
      }
      expectedStartMs = scene.endMs;
    }
    if (!Number.isSafeInteger(scene.requestSeconds) || scene.requestSeconds < MIN_REQUEST_SECONDS || scene.requestSeconds > MAX_REQUEST_SECONDS) {
      add(`${field}.requestSeconds`, `Must be an integer from ${MIN_REQUEST_SECONDS} through ${MAX_REQUEST_SECONDS}.`);
    } else if (sceneDurationMs > 0 && scene.requestSeconds * 1000 < sceneDurationMs) {
      add(`${field}.requestSeconds`, "Must cover the complete source scene duration.");
    }
    if (scene.blackAfterLocalMs !== undefined) {
      if (!Number.isSafeInteger(scene.blackAfterLocalMs) || scene.blackAfterLocalMs < 0 || !(sceneDurationMs > scene.blackAfterLocalMs)) {
        add(`${field}.blackAfterLocalMs`, "Must be an integer inside the scene from zero through durationMs - 1.");
      }
    }
    if (scene.takeInPointMs !== undefined) {
      if (!Number.isSafeInteger(scene.takeInPointMs) || scene.takeInPointMs < 1 || scene.takeInPointMs > MAX_TAKE_IN_POINT_MS) {
        add(`${field}.takeInPointMs`, `Must be a whole number of milliseconds from 1 through ${MAX_TAKE_IN_POINT_MS}; leave it out to start the take at its first frame.`);
      }
    }
    if (!isPlainObject(scene.clip)) {
      add(`${field}.clip`, "Must be an object.");
    } else {
      if (!isSafeFilename(scene.clip.filename)) {
        add(`${field}.clip.filename`, "Must be a portable filename without a directory path.");
      } else {
        const key = scene.clip.filename.toLocaleLowerCase("en-US");
        if (filenames.has(key)) add(`${field}.clip.filename`, "Must be unique (case-insensitive).");
        filenames.add(key);
      }
      validateAssetPath(scene.clip.assetPath, (message) => add(`${field}.clip.assetPath`, message));
      if (scene.clip.sha256 !== undefined && (typeof scene.clip.sha256 !== "string" || !SHA256.test(scene.clip.sha256))) add(`${field}.clip.sha256`, "Must be a SHA-256 digest.");
      if (scene.clip.bytes !== undefined && (!Number.isSafeInteger(scene.clip.bytes) || scene.clip.bytes <= 0)) add(`${field}.clip.bytes`, "Must be a positive integer byte count.");
    }
    if (scene.endCard !== undefined) validateEndCard(scene.endCard, { field: `${field}.endCard`, last: index === value.scenes.length - 1, sceneDurationMs, filenames, add });
  });
  if (Number.isSafeInteger(value.durationMs) && expectedStartMs !== value.durationMs) {
    add("$.scenes", `Final end ${expectedStartMs} must equal durationMs ${value.durationMs}.`);
  }
  if (value.graphics !== undefined) validateGraphicsShape(value.graphics, value.durationMs, add);
  return issues;
}

export async function readAndValidateManifest(manifestPath) {
  const source = await readFile(manifestPath);
  if (source.byteLength > MAX_MANIFEST_BYTES) throw new Error(`Manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`);
  let manifest;
  try {
    const text = source.toString("utf8");
    manifest = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error("Manifest is not valid UTF-8 JSON.");
  }
  const issues = validateAssemblyManifest(manifest);
  if (issues.length) {
    throw new Error(`Manifest validation failed: ${issues.map(({ field, message }) => `${field} ${message}`).join(" ")}`);
  }
  return manifest;
}

function toolConfig(name) {
  const upper = name.toUpperCase();
  const command = process.env[`SLOPCANNON_${upper}_PATH`] || process.env[`${upper}_PATH`] || name;
  let prefixArgs = [];
  const rawPrefix = process.env[`SLOPCANNON_${upper}_ARGS`];
  if (rawPrefix) {
    try {
      prefixArgs = JSON.parse(rawPrefix);
    } catch {
      throw new Error(`SLOPCANNON_${upper}_ARGS must be a JSON string array.`);
    }
    if (!Array.isArray(prefixArgs) || prefixArgs.some((value) => typeof value !== "string")) {
      throw new Error(`SLOPCANNON_${upper}_ARGS must be a JSON string array.`);
    }
  }
  return { command, prefixArgs };
}

export function runMediaTool(name, args, {
  maxStdoutBytes = MAX_TOOL_OUTPUT_BYTES,
  signal,
  timeoutMs,
  toolPaths,
  localFilesOnly = false,
} = {}) {
  signal?.throwIfAborted();
  const { command, prefixArgs } = toolPaths?.[name] ? { command: toolPaths[name], prefixArgs: [] } : toolConfig(name);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefixArgs, ...(localFilesOnly ? ["-protocol_whitelist", "file,pipe"] : []), ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    let stopped;
    let forceStop;
    const stop = (error) => {
      if (stopped) return;
      stopped = error;
      child.kill("SIGTERM");
      forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceStop.unref();
    };
    const abort = () => stop(new Error("Assembly was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const deadline = timeoutMs ? setTimeout(() => stop(new Error(`${name} exceeded its execution deadline.`)), timeoutMs) : undefined;
    deadline?.unref();
    const append = (current, chunk, limit) => {
      if (current.byteLength >= limit) return current;
      return Buffer.concat([current, chunk.subarray(0, limit - current.byteLength)]);
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk, maxStdoutBytes);
      if (stdout.byteLength >= maxStdoutBytes) {
        overflow = true;
        stop(new Error(`${name} returned more output than allowed.`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk, MAX_ERROR_TEXT);
    });
    child.on("error", (error) => reject(new Error(`${name} could not start: ${error.message}`)));
    child.on("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(forceStop);
      signal?.removeEventListener("abort", abort);
      if (stopped) return reject(stopped);
      if (overflow) return reject(new Error(`${name} returned more output than allowed.`));
      if (code !== 0) {
        const detail = stderr.toString("utf8").trim().replace(/\s+/gu, " ");
        return reject(new Error(`${name} failed${detail ? `: ${detail}` : ` with exit code ${code}`}.`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function finiteNumber(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function durationFromProbe(probe, stream) {
  return finiteNumber(stream?.duration) ?? finiteNumber(probe?.format?.duration);
}

export function parseFrameRate(value) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)(?:\/(\d+))?$/.exec(value);
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2] ?? 1);
  if (!(numerator > 0) || !(denominator > 0)) return undefined;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate >= 1 && rate <= 240 ? { expression: `${numerator}/${denominator}`, rate } : undefined;
}

export async function probeMedia(file, execution = {}, format) {
  const { stdout } = await runMediaTool("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,start_time:stream=index,codec_type,codec_name,width,height,duration,start_time,r_frame_rate,avg_frame_rate,sample_rate,channels,nb_frames,pix_fmt,sample_aspect_ratio,time_base:stream_disposition=attached_pic",
    "-of", "json",
    ...(format ? selfContainedInputArgs(format) : []), file,
  ], execution);
  try {
    const parsed = JSON.parse(stdout.toString("utf8"));
    if (!isPlainObject(parsed) || !Array.isArray(parsed.streams)) throw new Error();
    return parsed;
  } catch {
    throw new Error("ffprobe returned invalid media metadata.");
  }
}

/**
 * How long the master audio plays, measured the way the mux hears it: decoded through the same timestamp reset, to the end of
 * the last frame. A container's own duration is not that figure. For an MP3 with no Xing/Info header or a raw AAC stream it is an
 * estimate from file size and bit rate: a ripped MP3 whose frames carry no padding probed 192,132 ms and decoded to 192,340 ms
 * (production, 2026-10-19), and the muxed audio can never agree with the estimate. The frame listing (`framecrc`) is read for
 * its last line, whose start and length are in samples: `-progress` reports the start of the last frame on ffmpeg 6.1 and its
 * end on 8.1, so it is not a measure.
 */
export async function decodedAudioDurationMs(file, execution = {}, format) {
  const { stdout } = await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    ...(format ? selfContainedInputArgs(format) : []), "-i", file,
    "-filter_complex", "[0:a:0]asetpts=PTS-STARTPTS[a]", "-map", "[a]", "-f", "framecrc", "-",
  ], { ...execution, maxStdoutBytes: MAX_FRAME_LISTING_BYTES });
  const lines = stdout.toString("utf8").split(/\r?\n/);
  const timeBase = lines.map((line) => /^#tb 0: (\d+)\/(\d+)$/.exec(line)).find(Boolean);
  // A frame line reads: stream, dts, pts, duration, size, checksum (side data, if any, follows).
  const last = lines.filter((line) => line !== "" && !line.startsWith("#")).at(-1)?.split(",").map((field) => Number(field.trim()));
  const durationMs = timeBase && last?.length >= 6 ? Math.round((last[2] + last[3]) * Number(timeBase[1]) * 1000 / Number(timeBase[2])) : NaN;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("Master audio duration could not be decoded.");
  return durationMs;
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(3);
}

export function framesForMilliseconds(milliseconds, frameRate) {
  return Math.round(milliseconds * frameRate.rate / 1000);
}

/** Take frames to skip so the scene's picture starts where its in-point says (0 when the take starts at its first frame). */
export function takeInPointFrames(scene, frameRate) {
  return scene.takeInPointMs === undefined ? 0 : takeInPointFrameIndex(scene.takeInPointMs, frameRate.rate);
}

function ensureUnderRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function fetchSameOriginAsset({ assetPath, origin, destination, sceneLabel }) {
  if (!origin) throw new Error(`${sceneLabel} is missing locally and needs --origin for its hosted asset.`);
  const token = process.env.SLOPCANNON_AGENT_TOKEN?.trim();
  if (!token) throw new Error(`${sceneLabel} is missing locally and hosted retrieval needs SLOPCANNON_AGENT_TOKEN.`);
  const allowedOrigin = trustedOrigin(origin);
  let url = new URL(assetPath, allowedOrigin);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (url.origin !== allowedOrigin) throw new Error(`${sceneLabel} hosted retrieval refused a cross-origin redirect.`);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error(`${sceneLabel} hosted retrieval returned an invalid redirect.`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`${sceneLabel} hosted retrieval failed with HTTP ${response.status}.`);
    const declaredLength = finiteNumber(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > MAX_DOWNLOAD_BYTES) throw new Error(`${sceneLabel} hosted clip exceeds the download limit.`);
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) callback(new Error(`${sceneLabel} hosted clip exceeds the download limit.`));
        else callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { flags: "wx" }));
    if (received === 0) throw new Error(`${sceneLabel} hosted clip is empty.`);
    return received;
  }
  throw new Error(`${sceneLabel} hosted retrieval exceeded the redirect limit.`);
}

async function resolveClipFiles(manifest, clipsDir, origin, tempDir, preverifiedHashes = false) {
  const resolvedRoot = await realpath(clipsDir);
  const rootStatus = await stat(resolvedRoot);
  if (!rootStatus.isDirectory()) throw new Error("--clips-dir must be a directory.");
  let remoteFetchCount = 0;
  const results = await mapConcurrent(manifest.scenes, IO_CONCURRENCY, async (scene, index) => {
    const candidate = path.resolve(resolvedRoot, scene.clip.filename);
    if (!ensureUnderRoot(resolvedRoot, candidate)) throw new Error(`Scene ${index + 1} clip escapes --clips-dir.`);
    let selected = candidate;
    let local = true;
    try {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink()) throw new Error(`Scene ${index + 1} local clip must not be a symbolic link.`);
      if (!entry.isFile() || entry.size === 0) throw new Error(`Scene ${index + 1} local clip is missing or empty.`);
      const canonical = await realpath(candidate);
      if (!ensureUnderRoot(resolvedRoot, canonical)) throw new Error(`Scene ${index + 1} local clip escapes --clips-dir.`);
      selected = canonical;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!scene.clip.assetPath) throw new Error(`Scene ${index + 1} clip is missing from --clips-dir.`);
      selected = path.join(tempDir, `download-${String(index + 1).padStart(4, "0")}.mp4`);
      await fetchSameOriginAsset({
        assetPath: scene.clip.assetPath,
        origin,
        destination: selected,
        sceneLabel: `Scene ${index + 1}`,
      });
      local = false;
      remoteFetchCount += 1;
    }
    if (!preverifiedHashes || !local) {
      if (scene.clip.bytes !== undefined && (await stat(selected)).size !== scene.clip.bytes) throw new Error(`Scene ${index + 1} clip byte count does not match the manifest.`);
      if (scene.clip.sha256 && await sha256File(selected) !== scene.clip.sha256.toLowerCase()) throw new Error(`Scene ${index + 1} clip SHA-256 does not match the manifest.`);
    }
    return { file: selected, local };
  });
  return { results, remoteFetchCount };
}

/** The last scene's end card, if it has one. */
export function manifestEndCard(manifest) {
  const scene = manifest.scenes.at(-1);
  return scene?.endCard ? { scene, index: manifest.scenes.length - 1, card: scene.endCard } : null;
}

/** The end card's file beside the takes: a regular local file, never a link, matching its manifest bytes and digest. */
async function resolveEndCardFile(card, clipsDir) {
  const resolvedRoot = await realpath(clipsDir);
  const candidate = path.resolve(resolvedRoot, card.image.filename);
  if (!ensureUnderRoot(resolvedRoot, candidate)) throw new Error("The end card escapes --clips-dir.");
  let entry;
  try { entry = await lstat(candidate); } catch (error) {
    if (error?.code === "ENOENT") throw new Error("The end card is missing from --clips-dir.");
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size === 0) throw new Error("The end card must be a nonempty regular file.");
  const file = await realpath(candidate);
  if (!ensureUnderRoot(resolvedRoot, file)) throw new Error("The end card escapes --clips-dir.");
  if (entry.size > END_CARD_MAX_BYTES) throw new Error(`The end card exceeds ${END_CARD_MAX_BYTES} bytes.`);
  if (card.image.bytes !== undefined && entry.size !== card.image.bytes) throw new Error("The end card byte count does not match the manifest.");
  const sha256 = await sha256File(file);
  if (card.image.sha256 && sha256 !== card.image.sha256.toLowerCase()) throw new Error("The end card SHA-256 does not match the manifest.");
  return { file, sha256 };
}

export async function validateInputs({ manifest, songPath, clipFiles, execution = {}, native = false, preverifiedSongHash }) {
  const songStatus = await stat(songPath);
  if (!songStatus.isFile() || songStatus.size === 0) throw new Error("--song must be a non-empty file.");
  const songHash = preverifiedSongHash ?? await sha256File(songPath);
  if (manifest.masterAudio.sha256 && songHash !== manifest.masterAudio.sha256.toLowerCase()) {
    throw new Error("Master audio SHA-256 does not match the manifest.");
  }
  const songFormat = native ? nativeAudioInputFormat(manifest.masterAudio.filename) : undefined;
  const songProbe = await probeMedia(songPath, execution, songFormat);
  const audioStreams = songProbe.streams.filter((stream) => stream.codec_type === "audio");
  if (audioStreams.length !== 1) throw new Error("Master audio must contain exactly one audio stream.");
  // The probe says what the audio is (exactly one stream); how long it plays is measured by decoding it, not read from its header.
  // Run the song decode and the parallel clip probes together while keeping the song duration check first in precedence.
  const [songDurationOutcome, clipProbesOutcome] = await Promise.allSettled([
    decodedAudioDurationMs(songPath, execution, songFormat),
    mapConcurrent(clipFiles, IO_CONCURRENCY, (clip) => probeMedia(clip.file, execution, native ? "mov" : undefined)),
  ]);
  if (songDurationOutcome.status === "rejected") throw songDurationOutcome.reason;
  const songDurationMs = songDurationOutcome.value;
  const sourceDurationDeltaMs = songDurationMs - manifest.durationMs;
  if (Math.abs(sourceDurationDeltaMs) > SOURCE_DURATION_TOLERANCE_MS) {
    throw new Error(`Master audio duration differs from manifest duration by ${sourceDurationDeltaMs} ms.`);
  }
  if (clipProbesOutcome.status === "rejected") throw clipProbesOutcome.reason;
  const clipProbes = clipProbesOutcome.value;

  let dimensions;
  let frameRate;
  const sourceFrameRates = [];
  const clipMetadata = [];
  for (let index = 0; index < clipFiles.length; index += 1) {
    const probe = clipProbes[index];
    const videoStreams = probe.streams.filter((stream) => stream.codec_type === "video");
    if (videoStreams.length !== 1) throw new Error(`Scene ${index + 1} clip must contain exactly one video stream.`);
    const stream = videoStreams[0];
    if (!Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) || stream.width < 2 || stream.height < 2) {
      throw new Error(`Scene ${index + 1} clip has invalid dimensions.`);
    }
    if (stream.width % 2 || stream.height % 2) throw new Error(`Scene ${index + 1} clip dimensions must be even.`);
    if (native && (stream.width > 4096 || stream.height > 4096 || stream.pix_fmt !== "yuv420p")) {
      throw new Error(`Scene ${index + 1} requires a pixel format or dimensions outside the native parity policy.`);
    }
    const currentDimensions = `${stream.width}x${stream.height}`;
    if (dimensions && currentDimensions !== dimensions) throw new Error(`Scene ${index + 1} clip dimensions do not match earlier scenes.`);
    dimensions = currentDimensions;
    const currentRate = parseFrameRate(stream.r_frame_rate) ?? parseFrameRate(stream.avg_frame_rate);
    if (!currentRate) throw new Error(`Scene ${index + 1} clip frame rate could not be decoded.`);
    if (native && currentRate.rate > 60) throw new Error(`Scene ${index + 1} exceeds the native 60 fps resource limit.`);
    frameRate ??= currentRate;
    sourceFrameRates.push(currentRate.expression);
    const clipDuration = durationFromProbe(probe, stream);
    if (!(clipDuration > 0)) throw new Error(`Scene ${index + 1} clip duration could not be decoded.`);
    const scene = manifest.scenes[index];
    const takeInPointMs = scene.takeInPointMs ?? 0;
    const requiredVisualMs = scene.blackAfterLocalMs ?? (scene.endMs - scene.startMs);
    const availableMs = Math.round(clipDuration * 1000);
    if (availableMs + CLIP_DURATION_TOLERANCE_MS < takeInPointMs + requiredVisualMs) {
      // A take started partway in is refused in words a customer can act on (see nativeAssemblyCustomerFailure).
      throw new Error(takeInPointMs
        ? `Selected take does not fit scene ${index + 1}. It starts ${takeInPointMs} ms in and is ${takeInPointMs + requiredVisualMs - availableMs} ms too short to fill the scene.`
        : `Scene ${index + 1} clip is ${requiredVisualMs - availableMs} ms shorter than its required visual duration.`);
    }
    clipMetadata.push({ durationMs: availableMs, requiredVisualMs, hasAudio: probe.streams.some((candidate) => candidate.codec_type === "audio") });
  }
  return {
    songHash,
    sourceAudioDurationMs: songDurationMs,
    sourceDurationDeltaMs,
    dimensions,
    width: Number(dimensions.split("x")[0]),
    height: Number(dimensions.split("x")[1]),
    frameRate,
    clipMetadata,
    sourceFrameRates,
  };
}

export function buildAbsoluteTimeline(manifest, frameRate, dimensions) {
  const filters = [];
  const concatLabels = [];
  const boundaries = [];
  let previousEndFrame = 0;
  for (let index = 0; index < manifest.scenes.length; index += 1) {
    const scene = manifest.scenes[index];
    const expectedStartFrame = framesForMilliseconds(scene.startMs, frameRate);
    const expectedEndFrame = framesForMilliseconds(scene.endMs, frameRate);
    if (expectedStartFrame !== previousEndFrame) throw new Error(`Scene ${index + 1} cannot join on the selected frame grid.`);
    const sceneFrames = expectedEndFrame - expectedStartFrame;
    if (sceneFrames <= 0) throw new Error(`Scene ${index + 1} is shorter than one output frame.`);
    let visualFrames = sceneFrames;
    if (scene.blackAfterLocalMs !== undefined) {
      visualFrames = framesForMilliseconds(scene.startMs + scene.blackAfterLocalMs, frameRate) - expectedStartFrame;
      visualFrames = Math.max(0, Math.min(sceneFrames, visualFrames));
    }
    const blackFrames = sceneFrames - visualFrames;
    const clipLabel = `clip${index}`;
    const takeStartFrame = takeInPointFrames(scene, frameRate);
    if (visualFrames > 0) {
      filters.push(`[${index}:v:0]setpts=PTS-STARTPTS,fps=${frameRate.expression},trim=start_frame=${takeStartFrame}:end_frame=${takeStartFrame + visualFrames},setpts=PTS-STARTPTS,format=yuv420p[${clipLabel}]`);
      concatLabels.push(`[${clipLabel}]`);
    }
    if (blackFrames > 0) {
      const blackLabel = `black${index}`;
      filters.push(`color=c=black:s=${dimensions}:r=${frameRate.expression},trim=start_frame=0:end_frame=${blackFrames},setpts=PTS-STARTPTS,format=yuv420p[${blackLabel}]`);
      concatLabels.push(`[${blackLabel}]`);
    }
    const realizedStartMs = previousEndFrame * 1000 / frameRate.rate;
    const realizedEndMs = expectedEndFrame * 1000 / frameRate.rate;
    boundaries.push({
      sceneId: scene.id,
      expectedStartMs: scene.startMs,
      realizedStartMs: Math.round(realizedStartMs * 1000) / 1000,
      startDeltaMs: Math.round((realizedStartMs - scene.startMs) * 1000) / 1000,
      expectedEndMs: scene.endMs,
      realizedEndMs: Math.round(realizedEndMs * 1000) / 1000,
      endDeltaMs: Math.round((realizedEndMs - scene.endMs) * 1000) / 1000,
    });
    previousEndFrame = expectedEndFrame;
  }
  filters.push(`${concatLabels.join("")}concat=n=${concatLabels.length}:v=1:a=0[outv]`);
  return {
    filter: filters.join(";\n"),
    boundaries,
    outputFrames: previousEndFrame,
    realizedDurationMs: previousEndFrame * 1000 / frameRate.rate,
  };
}

/**
 * The filter that shows take frame `frameIndexes[n]` at output frame n, in one pass. The indexes
 * never decrease (a retiming drops or holds frames, never goes back), so: keep the frames that
 * appear, place each at the first output frame that shows it, let fps repeat a frame across a
 * hold, and pad/trim to the exact count.
 * @param {number[]} frameIndexes
 * @param {{ expression: string }} frameRate
 */
export function retimedTakeFilter(frameIndexes, frameRate) {
  /** @type {{ frame: number, position: number }[]} */
  const kept = [];
  frameIndexes.forEach((frame, position) => {
    if (position > 0 && frame < frameIndexes[position - 1]) throw new Error("A take retiming must never step back in the take.");
    if (position === 0 || frame !== frameIndexes[position - 1]) kept.push({ frame, position });
  });
  /** Groups of kept frames that are consecutive in both the take and the output. */
  const groups = [];
  kept.forEach((entry, keptIndex) => {
    const last = groups[groups.length - 1];
    const previous = kept[keptIndex - 1];
    if (last && previous && entry.frame === previous.frame + 1 && entry.position - entry.frame === last.offset) last.to = entry.frame;
    else groups.push({ from: entry.frame, to: entry.frame, keptStart: keptIndex, offset: entry.position - entry.frame });
  });
  const select = groups.map((group) => `between(n,${group.from},${group.to})`).join("+");
  // Output position of the N-th kept frame: within a group, N + (group's first position - its first N).
  let placement = "";
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    const shift = group.offset + group.from - group.keptStart;
    const term = `N+${shift}`;
    placement = index === groups.length - 1 ? term : `if(lt(N,${groups[index + 1].keptStart}),${term},${placement})`;
  }
  return `fps=${frameRate.expression},select='${select}',setpts='(${placement})/(${frameRate.expression})/TB',fps=${frameRate.expression},tpad=stop_mode=clone:stop=${frameIndexes.length},trim=start_frame=0:end_frame=${frameIndexes.length}`;
}

/**
 * The end card laid over a scene's finished picture (`[base]`), from scene frame `fromFrame` to the end. The card arrives as
 * raw RGBA fade frames (see writeEndCardFadeFrames) on input 1. Both streams count frames on the same 1/rate clock, so frame
 * n of the scene meets card frame n - fromFrame exactly: before `fromFrame` the overlay has no card frame and passes the
 * scene through untouched, and after the fade it holds the last card frame (the card as drawn) to the scene's end. The
 * scene's own frames drive the output, so its frame count never changes. No `enable` expression: overlay evaluates one
 * against frames it has already read ahead, which skips fade frames (FFmpeg 6.1, measured). The card is converted to the
 * film's BT.709 limited-range YUV once per fade frame and never scaled: its size is the film's.
 */
export function endCardOverlayFilter({ fromFrame, frameRate }) {
  const [numerator, denominator] = frameRate.expression.split("/");
  const tick = `${denominator ?? 1}/${numerator}`;
  return [
    `[base]settb=${tick},setpts=N[main]`,
    `[1:v:0]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,settb=${tick},setpts=N+${fromFrame}[card]`,
    `[main][card]overlay=x=0:y=0:format=yuv420:eof_action=repeat,format=yuv420p[outv]`,
  ];
}

/** Raw RGBA card frames: a demuxer every FFmpeg build carries, read only from the local file, at the card's exact size. */
function endCardInputArgs(card, frameRate) {
  return ["-f", "rawvideo", "-format_whitelist", "rawvideo", "-protocol_whitelist", "file",
    "-pix_fmt", "rgba", "-video_size", `${card.width}x${card.height}`, "-framerate", frameRate.expression, "-i", card.file];
}

function watermarkInputArgs(watermarkFile, dimensions, frameRate) {
  return ["-f", "rawvideo", "-format_whitelist", "rawvideo", "-protocol_whitelist", "file",
    "-pix_fmt", "yuv420p", "-video_size", dimensions, "-framerate", frameRate.expression, "-i", watermarkFile];
}

export async function encodeSceneOnAbsoluteGrid({ scene, index, sourceFile, outputFile, dimensions, frameRate, execution = {}, native = false, maxOutputBytes, frameIndexes, endCard, watermarkFile, graphicParts = [] }) {
  const expectedStartFrame = framesForMilliseconds(scene.startMs, frameRate);
  const expectedEndFrame = framesForMilliseconds(scene.endMs, frameRate);
  const sceneFrames = expectedEndFrame - expectedStartFrame;
  if (sceneFrames <= 0) throw new Error(`Scene ${index + 1} is shorter than one output frame.`);
  let visualFrames = sceneFrames;
  if (scene.blackAfterLocalMs !== undefined) {
    visualFrames = framesForMilliseconds(scene.startMs + scene.blackAfterLocalMs, frameRate) - expectedStartFrame;
    visualFrames = Math.max(0, Math.min(sceneFrames, visualFrames));
  }
  const blackFrames = sceneFrames - visualFrames;
  const filters = [];
  const labels = [];
  const applyWatermark = Boolean(watermarkFile && visualFrames > 0);
  const wmInputIndex = endCard ? 2 : 1;
  if (visualFrames > 0) {
    if (frameIndexes && frameIndexes.length !== visualFrames) throw new Error(`Scene ${index + 1} retiming does not cover its visible frames.`);
    // A retiming's indexes are take frames already (planTakeSoundSync adds the in-point), so only the plain cut skips frames here.
    const takeStartFrame = takeInPointFrames(scene, frameRate);
    const picture = frameIndexes
      ? retimedTakeFilter(frameIndexes, frameRate)
      : `fps=${frameRate.expression},trim=start_frame=${takeStartFrame}:end_frame=${takeStartFrame + visualFrames}`;
    if (applyWatermark) {
      filters.push(`[0:v:0]setpts=PTS-STARTPTS,${picture},setpts=PTS-STARTPTS,format=yuv420p[clip_raw]`);
      filters.push(`[clip_raw][${wmInputIndex}:v:0]blend=c1_mode=grainmerge:eof_action=repeat,format=yuv420p[clip]`);
    } else {
      filters.push(`[0:v:0]setpts=PTS-STARTPTS,${picture},setpts=PTS-STARTPTS,format=yuv420p[clip]`);
    }
    labels.push("[clip]");
  }
  if (blackFrames > 0) {
    filters.push(`color=c=black:s=${dimensions}:r=${frameRate.expression},trim=start_frame=0:end_frame=${blackFrames},setpts=PTS-STARTPTS,format=yuv420p[black]`);
    labels.push("[black]");
  }
  // graphics lie over the finished picture (and under the end card, which never shows at the same time)
  const picture = graphicParts.length ? "[gfxbase]" : endCard ? "[base]" : "[outv]";
  if (labels.length > 1) filters.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0${picture}`);
  else filters.push(`${labels[0]}null${picture}`);
  if (graphicParts.length) {
    const laid = graphicOverlayFilters({ label: "gfxbase", parts: graphicParts, inputIndex: 1 + (endCard ? 1 : 0) + (applyWatermark ? 1 : 0), frameRate });
    filters.push(...laid.filters, `[${laid.label}]${endCard ? "null[base]" : "format=yuv420p[outv]"}`);
  }
  if (endCard) {
    if (!(endCard.fromFrame >= 0 && endCard.fromFrame < sceneFrames)) throw new Error("The end card must start on a frame inside the last scene.");
    filters.push(...endCardOverlayFilter({ fromFrame: endCard.fromFrame, frameRate }));
  }
  const encodePreset = process.env.SLOPCANNON_X264_PRESET || DEFAULT_FAST_ENCODE_PRESET;
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...(native ? ["-threads", String(NATIVE_ASSEMBLY_ENCODING_POLICY.decoderThreads), "-filter_complex_threads", String(NATIVE_ASSEMBLY_ENCODING_POLICY.filterThreads)] : []),
    ...(native ? selfContainedInputArgs("mov") : []), "-i", sourceFile,
    ...(endCard ? endCardInputArgs(endCard, frameRate) : []),
    ...(applyWatermark ? watermarkInputArgs(watermarkFile, dimensions, frameRate) : []),
    ...graphicParts.flatMap((part) => graphicInputArgs(part, frameRate)),
    "-filter_complex", filters.join(";"),
    "-map", "[outv]",
    "-an",
    "-c:v", NATIVE_ASSEMBLY_ENCODING_POLICY.videoCodec,
    "-preset", encodePreset,
    "-crf", String(NATIVE_ASSEMBLY_ENCODING_POLICY.crf),
    "-pix_fmt", NATIVE_ASSEMBLY_ENCODING_POLICY.pixelFormat,
    "-video_track_timescale", String(NATIVE_ASSEMBLY_ENCODING_POLICY.videoTrackTimescale),
    ...(native ? ["-threads", String(NATIVE_ASSEMBLY_ENCODING_POLICY.encoderThreads)] : []),
    ...(maxOutputBytes ? ["-fs", String(maxOutputBytes)] : []),
    outputFile,
  ], execution);
  if (native) {
    const probe = await probeMedia(outputFile, execution, "mov");
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    if (Number(video?.nb_frames) !== sceneFrames) throw new Error(`Scene ${index + 1} encoded the wrong number of frames.`);
    if (Math.abs(Number(video?.start_time)) > 0.000001) throw new Error(`Scene ${index + 1} did not start at PTS zero.`);
  }
}

/** Mono PCM at the take-sound analysis rate, or null when the source cannot be read for it. */
async function analysisPcm(file, format, execution) {
  const { stdout } = await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    ...(format ? selfContainedInputArgs(format) : []), "-i", file,
    "-vn", "-ac", "1", "-ar", String(TAKE_SOUND_SAMPLE_RATE), "-f", "f32le", "pipe:1",
  ], { ...execution, maxStdoutBytes: MAX_ANALYSIS_PCM_BYTES });
  const samples = new Float32Array(Math.floor(stdout.byteLength / 4));
  for (let index = 0; index < samples.length; index += 1) samples[index] = stdout.readFloatLE(index * 4);
  return samples;
}

/**
 * Measure every take's own sound against the song and plan its picture retiming. Never fails the
 * assembly: a take that cannot be measured renders exactly as delivered. A take that starts partway
 * in (`takeInPointMs`) is measured from there, where it is the song at the scene's start, and its
 * retiming indexes are take frames counted from the take's first frame.
 */
async function planTakeSoundSync({ manifest, songPath, songFormat, clipFiles, clipMetadata, frameRate, execution, native, policy }) {
  const scenes = [];
  const unverified = (scene, reason) => ({ sceneId: scene.id, verdict: "unverified", reason, ...(scene.takeInPointMs ? { inPointMs: scene.takeInPointMs } : {}) });
  if (!clipMetadata.some((clip) => clip.hasAudio)) {
    // Nothing to measure: no take carries sound.
    return { version: TAKE_SOUND_SYNC_VERSION, songMeasured: false, scenes: manifest.scenes.map((scene) => unverified(scene, "no-sound")), frameIndexes: [] };
  }
  let song = null;
  try {
    song = await analysisPcm(songPath, songFormat, execution);
  } catch {
    execution.signal?.throwIfAborted();
    return { version: TAKE_SOUND_SYNC_VERSION, songMeasured: false, scenes: manifest.scenes.map((scene) => unverified(scene, "song-unreadable")), frameIndexes: [] };
  }
  const frameIndexes = [];
  const results = await mapConcurrent(manifest.scenes, IO_CONCURRENCY, async (scene, index) => {
    const sceneFrames = framesForMilliseconds(scene.endMs, frameRate) - framesForMilliseconds(scene.startMs, frameRate);
    const visualFrames = scene.blackAfterLocalMs === undefined
      ? sceneFrames
      : Math.max(0, Math.min(sceneFrames, framesForMilliseconds(scene.startMs + scene.blackAfterLocalMs, frameRate) - framesForMilliseconds(scene.startMs, frameRate)));
    if (!clipMetadata[index].hasAudio || visualFrames <= 0) {
      return { sceneResult: unverified(scene, clipMetadata[index].hasAudio ? "no-picture" : "no-sound"), frameMap: undefined };
    }
    try {
      const inPointFrames = takeInPointFrames(scene, frameRate);
      const whole = await analysisPcm(clipFiles[index].file, native ? "mov" : undefined, execution);
      const take = inPointFrames
        ? whole.subarray(Math.min(whole.length, Math.round(inPointFrames / frameRate.rate * TAKE_SOUND_SAMPLE_RATE)))
        : whole;
      const measured = planTakeSoundRetime({ take, song, sceneStartSeconds: scene.startMs / 1000,
        sceneSeconds: visualFrames / frameRate.rate, version: policy.takeSound });
      const plan = policy.takeSoundVisibleDiscontinuity
        ? guardVisibleTakeSoundDiscontinuity(measured, visualFrames / frameRate.rate)
        : measured;
      return {
        sceneResult: {
          sceneId: scene.id,
          verdict: plan.verdict,
          ...(plan.reason ? { reason: plan.reason } : {}),
          segments: plan.segments,
          maxAbsLagMs: plan.maxAbsLagMs,
          coverage: plan.coverage,
          ...(plan.visualDiscontinuity ? { visualDiscontinuity: plan.visualDiscontinuity } : {}),
          ...(scene.takeInPointMs ? { inPointMs: scene.takeInPointMs } : {}),
        },
        frameMap: plan.verdict === "retimed"
          ? retimedFrameIndexes(plan.segments, { frames: visualFrames, frameRate: frameRate.rate,
            takeFrames: Math.max(1, Math.floor(clipMetadata[index].durationMs / 1000 * frameRate.rate) - inPointFrames) }).map((frame) => frame + inPointFrames)
          : undefined,
      };
    } catch {
      execution.signal?.throwIfAborted();
      return { sceneResult: unverified(scene, "analysis-failed"), frameMap: undefined };
    }
  });
  for (const { sceneResult, frameMap } of results) {
    scenes.push(sceneResult);
    frameIndexes.push(frameMap);
  }
  return { version: TAKE_SOUND_SYNC_VERSION, songMeasured: true, scenes, frameIndexes };
}

/**
 * The graphic parts one scene's encode lays over its picture, each written as the raw RGBA frames it needs (only while that
 * scene encodes, so the disk holds at most the parts of the scenes encoding at once).
 */
async function sceneGraphicParts(graphics, scene, index, frameRate, tempDir) {
  const startFrame = framesForMilliseconds(scene.startMs, frameRate);
  const parts = graphicPartsInScene(graphics.placements, startFrame, framesForMilliseconds(scene.endMs, frameRate));
  return Promise.all(parts.map(async (part, k) => {
    const raster = graphics.rasters[part.index];
    const file = path.join(tempDir, `graphic-${String(index + 1).padStart(4, "0")}-${k}.rgba`);
    await writeGraphicFrames(file, raster.rgba, graphics.placements[part.index], part.from, part.to);
    return { ...part, file, x: raster.x, y: raster.y, width: raster.width, height: raster.height };
  }));
}

/** Most scene encodes a native render may run at once: each already uses several encoder threads. */
const MAX_SCENE_CONCURRENCY = 4;

/**
 * Encode every scene onto the absolute grid, then join the segments by stream copy. Each scene is an
 * independent encode with identical settings, so running `sceneConcurrency` of them at once changes the
 * schedule only: every segment, and therefore the master, is byte-identical to a sequential run.
 */
async function encodeAbsoluteTimeline({ manifest, clipFiles, outputFile, dimensions, frameRate, tempDir, execution = {}, native = false, onProgress, maxOutputBytes, frameIndexes = [], sceneConcurrency = 1, endCard, watermarkFile, graphics }) {
  const timeline = buildAbsoluteTimeline(manifest, frameRate, dimensions);
  if (Buffer.byteLength(timeline.filter, "utf8") > MAX_FILTER_SCRIPT_BYTES) throw new Error("Assembly filter graph exceeds the safe size limit.");
  const total = manifest.scenes.length;
  const segmentFiles = new Array(total);
  const workers = native ? Math.max(1, Math.min(Math.trunc(sceneConcurrency) || 1, MAX_SCENE_CONCURRENCY, total)) : 1;
  // One failed scene stops its siblings before the temporary directory is removed.
  const stop = new AbortController();
  const sceneExecution = { ...execution, signal: execution.signal ? AbortSignal.any([execution.signal, stop.signal]) : stop.signal };
  let segmentBytes = 0;
  let completed = 0;
  let nextScene = 0;
  let failure;
  // Progress callbacks reach the service one at a time, in completion order.
  let reported = Promise.resolve();
  const encodeScenes = async () => {
    for (;;) {
      sceneExecution.signal.throwIfAborted();
      const index = nextScene;
      nextScene += 1;
      if (index >= total) return;
      if (maxOutputBytes && segmentBytes >= maxOutputBytes) throw new Error("Encoded segments exceed the native output budget.");
      const segmentFile = path.join(tempDir, `grid-segment-${String(index + 1).padStart(4, "0")}.mp4`);
      const graphicParts = graphics ? await sceneGraphicParts(graphics, manifest.scenes[index], index, frameRate, tempDir) : [];
      await encodeSceneOnAbsoluteGrid({
        graphicParts,
        frameIndexes: frameIndexes[index],
        // The end card is one more input to the last scene's own encode; no other scene, join or mux changes.
        endCard: endCard?.index === index ? endCard : undefined,
        watermarkFile,
        scene: manifest.scenes[index],
        index,
        sourceFile: clipFiles[index].file,
        outputFile: segmentFile,
        dimensions,
        frameRate,
        execution: sceneExecution,
        native,
        maxOutputBytes: maxOutputBytes ? maxOutputBytes - segmentBytes : undefined,
      });
      await Promise.all(graphicParts.map((part) => rm(part.file, { force: true })));
      const encodedStatus = await stat(segmentFile);
      if (!encodedStatus.isFile() || encodedStatus.size === 0) throw new Error(`Scene ${index + 1} produced an empty grid segment.`);
      segmentBytes += encodedStatus.size;
      if (maxOutputBytes && segmentBytes > maxOutputBytes) throw new Error("Encoded segments exceed the native output budget.");
      segmentFiles[index] = segmentFile;
      completed += 1;
      const completedScenes = completed;
      reported = reported.then(() => onProgress?.({ phase: "encoding", completedScenes, totalScenes: total }));
      await reported;
    }
  };
  await Promise.all(Array.from({ length: workers }, () => encodeScenes().catch((error) => {
    if (failure === undefined) { failure = error; stop.abort(error); }
  })));
  if (failure !== undefined) throw failure;
  await concatGridSegments({ segmentFiles, outputFile, tempDir, manifest, frameRate, execution, native, maxOutputBytes, fastStart: false });
  return timeline;
}

/** Joins already grid-aligned segments by stream copy; no frame is re-encoded here. */
export async function concatGridSegments({ segmentFiles, outputFile, tempDir, manifest, frameRate, execution = {}, native = false, maxOutputBytes, fastStart = true }) {
  const concatFile = path.join(tempDir, "grid-segments.ffconcat");
  // The demuxer otherwise joins by each MP4's millisecond-rounded container
  // duration. Difference rounded GLOBAL microsecond endpoints so even that
  // microsecond quantization cannot accumulate across many segments.
  await writeFile(concatFile, `ffconcat version 1.0\n${segmentFiles.map((file, index) => {
    const scene = manifest.scenes[index];
    const startUs = Math.round(framesForMilliseconds(scene.startMs, frameRate) * 1_000_000 / frameRate.rate);
    const endUs = Math.round(framesForMilliseconds(scene.endMs, frameRate) * 1_000_000 / frameRate.rate);
    return `file '${file.replace(/\\/gu, "/").replace(/'/gu, "'\\''")}'\nduration ${((endUs - startUs) / 1_000_000).toFixed(6)}`;
  }).join("\n")}\n`, "utf8");
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "concat", "-safe", "0", "-i", concatFile,
    "-map", "0:v:0", "-an", "-c:v", "copy",
    ...(fastStart ? ["-movflags", "+faststart"] : []),
    ...(maxOutputBytes ? ["-fs", String(maxOutputBytes)] : []), outputFile,
  ], execution);
  if (maxOutputBytes && (await stat(outputFile)).size > maxOutputBytes) throw new Error("Joined video exceeds the native output budget.");
  // Source files remain intact. These temporary encoded segments are redundant
  // after the stream-copy join, and releasing them bounds peak disk use.
  if (native) await Promise.all(segmentFiles.map((file) => rm(file)));
}

export async function muxMaster({ videoFile, songPath, songFormat, outputFile, durationMs, execution = {}, native = false, maxOutputBytes, watermark, sourceAudioDurationMs }) {
  const wmAudioArgs = watermark?.audioFile && Number.isFinite(sourceAudioDurationMs) && sourceAudioDurationMs > 0
    ? ["-stream_loop", "-1", "-t", (sourceAudioDurationMs / 1000).toFixed(3), ...(native ? selfContainedInputArgs("wav") : ["-f", "wav"]), "-i", watermark.audioFile]
    : [];
  const audioFilter = wmAudioArgs.length
    ? "[1:a:0]asetpts=PTS-STARTPTS[maina];[2:a:0]asetpts=PTS-STARTPTS[wma];[maina][wma]amix=inputs=2:duration=first:dropout_transition=0:weights=1 0.008:normalize=0,asetpts=PTS-STARTPTS[a]"
    : "[1:a:0]asetpts=PTS-STARTPTS[a]";
  const metadataArgs = watermark?.metadataComment
    ? ["-metadata", `comment=${watermark.metadataComment}`, "-metadata", "artist=SLOPCANNON"]
    : [];
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...(native ? selfContainedInputArgs("mov") : []), "-i", videoFile,
    ...(native ? selfContainedInputArgs(songFormat) : []), "-i", songPath,
    ...wmAudioArgs,
    "-filter_complex", audioFilter,
    "-map", "0:v:0", "-map", "[a]",
    ...metadataArgs,
    ...(native ? [] : ["-t", seconds(durationMs)]),
    "-c:v", "copy",
    "-c:a", NATIVE_ASSEMBLY_ENCODING_POLICY.audioCodec, "-b:a", String(NATIVE_ASSEMBLY_ENCODING_POLICY.audioBitrate),
    "-movflags", "+faststart",
    ...(maxOutputBytes ? ["-fs", String(maxOutputBytes)] : []),
    outputFile,
  ], execution);
}

/** Verification decodes the whole master once. `decoderThreads` changes how fast, never what the check decides. */
export async function validateOutput({ outputFile, manifest, expectedDimensions, expectedFrameRate, execution = {}, native = false, expectedFrames, sourceAudioDurationMs, decoderThreads = NATIVE_ASSEMBLY_ENCODING_POLICY.decoderThreads }) {
  // The immutable plan owns the picture clock. The independently decoded,
  // checksum-verified master owns the complete audio clock; it is never cut
  // merely because browser metadata rounded its duration differently, and it
  // is never taken from a container header that may only estimate it.
  if (native && (!Number.isSafeInteger(sourceAudioDurationMs) || sourceAudioDurationMs <= 0 ||
      Math.abs(sourceAudioDurationMs - manifest.durationMs) > SOURCE_DURATION_TOLERANCE_MS)) {
    throw new Error("Native output verification requires the validated source audio duration.");
  }
  const probe = await probeMedia(outputFile, execution, native ? "mov" : undefined);
  const videos = probe.streams.filter((stream) => stream.codec_type === "video");
  const audios = probe.streams.filter((stream) => stream.codec_type === "audio");
  if (videos.length !== 1 || audios.length !== 1) throw new Error("Final MP4 must contain exactly one video and one audio stream.");
  const video = videos[0];
  const audio = audios[0];
  if (`${video.width}x${video.height}` !== expectedDimensions) throw new Error("Final MP4 dimensions do not match the scene clips.");
  const outputRate = parseFrameRate(video.r_frame_rate) ?? parseFrameRate(video.avg_frame_rate);
  if (!outputRate || Math.abs(outputRate.rate - expectedFrameRate.rate) > 0.001) throw new Error("Final MP4 frame rate is not deterministic.");
  const formatDuration = finiteNumber(probe.format?.duration);
  const videoDuration = durationFromProbe(probe, video);
  const audioDuration = durationFromProbe(probe, audio);
  if (!(formatDuration > 0) || !(videoDuration > 0) || !(audioDuration > 0)) throw new Error("Final MP4 stream durations could not be decoded.");
  const durationDeltaMs = Math.round(formatDuration * 1000) - manifest.durationMs;
  const videoDurationDeltaMs = Math.round(videoDuration * 1000) - manifest.durationMs;
  const audioDurationDeltaMs = Math.round(audioDuration * 1000) - manifest.durationMs;
  const expectedContainerDurationMs = native
    ? Math.max(sourceAudioDurationMs, Math.round(expectedFrames / expectedFrameRate.rate * 1000))
    : manifest.durationMs;
  const containerDurationDeltaMs = Math.round(formatDuration * 1000) - expectedContainerDurationMs;
  const audioSourceDurationDeltaMs = Math.round(audioDuration * 1000) - (native ? sourceAudioDurationMs : manifest.durationMs);
  const frameToleranceMs = Math.ceil(1000 / expectedFrameRate.rate) + 2;
  if (Math.abs(containerDurationDeltaMs) > FINAL_DURATION_TOLERANCE_MS) throw new Error(`Final MP4 duration differs from the ${native ? "source audio and absolute picture timeline" : "manifest"} by ${containerDurationDeltaMs} ms.`);
  if (Math.abs(videoDurationDeltaMs) > frameToleranceMs) throw new Error(`Final video stream duration differs from the manifest by ${videoDurationDeltaMs} ms.`);
  if (Math.abs(audioSourceDurationDeltaMs) > FINAL_DURATION_TOLERANCE_MS) throw new Error(`Final audio stream duration differs from the ${native ? "original master audio" : "manifest"} by ${audioSourceDurationDeltaMs} ms.`);
  const videoStartMs = Math.round((finiteNumber(video.start_time) ?? 0) * 1000);
  const audioStartMs = Math.round((finiteNumber(audio.start_time) ?? 0) * 1000);
  if (Math.abs(videoStartMs) > frameToleranceMs) throw new Error(`Final video starts ${videoStartMs} ms from PTS zero.`);
  if (Math.abs(audioStartMs) > FINAL_DURATION_TOLERANCE_MS) throw new Error(`Final audio starts ${audioStartMs} ms from PTS zero.`);
  if (native && Number(video.nb_frames) !== expectedFrames) throw new Error("Final video frame count differs from the absolute timeline.");
  if (native && (video.codec_name !== "h264" || audio.codec_name !== "aac")) throw new Error("Final codecs do not match the immutable encoding policy.");
  if (native && (!Number.isFinite(Number(video.start_time)) || Math.abs(Number(video.start_time)) > 0.000001)) throw new Error("Final video did not start at PTS zero.");
  const decoded = await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin",
    ...(native ? ["-threads", String(decoderThreads), "-progress", "pipe:1", "-nostats"] : []),
    ...(native ? selfContainedInputArgs("mov") : []), "-i", outputFile,
    "-map", "0:v:0", "-map", "0:a:0",
    ...(native ? ["-vsync", "0"] : []), "-f", "null", "-",
  ], { ...execution, maxStdoutBytes: native ? MAX_TOOL_OUTPUT_BYTES : 1024 });
  let decodedFrameCount;
  if (native) {
    const counts = [...decoded.stdout.toString("utf8").matchAll(/^frame=(\d+)\s*$/gm)];
    decodedFrameCount = Number(counts.at(-1)?.[1]);
    if (decodedFrameCount !== expectedFrames) throw new Error("Decoded video frame count differs from the absolute timeline.");
    await verifyMp4FastStart(outputFile);
  }
  const presentationClock = native ? await verifyPresentationClock(outputFile, expectedFrames, expectedFrameRate, execution) : {};
  return {
    durationMs: Math.round(formatDuration * 1000),
    durationDeltaMs,
    videoDurationDeltaMs,
    audioDurationDeltaMs,
    videoStartMs,
    audioStartMs,
    dimensions: expectedDimensions,
    frameRate: expectedFrameRate.expression,
    ...(native ? {
      durationVerificationVersion: 2,
      sourceAudioDurationMs,
      audioDurationMs: Math.round(audioDuration * 1000),
      videoDurationMs: Math.round(videoDuration * 1000),
      expectedContainerDurationMs,
      containerDurationDeltaMs,
      audioSourceDurationDeltaMs,
      decodedFrameCount, frameCountVerified: true, fastStartVerified: true,
    } : {}),
    ...presentationClock,
  };
}

export async function verifyPresentationClock(file, expectedFrames, frameRate, execution) {
  const { stdout } = await runMediaTool("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_packets",
    "-show_entries", "packet=pts_time", "-of", "csv=p=0", ...selfContainedInputArgs("mov"), file,
  ], execution);
  const lines = stdout.toString("utf8").trim().split(/\r?\n/);
  if (lines.length !== expectedFrames || lines.some((line) => !/^-?\d+(?:\.\d+)?$/.test(line))) {
    throw new Error("Final presentation timestamps are missing or malformed.");
  }
  const timestamps = lines.map(Number).sort((left, right) => left - right);
  let maxError = 0;
  for (let index = 0; index < timestamps.length; index += 1) {
    if (index > 0 && timestamps[index] <= timestamps[index - 1]) throw new Error("Final presentation timestamps repeat or go backwards.");
    maxError = Math.max(maxError, Math.abs(timestamps[index] - index / frameRate.rate));
  }
  // Two 90 kHz ticks plus ffprobe's printed-microsecond precision. This bounds
  // muxer rescaling, not the much larger per-scene frame-rounding error.
  if (maxError > 2 / NATIVE_ASSEMBLY_ENCODING_POLICY.videoTrackTimescale + 0.000001) {
    throw new Error("Final presentation timestamps drift from the absolute frame clock.");
  }
  return { presentationClockVerified: true, maxPresentationTimestampErrorUs: Math.round(maxError * 1_000_000) };
}

export async function verifyMp4FastStart(file) {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    let offset = 0;
    let sawMoov = false;
    for (let count = 0; offset < size && count < 4096; count += 1) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) throw new Error("Final MP4 has a truncated box.");
      const type = header.toString("ascii", 4, 8);
      let length = header.readUInt32BE(0);
      const headerLength = length === 1 ? 16 : 8;
      if (length === 1) {
        if (bytesRead < 16) throw new Error("Final MP4 has a truncated extended box.");
        length = Number(header.readBigUInt64BE(8));
      } else if (length === 0) length = size - offset;
      if (!Number.isSafeInteger(length) || length < headerLength || offset + length > size) throw new Error("Final MP4 has an invalid box length.");
      if (type === "moov") sawMoov = true;
      if (type === "mdat") {
        if (!sawMoov) throw new Error("Final MP4 is not ready for fast-start playback.");
        return;
      }
      offset += length;
    }
    throw new Error("Final MP4 is missing bounded movie metadata.");
  } finally { await handle.close(); }
}

async function ensureNewOutput(outputPath) {
  if (path.extname(outputPath).toLocaleLowerCase("en-US") !== ".mp4") throw new Error("--output must end in .mp4.");
  await ensureAbsent(outputPath, "--output already exists; refusing to overwrite it.");
  await mkdir(path.dirname(outputPath), { recursive: true });
}

async function ensureAbsent(candidate, message) {
  try {
    await access(candidate);
    throw new Error(message);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function syncReportPath(outputPath) {
  return `${outputPath}.sync-report.json`;
}

export async function assembleMaster(options) {
  const execution = options.execution ?? {};
  const native = options.nativeVerification === true;
  // Scheduling only: a service may run scene encodes side by side and decode the master with more threads
  // to finish a long cut inside its deadline. Neither changes a byte of the output or what verification decides.
  const sceneConcurrency = native && Number.isInteger(options.sceneConcurrency) && options.sceneConcurrency > 0 ? options.sceneConcurrency : 1;
  const verifyDecoderThreads = native && Number.isInteger(options.verifyDecoderThreads) && options.verifyDecoderThreads > 0 ? options.verifyDecoderThreads : undefined;
  execution.signal?.throwIfAborted();
  const origin = normalizeOrigin(options.origin);
  const manifest = await readAndValidateManifest(options.manifestPath);
  await ensureNewOutput(options.outputPath);
  await ensureAbsent(syncReportPath(options.outputPath), "Sync report already exists; refusing to overwrite it.");
  const tempDir = await mkdtemp(path.join(path.dirname(options.outputPath), ".slopcannon-assemble-"));
  try {
    const { results: clipFiles, remoteFetchCount } = await resolveClipFiles(manifest, options.clipsDir, origin, tempDir, options.preverifiedHashes === true);
    await options.onProgress?.({ phase: "validating", completedScenes: 0, totalScenes: manifest.scenes.length });
    // Native renders follow their accepted policy; the local CLI applies the current one (v5), the one that can start a take partway in
    // when a scene asks (v6), those two with the end card when the last scene carries one (v7, v8), and with graphics (v9, v10).
    const usesTakeInPoint = manifest.scenes.some((scene) => scene.takeInPointMs !== undefined);
    const endCardEntry = manifestEndCard(manifest);
    const policy = native
      ? NATIVE_ASSEMBLY_ENCODING_POLICIES[options.nativeIdentity?.encodingPolicyVersion ?? NATIVE_ASSEMBLY_ENCODING_POLICY_V1.version]
      : manifest.graphics ? (usesTakeInPoint ? NATIVE_ASSEMBLY_ENCODING_POLICY_V10 : NATIVE_ASSEMBLY_ENCODING_POLICY_V9)
      : endCardEntry ? (usesTakeInPoint ? NATIVE_ASSEMBLY_ENCODING_POLICY_V8 : NATIVE_ASSEMBLY_ENCODING_POLICY_V7)
      : usesTakeInPoint ? NATIVE_ASSEMBLY_ENCODING_POLICY_V6 : NATIVE_ASSEMBLY_ENCODING_POLICY_V5;
    if (!policy) throw new Error("Unknown native encoding policy.");
    if (usesTakeInPoint && !policy.takeInPoint) throw new Error("This cut starts a take partway in, which the accepted encoding policy does not render.");
    if (endCardEntry && !policy.endCard) throw new Error("This cut has an end card, which the accepted encoding policy does not draw.");
    if (manifest.graphics && !policy.graphics) throw new Error("This cut has on-screen graphics, which the accepted encoding policy does not draw.");
    if (manifest.graphics && typeof options.drawGraphics !== "function") throw new Error("This cut has on-screen graphics, which only the server renderer draws.");
    const endCardSource = endCardEntry ? await resolveEndCardFile(endCardEntry.card, options.clipsDir) : null;
    const input = await validateInputs({
      manifest,
      songPath: options.songPath,
      clipFiles,
      execution,
      native,
      preverifiedSongHash: options.preverifiedSongHash,
    });
    // The card is read and checked against the film's frame size before any take is measured or encoded: never scaled, never dropped.
    let endCard;
    if (endCardEntry) {
      const { width, height, rgba } = decodeEndCardPng(await readFile(endCardSource.file), { width: input.width, height: input.height });
      const sceneStartFrame = framesForMilliseconds(endCardEntry.scene.startMs, input.frameRate);
      const placement = endCardPlacement({ sceneStartMs: endCardEntry.scene.startMs, sceneEndMs: endCardEntry.scene.endMs, fromLocalMs: endCardEntry.card.fromLocalMs, sceneStartFrame,
        sceneFrames: framesForMilliseconds(endCardEntry.scene.endMs, input.frameRate) - sceneStartFrame, frameRate: input.frameRate });
      const file = path.join(tempDir, "end-card.rgba");
      await writeEndCardFadeFrames(file, rgba, placement.fadeInFrames);
      endCard = { index: endCardEntry.index, file, width, height, ...placement, sceneId: endCardEntry.scene.id,
        fromLocalMs: endCardEntry.card.fromLocalMs, imageSha256: endCardSource.sha256 };
    }
    // The graphics are drawn at the film's real size, and placed on its frame grid, before any take is measured or encoded:
    // one the renderer cannot draw inside the safe area refuses the film here (the app assembles it again without them).
    let graphics;
    if (manifest.graphics) {
      const rasters = await options.drawGraphics(manifest.graphics, { width: input.width, height: input.height });
      if (!Array.isArray(rasters) || rasters.length !== manifest.graphics.events.length) throw new Error("The graphics renderer returned the wrong number of graphics.");
      rasters.forEach((raster) => {
        if (!(Number.isSafeInteger(raster.x) && Number.isSafeInteger(raster.y) && raster.x >= 0 && raster.y >= 0 && raster.width >= 2 && raster.height >= 2
          && raster.width % 2 === 0 && raster.height % 2 === 0 && raster.x % 2 === 0 && raster.y % 2 === 0
          && raster.x + raster.width <= input.width && raster.y + raster.height <= input.height && raster.rgba?.length === raster.width * raster.height * 4)) {
          throw new Error("The graphics renderer returned a plate outside the frame.");
        }
      });
      const placements = manifest.graphics.events.map((event) => graphicPlacement(event, input.frameRate, policy.graphicsFadeMs));
      graphics = { rasters, placements, proof: placements.map((placement, index) => ({ ...placement,
        box: [rasters[index].x, rasters[index].y, rasters[index].width, rasters[index].height],
        rgbaSha256: createHash("sha256").update(rasters[index].rgba).digest("hex") })) };
    }
    const songFormat = native ? nativeAudioInputFormat(manifest.masterAudio.filename) : undefined;
    const takeSound = policy.takeSound
      ? await planTakeSoundSync({ manifest, songPath: options.songPath, songFormat, clipFiles, clipMetadata: input.clipMetadata, frameRate: input.frameRate, execution, native, policy })
      : null;
    const visibleTimingBreaks = takeSound?.scenes.filter((scene) => scene.reason === "visible-discontinuity") ?? [];
    const unsupportedTimingBreaks = takeSound?.scenes.filter((scene) => scene.reason === "offset-too-large" && scene.coverage >= TAKE_SOUND_UNSUPPORTED_COVERAGE) ?? [];
    // A take started partway in is a claim that its sound is the song at the scene's start: measured evidence against it refuses the cut.
    const unfitTakes = takeSound?.scenes.filter((scene) => scene.inPointMs && takeSoundContradictsInPoint(scene)) ?? [];
    if (unfitTakes.length) {
      const sceneNumbers = unfitTakes.map((scene) => scene.sceneId).join(", ");
      throw new Error(`Selected take does not fit scene${unfitTakes.length > 1 ? "s" : ""} ${sceneNumbers}. Its sound does not match the song where the scene starts, so its picture would be misaligned. Reroll ${unfitTakes.length > 1 ? "those scenes" : "that scene"} before assembly.`);
    }
    if (native && policy.takeSoundVisibleDiscontinuity === "reject-v1" && (visibleTimingBreaks.length || unsupportedTimingBreaks.length)) {
      const sceneNumbers = [...visibleTimingBreaks, ...unsupportedTimingBreaks].map((scene) => scene.sceneId).join(", ");
      throw new Error(`Selected take timing is damaged in scene${sceneNumbers.includes(",") ? "s" : ""} ${sceneNumbers}. Reroll ${sceneNumbers.includes(",") ? "those scenes" : "that scene"} before server assembly; automatic repair would create a visible freeze or jump.`);
    }
    // Embed the invisible provenance watermark on every assembled film unless explicitly disabled.
    // Master audio stays bit-exact (`[1:a:0]asetpts=PTS-STARTPTS[a]`) unless `options.audioWatermark === true`,
    // so audio alignment and soundtrack fidelity are never perturbed.
    const enableWatermark = options.provenanceWatermark !== false;
    let watermark = null;
    if (enableWatermark) {
      const derived = deriveProvenanceWatermark(manifest);
      const videoWmFile = path.join(tempDir, "provenance-wm.yuv");
      await writeFile(videoWmFile, buildVideoWatermarkYuv420p(input.width, input.height, derived.quadGrid), { flag: "wx" });
      let audioWmFile = null;
      if (options.audioWatermark === true) {
        audioWmFile = path.join(tempDir, "provenance-wm.wav");
        await writeFile(audioWmFile, buildAudioWatermarkWav8k(derived.bits), { flag: "wx" });
      }
      watermark = { ...derived, videoFile: videoWmFile, audioFile: audioWmFile };
    }
    const videoFile = path.join(tempDir, "absolute-timeline.mp4");
    const timeline = await encodeAbsoluteTimeline({
      frameIndexes: takeSound?.frameIndexes ?? [],
      manifest,
      clipFiles,
      outputFile: videoFile,
      dimensions: input.dimensions,
      frameRate: input.frameRate,
      tempDir,
      execution,
      native,
      onProgress: options.onProgress,
      maxOutputBytes: options.maxOutputBytes,
      sceneConcurrency,
      endCard,
      watermarkFile: watermark?.videoFile,
      graphics,
    });
    if (endCard) await rm(endCard.file, { force: true });
    if (watermark?.videoFile) await rm(watermark.videoFile, { force: true });
    const encodedStatus = await stat(videoFile);
    if (!encodedStatus.isFile() || encodedStatus.size === 0) throw new Error("Absolute video timeline is empty.");
    const candidateOutput = path.join(tempDir, "assembled.mp4");
    await options.onProgress?.({ phase: "muxing", completedScenes: manifest.scenes.length, totalScenes: manifest.scenes.length });
    await muxMaster({
      videoFile,
      songPath: options.songPath,
      songFormat: native ? nativeAudioInputFormat(manifest.masterAudio.filename) : undefined,
      outputFile: candidateOutput,
      durationMs: manifest.durationMs,
      execution,
      native,
      maxOutputBytes: options.maxOutputBytes,
      watermark,
      sourceAudioDurationMs: input.sourceAudioDurationMs,
    });
    if (watermark?.audioFile) await rm(watermark.audioFile, { force: true });
    // The muxed candidate holds the same picture; releasing the joined video lowers disk use during verification and upload
    // (the working peak is at the join or the mux, about twice the video).
    if (native) await rm(videoFile, { force: true });
    if (options.maxOutputBytes && (await stat(candidateOutput)).size > options.maxOutputBytes) throw new Error("Final MP4 exceeds the native output limit.");
    await options.onProgress?.({ phase: "verifying", completedScenes: manifest.scenes.length, totalScenes: manifest.scenes.length });
    const output = await validateOutput({
      outputFile: candidateOutput,
      manifest,
      expectedDimensions: input.dimensions,
      expectedFrameRate: input.frameRate,
      expectedFrames: timeline.outputFrames,
      sourceAudioDurationMs: input.sourceAudioDurationMs,
      execution,
      native,
      decoderThreads: verifyDecoderThreads,
    });
    const report = {
      ok: true,
      schemaVersion: 1,
      output: path.basename(options.outputPath),
      sceneCount: manifest.scenes.length,
      manifestDurationMs: manifest.durationMs,
      masterAudioSha256Verified: Boolean(manifest.masterAudio.sha256),
      sourceDurationDeltaMs: input.sourceDurationDeltaMs,
      remoteFetchCount,
      totalRequestedMs: manifest.scenes.reduce((total, scene) => total + scene.requestSeconds * 1000, 0),
      discardedRequestPaddingMs: manifest.scenes.reduce((total, scene) => total + scene.requestSeconds * 1000 - (scene.endMs - scene.startMs), 0),
      frameBoundaryReport: timeline.boundaries,
      maxAbsoluteBoundaryDeltaMs: Math.max(...timeline.boundaries.flatMap((boundary) => [Math.abs(boundary.startDeltaMs), Math.abs(boundary.endDeltaMs)])),
      sourceFrameRates: input.sourceFrameRates,
      sourceFrameRatesNormalized: input.sourceFrameRates.some((rate) => rate !== input.frameRate.expression),
      ...output,
      generatedClipAudioDiscarded: true,
      fullDecodeVerified: true,
      ...(takeSound ? {
        takeSoundSync: {
          version: takeSound.version,
          songMeasured: takeSound.songMeasured,
          retimedScenes: takeSound.scenes.filter((scene) => scene.verdict === "retimed").length,
          scenes: takeSound.scenes,
        },
      } : {}),
      ...(usesTakeInPoint ? {
        takeInPoints: manifest.scenes.flatMap((scene) => scene.takeInPointMs === undefined ? []
          : [{ sceneId: scene.id, takeInPointMs: scene.takeInPointMs, takeInPointFrames: takeInPointFrames(scene, input.frameRate) }]),
      } : {}),
      ...(endCard ? {
        endCard: { sceneId: endCard.sceneId, fromLocalMs: endCard.fromLocalMs, fromFrame: endCard.fromFrame, frames: endCard.frames,
          fadeInFrames: endCard.fadeInFrames, dimensions: `${endCard.width}x${endCard.height}`, imageSha256: endCard.imageSha256 },
      } : {}),
      ...(graphics ? { graphics: graphics.proof } : {}),
      ...(watermark ? {
        provenanceWatermark: {
          version: watermark.version,
          hex: watermark.hex,
          tag: watermark.tag,
          crc16: watermark.crc16,
          layers: watermark.audioFile
            ? ["container-metadata", "video-luma-dsss", "audio-dsss"]
            : ["container-metadata", "video-luma-dsss"],
        },
      } : {}),
      ...(native ? options.nativeIdentity : {}),
    };
    const candidateReport = path.join(tempDir, "sync-report.json");
    await writeFile(candidateReport, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    execution.signal?.throwIfAborted();
    await link(candidateOutput, options.outputPath);
    try {
      await link(candidateReport, syncReportPath(options.outputPath));
    } catch (error) {
      await rm(options.outputPath, { force: true });
      throw error;
    }
    return report;
  } finally {
    const canonicalTemp = path.resolve(tempDir);
    const expectedParent = path.resolve(path.dirname(options.outputPath));
    if (path.dirname(canonicalTemp) === expectedParent && path.basename(canonicalTemp).startsWith(".slopcannon-assemble-")) {
      await rm(canonicalTemp, { recursive: true, force: true });
    }
  }
}

async function main() {
  try {
    const result = await assembleMaster(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message.slice(0, MAX_ERROR_TEXT) })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) await main();
