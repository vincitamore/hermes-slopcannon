#!/usr/bin/env node

import {
  access,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  probeMedia,
  readAndValidateManifest,
  runMediaTool,
  sha256File,
} from "./assemble-master.mjs";

const SAMPLE_RATE = 48_000;
const BITS_PER_SAMPLE = 16;
const SOURCE_DURATION_TOLERANCE_MS = 250;
const MAX_ERROR_TEXT = 2_000;

/**
 * The hosted scene-audio recipe. A generation accepts one complete source
 * asset per scene under a hard byte cap, so the hosted slice is mono at
 * 24 kHz: fifteen seconds of it is 720044 bytes, inside the cap with room to
 * spare, and the provider hears the same performance the master carries.
 */
export const SCENE_AUDIO_SAMPLE_RATE = 24_000;
export const SCENE_AUDIO_CHANNELS = 1;
export const SCENE_AUDIO_MAX_BYTES = 786_432;
export const SCENE_AUDIO_MIN_REQUEST_SECONDS = 5;
export const SCENE_AUDIO_MAX_REQUEST_SECONDS = 15;
const WAV_HEADER_BYTES = 44;

function usage() {
  return [
    "Usage:",
    "  node prepare-scene-audio.mjs --manifest <manifest.json> --song <master.mp3|wav>",
    "    --output-dir <new-directory>",
  ].join("\n");
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(usage());
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set(["--manifest", "--song", "--output-dir"]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}\n${usage()}`);
  for (const flag of allowed) if (!values.get(flag)) throw new Error(`Missing ${flag}.\n${usage()}`);
  return {
    manifestPath: path.resolve(values.get("--manifest")),
    songPath: path.resolve(values.get("--song")),
    outputDir: path.resolve(values.get("--output-dir")),
  };
}

function finiteNumber(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mediaDuration(probe, stream) {
  return finiteNumber(stream?.duration) ?? finiteNumber(probe?.format?.duration);
}

function wavHeader({ channels, dataBytes, sampleRate = SAMPLE_RATE }) {
  if (!Number.isSafeInteger(channels) || channels <= 0 || channels > 32) throw new Error("Master audio channel count is unsupported.");
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes > 0xffffffff - 36) {
    throw new Error("One prepared scene exceeds the PCM WAV size limit.");
  }
  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function readExactly(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, position + offset);
    if (bytesRead === 0) throw new Error("Decoded master PCM ended before a scene boundary.");
    offset += bytesRead;
  }
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (!result.bytesWritten) throw new Error("Prepared audio write made no progress.");
    offset += result.bytesWritten;
  }
}

export async function writePreparedWav({ decodedFile, outputFile, channels, startSample, activeSamples, requestSamples, sampleRate = SAMPLE_RATE }) {
  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const activeBytes = activeSamples * blockAlign;
  const totalBytes = requestSamples * blockAlign;
  const source = await open(decodedFile, "r");
  const destination = await open(outputFile, "wx");
  try {
    await writeAll(destination, wavHeader({ channels, dataBytes: totalBytes, sampleRate }));
    const chunk = Buffer.alloc(Math.min(activeBytes, 1024 * 1024));
    let copied = 0;
    while (copied < activeBytes) {
      const length = Math.min(chunk.byteLength, activeBytes - copied);
      const view = chunk.subarray(0, length);
      await readExactly(source, view, startSample * blockAlign + copied);
      await writeAll(destination, view);
      copied += length;
    }
    const silence = Buffer.alloc(Math.min(Math.max(totalBytes - activeBytes, 1), 1024 * 1024));
    let padded = activeBytes;
    while (padded < totalBytes) {
      const length = Math.min(silence.byteLength, totalBytes - padded);
      await writeAll(destination, silence.subarray(0, length));
      padded += length;
    }
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
}

async function ensureNewDirectory(outputDir) {
  try {
    await access(outputDir);
    throw new Error("--output-dir already exists; refusing to overwrite it.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(outputDir), { recursive: true });
}

function preparedFilename(clipFilename) {
  const extension = path.extname(clipFilename);
  return `${extension ? clipFilename.slice(0, -extension.length) : clipFilename}.audio.wav`;
}

export async function prepareSceneAudio(options) {
  const manifest = await readAndValidateManifest(options.manifestPath);
  await ensureNewDirectory(options.outputDir);
  const songStatus = await stat(options.songPath);
  if (!songStatus.isFile() || songStatus.size === 0) throw new Error("--song must be a non-empty file.");
  const songHash = await sha256File(options.songPath);
  if (manifest.masterAudio.sha256 && songHash !== manifest.masterAudio.sha256.toLowerCase()) {
    throw new Error("Master audio SHA-256 does not match the manifest.");
  }
  const probe = await probeMedia(options.songPath);
  const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio");
  if (audioStreams.length !== 1) throw new Error("Master audio must contain exactly one audio stream.");
  const sourceChannels = audioStreams[0].channels;
  if (!Number.isSafeInteger(sourceChannels) || sourceChannels <= 0 || sourceChannels > 32) throw new Error("Master audio channel count is unsupported.");
  const channels = Math.min(2, sourceChannels);
  const duration = mediaDuration(probe, audioStreams[0]);
  if (!(duration > 0)) throw new Error("Master audio duration could not be decoded.");
  const sourceDurationDeltaMs = Math.round(duration * 1000) - manifest.durationMs;
  if (Math.abs(sourceDurationDeltaMs) > SOURCE_DURATION_TOLERANCE_MS) {
    throw new Error(`Master audio duration differs from manifest duration by ${sourceDurationDeltaMs} ms.`);
  }

  const tempRoot = await mkdtemp(path.join(path.dirname(options.outputDir), ".slopcannon-audio-"));
  const stagingDir = path.join(tempRoot, "prepared");
  const decodedFile = path.join(tempRoot, "master-48000-s16le.pcm");
  try {
    await mkdir(stagingDir);
    await runMediaTool("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", options.songPath,
      "-map", "0:a:0", "-vn",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(channels),
      "-c:a", "pcm_s16le",
      "-f", "s16le",
      decodedFile,
    ]);
    const decodedStatus = await stat(decodedFile);
    const blockAlign = channels * (BITS_PER_SAMPLE / 8);
    if (!decodedStatus.isFile() || decodedStatus.size % blockAlign !== 0) throw new Error("Decoded master PCM is incomplete.");
    const decodedSamples = decodedStatus.size / blockAlign;
    const requiredSamples = manifest.durationMs * (SAMPLE_RATE / 1000);
    if (decodedSamples < requiredSamples) {
      throw new Error(`Decoded master PCM is ${requiredSamples - decodedSamples} samples shorter than the manifest timeline.`);
    }

    const files = [];
    for (const scene of manifest.scenes) {
      const filename = preparedFilename(scene.clip.filename);
      const startSample = scene.startMs * (SAMPLE_RATE / 1000);
      const activeSamples = (scene.endMs - scene.startMs) * (SAMPLE_RATE / 1000);
      const requestSamples = scene.requestSeconds * SAMPLE_RATE;
      await writePreparedWav({
        decodedFile,
        outputFile: path.join(stagingDir, filename),
        channels,
        startSample,
        activeSamples,
        requestSamples,
      });
      files.push({
        sceneId: scene.id,
        filename,
        startSample,
        activeSamples,
        silencePaddingSamples: requestSamples - activeSamples,
        totalSamples: requestSamples,
      });
    }
    await unlink(decodedFile);
    await rename(stagingDir, options.outputDir);
    return {
      ok: true,
      schemaVersion: 1,
      outputDirectory: path.basename(options.outputDir),
      sceneCount: manifest.scenes.length,
      sampleRate: SAMPLE_RATE,
      sourceChannels,
      channels,
      bitsPerSample: BITS_PER_SAMPLE,
      decodedMasterOnce: true,
      masterAudioSha256Verified: Boolean(manifest.masterAudio.sha256),
      sourceDurationDeltaMs,
      files,
    };
  } finally {
    const canonicalTemp = path.resolve(tempRoot);
    const expectedParent = path.resolve(path.dirname(options.outputDir));
    if (path.dirname(canonicalTemp) === expectedParent && path.basename(canonicalTemp).startsWith(".slopcannon-audio-")) {
      await rm(canonicalTemp, { recursive: true, force: true });
    }
  }
}

function sceneSliceFilename(index) {
  return `scene-${String(index + 1).padStart(4, "0")}.wav`;
}

function validateSlicePlan(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error("scenes must be a non-empty array.");
  let cursor = 0;
  return scenes.map((scene, index) => {
    const label = `scenes[${index}]`;
    if (!scene || typeof scene !== "object") throw new Error(`${label} must be an object.`);
    const { id, startMs, endMs, requestSeconds } = scene;
    if (!Number.isSafeInteger(id) || id < 0 || id > 100_000) throw new Error(`${label}.id must be a whole number from 0 through 100000.`);
    if (!Number.isSafeInteger(startMs) || startMs !== cursor) throw new Error(`${label}.startMs must equal ${cursor}; scene audio is contiguous from 0.`);
    if (!Number.isSafeInteger(endMs) || endMs <= startMs) throw new Error(`${label}.endMs must be a whole number after startMs.`);
    const durationMs = endMs - startMs;
    if (durationMs < 5_000 || durationMs > 15_000) throw new Error(`${label} must be 5000-15000 ms long.`);
    const seconds = requestSeconds ?? Math.ceil(durationMs / 1_000);
    if (!Number.isSafeInteger(seconds) || seconds < SCENE_AUDIO_MIN_REQUEST_SECONDS || seconds > SCENE_AUDIO_MAX_REQUEST_SECONDS) {
      throw new Error(`${label}.requestSeconds must be a whole number from ${SCENE_AUDIO_MIN_REQUEST_SECONDS} through ${SCENE_AUDIO_MAX_REQUEST_SECONDS}.`);
    }
    if (seconds * 1_000 < durationMs) throw new Error(`${label}.requestSeconds must cover the whole scene.`);
    cursor = endMs;
    return { id, startMs, endMs, requestSeconds: seconds };
  });
}

/**
 * Cuts the master into one complete source asset per scene at the hosted
 * recipe: mono 24 kHz 16-bit PCM WAV, zero-padded to the requested generation
 * length. The master is decoded once and every scene is an exact PCM range
 * copy out of that decode, so the slices carry the sample-accurate audio of
 * the master rather than a re-encode per scene.
 */
export async function prepareSceneAudioSlices(options) {
  const scenes = validateSlicePlan(options.scenes);
  await ensureNewDirectory(options.outputDir);
  const songStatus = await stat(options.songPath);
  if (!songStatus.isFile() || songStatus.size === 0) throw new Error("The master audio must be a non-empty file.");
  const probe = await probeMedia(options.songPath);
  const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio");
  if (audioStreams.length !== 1) throw new Error("Master audio must contain exactly one audio stream.");
  const sourceChannels = audioStreams[0].channels;
  const duration = mediaDuration(probe, audioStreams[0]);
  if (!(duration > 0)) throw new Error("Master audio duration could not be decoded.");
  const durationMs = Math.round(duration * 1_000);
  const timelineEndMs = scenes.at(-1).endMs;
  if (timelineEndMs > durationMs + SOURCE_DURATION_TOLERANCE_MS) {
    throw new Error(`The scene timeline ends at ${timelineEndMs} ms, past the ${durationMs} ms master.`);
  }

  const tempRoot = await mkdtemp(path.join(path.dirname(options.outputDir), ".slopcannon-audio-"));
  const stagingDir = path.join(tempRoot, "prepared");
  const decodedFile = path.join(tempRoot, `master-${SCENE_AUDIO_SAMPLE_RATE}-s16le.pcm`);
  try {
    await mkdir(stagingDir);
    await runMediaTool("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", options.songPath,
      "-map", "0:a:0", "-vn",
      "-ar", String(SCENE_AUDIO_SAMPLE_RATE),
      "-ac", String(SCENE_AUDIO_CHANNELS),
      "-c:a", "pcm_s16le",
      "-f", "s16le",
      decodedFile,
    ]);
    const blockAlign = SCENE_AUDIO_CHANNELS * (BITS_PER_SAMPLE / 8);
    const decodedStatus = await stat(decodedFile);
    if (!decodedStatus.isFile() || decodedStatus.size % blockAlign !== 0) throw new Error("Decoded master PCM is incomplete.");
    const decodedSamples = decodedStatus.size / blockAlign;
    const samplesPerMs = SCENE_AUDIO_SAMPLE_RATE / 1_000;

    const files = [];
    for (const [index, scene] of scenes.entries()) {
      const filename = sceneSliceFilename(index);
      const startSample = Math.round(scene.startMs * samplesPerMs);
      const requestSamples = scene.requestSeconds * SCENE_AUDIO_SAMPLE_RATE;
      const totalBytes = WAV_HEADER_BYTES + requestSamples * blockAlign;
      if (totalBytes > SCENE_AUDIO_MAX_BYTES) {
        throw new Error(`Scene ${scene.id} would be ${totalBytes} bytes, over the ${SCENE_AUDIO_MAX_BYTES} byte source-asset cap.`);
      }
      // The last scene may end on the final partial millisecond of the decode;
      // the padding that follows it is the same silence the cap already allows.
      const activeSamples = Math.max(0, Math.min(Math.round((scene.endMs - scene.startMs) * samplesPerMs), decodedSamples - startSample));
      if (activeSamples <= 0) throw new Error(`Scene ${scene.id} starts past the end of the decoded master.`);
      await writePreparedWav({
        decodedFile,
        outputFile: path.join(stagingDir, filename),
        channels: SCENE_AUDIO_CHANNELS,
        sampleRate: SCENE_AUDIO_SAMPLE_RATE,
        startSample,
        activeSamples,
        requestSamples,
      });
      files.push({
        sceneId: scene.id,
        filename,
        startMs: scene.startMs,
        endMs: scene.endMs,
        requestSeconds: scene.requestSeconds,
        durationMs: scene.endMs - scene.startMs,
        startSample,
        activeSamples,
        silencePaddingSamples: requestSamples - activeSamples,
        totalSamples: requestSamples,
      });
    }
    await unlink(decodedFile);
    await rename(stagingDir, options.outputDir);
    return {
      ok: true,
      schemaVersion: 1,
      outputDirectory: path.basename(options.outputDir),
      sceneCount: files.length,
      sampleRate: SCENE_AUDIO_SAMPLE_RATE,
      channels: SCENE_AUDIO_CHANNELS,
      sourceChannels,
      bitsPerSample: BITS_PER_SAMPLE,
      decodedMasterOnce: true,
      sourceDurationMs: durationMs,
      files,
    };
  } finally {
    const canonicalTemp = path.resolve(tempRoot);
    const expectedParent = path.resolve(path.dirname(options.outputDir));
    if (path.dirname(canonicalTemp) === expectedParent && path.basename(canonicalTemp).startsWith(".slopcannon-audio-")) {
      await rm(canonicalTemp, { recursive: true, force: true });
    }
  }
}

async function main() {
  try {
    const result = await prepareSceneAudio(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message.slice(0, MAX_ERROR_TEXT) })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) await main();
