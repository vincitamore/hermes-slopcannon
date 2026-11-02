#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMediaTool } from "./assemble-master.mjs";

export const FIXTURE_VERSION = "slopcannon-agent-sync-v1";
export const FIXTURE_SPEC = Object.freeze({
  width: 320,
  height: 180,
  frameRate: 30,
  sampleRate: 48_000,
  channels: 2,
  bitsPerSample: 16,
  sceneCount: 6,
  sceneDurationMs: 5_017,
  requestSeconds: 6,
  durationMs: 30_102,
  expectedBoundaryFrames: Object.freeze([0, 151, 301, 452, 602, 753, 903]),
});

const COLORS = Object.freeze([
  Object.freeze({ ffmpeg: "0xdc2626", rgb: Object.freeze([220, 38, 38]) }),
  Object.freeze({ ffmpeg: "0x16a34a", rgb: Object.freeze([22, 163, 74]) }),
  Object.freeze({ ffmpeg: "0x2563eb", rgb: Object.freeze([37, 99, 235]) }),
  Object.freeze({ ffmpeg: "0xeab308", rgb: Object.freeze([234, 179, 8]) }),
  Object.freeze({ ffmpeg: "0xc026d3", rgb: Object.freeze([192, 38, 211]) }),
  Object.freeze({ ffmpeg: "0x0891b2", rgb: Object.freeze([8, 145, 178]) }),
]);

const DISTRACTOR_FREQUENCIES_HZ = Object.freeze([911, 1061, 1213, 1361, 1511, 1663]);
const ASSEMBLER = fileURLToPath(new URL("./assemble-master.mjs", import.meta.url));
const PREPARER = fileURLToPath(new URL("./prepare-scene-audio.mjs", import.meta.url));
const WAV_HEADER_BYTES = 44;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const HALF_FRAME_MS = 1000 / FIXTURE_SPEC.frameRate / 2;
const AUDIO_DURATION_TOLERANCE_MS = 50;
const MAX_CLIENT_LENGTH = 80;

class FixtureFailure extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "FixtureFailure";
    this.code = code;
  }
}

function usage() {
  return [
    "Usage:",
    "  node <skill-directory>/scripts/run-sync-conformance.mjs [--client <name>] [--client-version <version>]",
    "",
    "Uses SLOPCANNON_FFMPEG_PATH / FFMPEG_PATH and SLOPCANNON_FFPROBE_PATH / FFPROBE_PATH when set.",
  ].join("\n");
}

function cleanClientValue(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CLIENT_LENGTH || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new FixtureFailure("INVALID_ARGUMENTS", `${label} must be 1-${MAX_CLIENT_LENGTH} printable characters.`);
  }
  return value;
}

export function parseFixtureArgs(argv) {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map();
  for (let index = 0; index < normalizedArgv.length; index += 2) {
    const flag = normalizedArgv[index];
    const value = normalizedArgv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new FixtureFailure("INVALID_ARGUMENTS", usage());
    }
    if (values.has(flag)) throw new FixtureFailure("INVALID_ARGUMENTS", `Duplicate option: ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set(["--client", "--client-version"]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new FixtureFailure("INVALID_ARGUMENTS", `Unknown option: ${flag}\n${usage()}`);
  }
  const client = cleanClientValue(values.get("--client"), "--client");
  const clientVersion = cleanClientValue(values.get("--client-version"), "--client-version");
  if (clientVersion && !client) throw new FixtureFailure("INVALID_ARGUMENTS", "--client-version requires --client.");
  return { client, clientVersion };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function wavHeader(dataBytes) {
  const { sampleRate, channels, bitsPerSample } = FIXTURE_SPEC;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
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
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function clampInt16(value) {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

export function createDeterministicMaster() {
  const { sampleRate, channels, durationMs } = FIXTURE_SPEC;
  const sampleFrames = durationMs * sampleRate / 1000;
  const pcm = Buffer.alloc(sampleFrames * channels * 2);
  let nonZeroSamples = 0;
  for (let frame = 0; frame < sampleFrames; frame += 1) {
    const time = frame / sampleRate;
    const envelope = 0.72 + 0.20 * Math.sin(2 * Math.PI * 0.37 * time);
    const left = clampInt16(envelope * (
      10_400 * Math.sin(2 * Math.PI * 223 * time)
      + 6_200 * Math.sin(2 * Math.PI * 331 * time + 0.31)
      + 2_800 * Math.sin(2 * Math.PI * 487 * time + 1.07)
    ));
    const right = clampInt16(envelope * (
      9_800 * Math.sin(2 * Math.PI * 277 * time + 0.17)
      + 6_500 * Math.sin(2 * Math.PI * 419 * time + 0.73)
      + 2_400 * Math.sin(2 * Math.PI * 563 * time + 1.41)
    ));
    pcm.writeInt16LE(left, frame * 4);
    pcm.writeInt16LE(right, frame * 4 + 2);
    if (left !== 0) nonZeroSamples += 1;
    if (right !== 0) nonZeroSamples += 1;
  }
  if (nonZeroSamples < sampleFrames) throw new FixtureFailure("MASTER_GENERATION_FAILED");
  const file = Buffer.concat([wavHeader(pcm.byteLength), pcm]);
  return { file, pcm, sampleFrames, nonZeroSamples, sha256: sha256(file) };
}

export function createFixtureManifest(masterSha256) {
  if (!/^[a-f0-9]{64}$/u.test(masterSha256)) throw new FixtureFailure("INVALID_MASTER_SHA");
  return {
    schemaVersion: 1,
    durationMs: FIXTURE_SPEC.durationMs,
    masterAudio: {
      filename: "rights-clean-master.wav",
      sha256: masterSha256,
    },
    scenes: Array.from({ length: FIXTURE_SPEC.sceneCount }, (_, index) => ({
      id: `fixture-scene-${index + 1}`,
      startMs: index * FIXTURE_SPEC.sceneDurationMs,
      endMs: (index + 1) * FIXTURE_SPEC.sceneDurationMs,
      requestSeconds: FIXTURE_SPEC.requestSeconds,
      clip: { filename: `fixture-scene-${index + 1}.mp4` },
    })),
  };
}

export function parsePcmWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new FixtureFailure("INVALID_WAV", "Prepared output is not a RIFF/WAVE file.");
  }
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= buffer.byteLength) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.byteLength) throw new FixtureFailure("INVALID_WAV", "Prepared WAV contains a truncated chunk.");
    if (id === "fmt " && size >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    }
    if (id === "data") data = buffer.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1) throw new FixtureFailure("INVALID_WAV", "Prepared WAV must contain integer PCM audio.");
  return { ...format, data };
}

function finiteNumber(value, label) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new FixtureFailure("INVALID_PROBE", `${label} is missing from ffprobe output.`);
  return parsed;
}

function assertCondition(condition, code, message = code) {
  if (!condition) throw new FixtureFailure(code, message);
}

function runNodeJson(script, args, stage) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    const append = (current, chunk) => {
      if (current.byteLength >= MAX_CHILD_OUTPUT_BYTES) return current;
      return Buffer.concat([current, chunk.subarray(0, MAX_CHILD_OUTPUT_BYTES - current.byteLength)]);
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      if (stdout.byteLength >= MAX_CHILD_OUTPUT_BYTES) overflow = true;
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      if (stderr.byteLength >= MAX_CHILD_OUTPUT_BYTES) overflow = true;
    });
    child.on("error", () => reject(new FixtureFailure(`${stage}_START_FAILED`)));
    child.on("close", (code) => {
      if (overflow) return reject(new FixtureFailure(`${stage}_OUTPUT_OVERFLOW`));
      if (code !== 0) return reject(new FixtureFailure(`${stage}_FAILED`));
      try {
        const parsed = JSON.parse(stdout.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || parsed.ok !== true) throw new Error();
        resolve(parsed);
      } catch {
        reject(new FixtureFailure(`${stage}_INVALID_JSON`));
      }
    });
  });
}

async function verifyMediaTools() {
  try {
    await runMediaTool("ffmpeg", ["-hide_banner", "-version"], { maxStdoutBytes: 256 * 1024 });
  } catch {
    throw new FixtureFailure("FFMPEG_UNAVAILABLE");
  }
  try {
    await runMediaTool("ffprobe", ["-hide_banner", "-version"], { maxStdoutBytes: 256 * 1024 });
  } catch {
    throw new FixtureFailure("FFPROBE_UNAVAILABLE");
  }
}

export async function mediaToolsAvailable() {
  try {
    await verifyMediaTools();
    return true;
  } catch {
    return false;
  }
}

async function generateProviderClips(clipsDir) {
  await mkdir(clipsDir);
  for (let index = 0; index < FIXTURE_SPEC.sceneCount; index += 1) {
    await runMediaTool("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", `color=c=${COLORS[index].ffmpeg}:s=${FIXTURE_SPEC.width}x${FIXTURE_SPEC.height}:r=${FIXTURE_SPEC.frameRate}:d=${FIXTURE_SPEC.requestSeconds}`,
      "-f", "lavfi", "-i", `sine=frequency=${DISTRACTOR_FREQUENCIES_HZ[index]}:sample_rate=${FIXTURE_SPEC.sampleRate}:duration=${FIXTURE_SPEC.requestSeconds}`,
      "-t", FIXTURE_SPEC.requestSeconds.toFixed(3),
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p",
      "-r", String(FIXTURE_SPEC.frameRate), "-g", String(FIXTURE_SPEC.frameRate),
      "-c:a", "aac", "-b:a", "192k", "-ac", String(FIXTURE_SPEC.channels),
      "-filter:a", "volume=7",
      "-movflags", "+faststart",
      path.join(clipsDir, `fixture-scene-${index + 1}.mp4`),
    ]);
  }
}

async function verifyPreparedAudio(preparedDir, masterPcm) {
  const blockAlign = FIXTURE_SPEC.channels * FIXTURE_SPEC.bitsPerSample / 8;
  const activeSamples = FIXTURE_SPEC.sceneDurationMs * FIXTURE_SPEC.sampleRate / 1000;
  const totalSamples = FIXTURE_SPEC.requestSeconds * FIXTURE_SPEC.sampleRate;
  const silencePaddingSamples = totalSamples - activeSamples;
  const activeDigests = [];
  const preparedDigests = [];
  for (let index = 0; index < FIXTURE_SPEC.sceneCount; index += 1) {
    const wav = parsePcmWav(await readFile(path.join(preparedDir, `fixture-scene-${index + 1}.audio.wav`)));
    assertCondition(wav.channels === FIXTURE_SPEC.channels, "PREPARED_CHANNEL_MISMATCH");
    assertCondition(wav.sampleRate === FIXTURE_SPEC.sampleRate, "PREPARED_RATE_MISMATCH");
    assertCondition(wav.bitsPerSample === FIXTURE_SPEC.bitsPerSample, "PREPARED_DEPTH_MISMATCH");
    assertCondition(wav.data.byteLength === totalSamples * blockAlign, "PREPARED_LENGTH_MISMATCH");
    const activeBytes = activeSamples * blockAlign;
    const expectedStart = index * activeSamples * blockAlign;
    const expected = masterPcm.subarray(expectedStart, expectedStart + activeBytes);
    const active = wav.data.subarray(0, activeBytes);
    assertCondition(active.equals(expected), "PREPARED_SLICE_MISMATCH");
    assertCondition(wav.data.subarray(activeBytes).every((byte) => byte === 0), "PREPARED_PADDING_NOT_SILENT");
    activeDigests.push(sha256(active));
    preparedDigests.push(sha256(wav.data));
  }
  return {
    filesVerified: FIXTURE_SPEC.sceneCount,
    exactMasterSlices: true,
    silentPadding: true,
    activeSamplesPerScene: activeSamples,
    silencePaddingSamplesPerScene: silencePaddingSamples,
    totalSamplesPerScene: totalSamples,
    activeSliceSha256: activeDigests,
    preparedPcmSha256: preparedDigests,
  };
}

function nearestColorIndex(red, green, blue) {
  let selected = -1;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < COLORS.length; index += 1) {
    const [expectedRed, expectedGreen, expectedBlue] = COLORS[index].rgb;
    const candidate = (red - expectedRed) ** 2 + (green - expectedGreen) ** 2 + (blue - expectedBlue) ** 2;
    if (candidate < distance) {
      selected = index;
      distance = candidate;
    }
  }
  return selected;
}

async function verifyBoundaryColors(outputPath) {
  const { stdout } = await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin",
    "-i", outputPath,
    "-map", "0:v:0",
    "-vf", "scale=1:1:flags=area",
    "-pix_fmt", "rgb24",
    "-f", "rawvideo", "-",
  ], { maxStdoutBytes: 64 * 1024 });
  assertCondition(stdout.byteLength % 3 === 0, "INVALID_COLOR_DECODE");
  const frameCount = stdout.byteLength / 3;
  const labels = Array.from({ length: frameCount }, (_, frame) => nearestColorIndex(
    stdout[frame * 3],
    stdout[frame * 3 + 1],
    stdout[frame * 3 + 2],
  ));
  const observedBoundaryFrames = [0];
  const observedSceneOrder = labels.length ? [labels[0]] : [];
  for (let frame = 1; frame < labels.length; frame += 1) {
    if (labels[frame] !== labels[frame - 1]) {
      observedBoundaryFrames.push(frame);
      observedSceneOrder.push(labels[frame]);
    }
  }
  observedBoundaryFrames.push(frameCount);
  assertCondition(
    observedSceneOrder.length === FIXTURE_SPEC.sceneCount
      && observedSceneOrder.every((value, index) => value === index),
    "COLOR_SCENE_ORDER_MISMATCH",
  );
  assertCondition(observedBoundaryFrames.length === FIXTURE_SPEC.expectedBoundaryFrames.length, "BOUNDARY_COUNT_MISMATCH");
  const boundaries = FIXTURE_SPEC.expectedBoundaryFrames.map((expectedFrame, index) => {
    const observedFrame = observedBoundaryFrames[index];
    const deltaFrames = observedFrame - expectedFrame;
    const deltaMs = deltaFrames * 1000 / FIXTURE_SPEC.frameRate;
    assertCondition(Math.abs(deltaMs) <= HALF_FRAME_MS, "BOUNDARY_DRIFT");
    return {
      expectedFrame,
      observedFrame,
      deltaFrames,
      deltaMs: Math.round(deltaMs * 1000) / 1000,
    };
  });
  return {
    decodedFrames: frameCount,
    expectedBoundaryFrames: [...FIXTURE_SPEC.expectedBoundaryFrames],
    observedBoundaryFrames,
    maxAbsoluteBoundaryDeltaMs: Math.max(...boundaries.map(({ deltaMs }) => Math.abs(deltaMs))),
    boundaries,
  };
}

function parseProbeJson(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.streams)) throw new Error();
    return parsed;
  } catch {
    throw new FixtureFailure("INVALID_PROBE");
  }
}

async function probeFinalMedia(outputPath) {
  const { stdout } = await runMediaTool("ffprobe", [
    "-v", "error", "-count_frames",
    "-show_entries", "format=duration,start_time:stream=codec_type,start_time,duration,r_frame_rate,avg_frame_rate,sample_rate,channels,nb_read_frames",
    "-of", "json",
    outputPath,
  ]);
  const probe = parseProbeJson(stdout);
  const videos = probe.streams.filter((stream) => stream.codec_type === "video");
  const audios = probe.streams.filter((stream) => stream.codec_type === "audio");
  assertCondition(videos.length === 1 && audios.length === 1, "FINAL_STREAM_COUNT_MISMATCH");
  const videoStartMs = finiteNumber(videos[0].start_time ?? 0, "video start") * 1000;
  const audioStartMs = finiteNumber(audios[0].start_time ?? 0, "audio start") * 1000;
  const videoDurationMs = finiteNumber(videos[0].duration, "video duration") * 1000;
  const audioDurationMs = finiteNumber(audios[0].duration, "audio duration") * 1000;
  const formatDurationMs = finiteNumber(probe.format?.duration, "format duration") * 1000;
  const decodedFrames = Number.parseInt(videos[0].nb_read_frames, 10);
  assertCondition(Number.isSafeInteger(decodedFrames), "FINAL_FRAME_COUNT_MISSING");
  assertCondition(Math.abs(videoStartMs) <= HALF_FRAME_MS, "VIDEO_PTS_DRIFT");
  assertCondition(Math.abs(audioStartMs) <= AUDIO_DURATION_TOLERANCE_MS, "AUDIO_PTS_DRIFT");
  assertCondition(Math.abs(videoDurationMs - FIXTURE_SPEC.durationMs) <= HALF_FRAME_MS, "VIDEO_DURATION_DRIFT");
  assertCondition(Math.abs(audioDurationMs - FIXTURE_SPEC.durationMs) <= AUDIO_DURATION_TOLERANCE_MS, "AUDIO_DURATION_DRIFT");
  assertCondition(Math.abs(formatDurationMs - FIXTURE_SPEC.durationMs) <= AUDIO_DURATION_TOLERANCE_MS, "FORMAT_DURATION_DRIFT");
  assertCondition(decodedFrames === FIXTURE_SPEC.expectedBoundaryFrames.at(-1), "FINAL_FRAME_COUNT_MISMATCH");
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin",
    "-i", outputPath,
    "-map", "0:v:0", "-map", "0:a:0",
    "-f", "null", "-",
  ], { maxStdoutBytes: 1024 });
  return {
    videoStartMs: Math.round(videoStartMs * 1000) / 1000,
    audioStartMs: Math.round(audioStartMs * 1000) / 1000,
    videoDurationMs: Math.round(videoDurationMs * 1000) / 1000,
    audioDurationMs: Math.round(audioDurationMs * 1000) / 1000,
    formatDurationMs: Math.round(formatDurationMs * 1000) / 1000,
    decodedFrames,
    fullDecodeVerified: true,
  };
}

function cosineSimilarity(left, right, startFrame, endFrame, step = 4) {
  let dot = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let frame = startFrame; frame < endFrame; frame += step) {
    for (let channel = 0; channel < FIXTURE_SPEC.channels; channel += 1) {
      const byte = (frame * FIXTURE_SPEC.channels + channel) * 2;
      const leftSample = left.readInt16LE(byte);
      const rightSample = right.readInt16LE(byte);
      dot += leftSample * rightSample;
      leftEnergy += leftSample * leftSample;
      rightEnergy += rightSample * rightSample;
    }
  }
  if (!(leftEnergy > 0) || !(rightEnergy > 0)) return 0;
  return dot / Math.sqrt(leftEnergy * rightEnergy);
}

function toneCorrelation(pcm, frequency, startFrame, endFrame) {
  let sineDot = 0;
  let cosineDot = 0;
  let energy = 0;
  let count = 0;
  for (let frame = startFrame; frame < endFrame; frame += 2) {
    const sample = pcm.readInt16LE(frame * FIXTURE_SPEC.channels * 2);
    const angle = 2 * Math.PI * frequency * frame / FIXTURE_SPEC.sampleRate;
    sineDot += sample * Math.sin(angle);
    cosineDot += sample * Math.cos(angle);
    energy += sample * sample;
    count += 1;
  }
  if (!(energy > 0) || count === 0) return 0;
  return Math.sqrt(sineDot ** 2 + cosineDot ** 2) / Math.sqrt(energy * count / 2);
}

async function verifyFinalAudio(outputPath, directory, masterPcm) {
  const decodedPath = path.join(directory, "final-audio.s16le");
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-xerror", "-nostdin", "-y",
    "-i", outputPath,
    "-map", "0:a:0", "-vn",
    "-ar", String(FIXTURE_SPEC.sampleRate),
    "-ac", String(FIXTURE_SPEC.channels),
    "-c:a", "pcm_s16le", "-f", "s16le",
    decodedPath,
  ]);
  const decoded = await readFile(decodedPath);
  const blockAlign = FIXTURE_SPEC.channels * FIXTURE_SPEC.bitsPerSample / 8;
  assertCondition(decoded.byteLength % blockAlign === 0, "FINAL_AUDIO_DECODE_MALFORMED");
  const decodedFrames = decoded.byteLength / blockAlign;
  const masterFrames = masterPcm.byteLength / blockAlign;
  const comparedFrames = Math.min(decodedFrames, masterFrames);
  assertCondition(comparedFrames >= masterFrames - FIXTURE_SPEC.sampleRate * AUDIO_DURATION_TOLERANCE_MS / 1000, "FINAL_AUDIO_TOO_SHORT");
  const guardFrames = Math.min(2048, Math.floor(comparedFrames / 10));
  const masterCorrelation = cosineSimilarity(decoded, masterPcm, guardFrames, comparedFrames - guardFrames);
  assertCondition(masterCorrelation >= 0.97, "MASTER_AUDIO_FINGERPRINT_MISMATCH");
  const distractorToneCorrelations = DISTRACTOR_FREQUENCIES_HZ.map((frequency, index) => {
    const startFrame = Math.round(index * FIXTURE_SPEC.sceneDurationMs * FIXTURE_SPEC.sampleRate / 1000) + guardFrames;
    const endFrame = Math.min(
      Math.round((index + 1) * FIXTURE_SPEC.sceneDurationMs * FIXTURE_SPEC.sampleRate / 1000) - guardFrames,
      comparedFrames,
    );
    return Math.round(toneCorrelation(decoded, frequency, startFrame, endFrame) * 1_000_000) / 1_000_000;
  });
  const maxDistractorToneCorrelation = Math.max(...distractorToneCorrelations);
  assertCondition(maxDistractorToneCorrelation <= 0.05, "GENERATED_CLIP_AUDIO_DETECTED");
  return {
    decodedSampleFrames: decodedFrames,
    comparedSampleFrames: comparedFrames,
    masterCorrelation: Math.round(masterCorrelation * 1_000_000) / 1_000_000,
    distractorFrequenciesHz: [...DISTRACTOR_FREQUENCIES_HZ],
    distractorToneCorrelations,
    maxDistractorToneCorrelation,
    generatedClipAudioAbsent: true,
  };
}

export function assertSanitizedReport(report) {
  const serialized = JSON.stringify(report);
  assertCondition(!/[A-Za-z]:\\/u.test(serialized), "REPORT_CONTAINS_ABSOLUTE_PATH");
  assertCondition(!/(?:^|["'])\/(?:tmp|home|Users|var)\//u.test(serialized), "REPORT_CONTAINS_ABSOLUTE_PATH");
  assertCondition(!/(authorization|bearer|token|secret|lyrics?|transcript|prompt)/iu.test(serialized), "REPORT_CONTAINS_FORBIDDEN_FIELD");
  return report;
}

export async function runFixture({ client, clientVersion } = {}) {
  cleanClientValue(client, "client");
  cleanClientValue(clientVersion, "clientVersion");
  if (clientVersion && !client) throw new FixtureFailure("INVALID_ARGUMENTS", "clientVersion requires client.");
  await verifyMediaTools();
  const root = await mkdtemp(path.join(tmpdir(), "slopcannon-agent-sync-"));
  let stage = "SETUP";
  try {
    const clipsDir = path.join(root, "clips");
    const preparedDir = path.join(root, "prepared");
    const manifestPath = path.join(root, "manifest.json");
    const masterPath = path.join(root, "master.wav");
    const outputPath = path.join(root, "assembled.mp4");
    stage = "MASTER_GENERATION";
    const master = createDeterministicMaster();
    const manifest = createFixtureManifest(master.sha256);
    await Promise.all([
      writeFile(masterPath, master.file, { flag: "wx" }),
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
    ]);
    stage = "CLIP_GENERATION";
    await generateProviderClips(clipsDir);
    stage = "SCENE_AUDIO_PREPARATION";
    const preparation = await runNodeJson(PREPARER, [
      "--manifest", manifestPath,
      "--song", masterPath,
      "--output-dir", preparedDir,
    ], "PREPARER");
    stage = "PREPARED_AUDIO_VERIFICATION";
    const preparedAudio = await verifyPreparedAudio(preparedDir, master.pcm);
    stage = "MASTER_ASSEMBLY";
    const canonical = await runNodeJson(ASSEMBLER, [
      "--manifest", manifestPath,
      "--song", masterPath,
      "--clips-dir", clipsDir,
      "--output", outputPath,
    ], "ASSEMBLER");
    stage = "BOUNDARY_VERIFICATION";
    const boundaryColors = await verifyBoundaryColors(outputPath);
    stage = "MEDIA_VERIFICATION";
    const media = await probeFinalMedia(outputPath);
    stage = "AUDIO_FINGERPRINT_VERIFICATION";
    const audioFingerprint = await verifyFinalAudio(outputPath, root, master.pcm);
    const outputStatus = await stat(outputPath);
    assertCondition(outputStatus.isFile() && outputStatus.size > 0, "FINAL_OUTPUT_EMPTY");
    assertCondition(preparation.masterAudioSha256Verified === true, "PREPARER_DID_NOT_VERIFY_SHA");
    assertCondition(canonical.masterAudioSha256Verified === true, "ASSEMBLER_DID_NOT_VERIFY_SHA");
    assertCondition(canonical.generatedClipAudioDiscarded === true, "ASSEMBLER_AUDIO_DISCARD_UNCONFIRMED");
    assertCondition(canonical.fullDecodeVerified === true, "ASSEMBLER_DECODE_UNCONFIRMED");
    const report = {
      ok: true,
      fixtureVersion: FIXTURE_VERSION,
      rightsCleanSyntheticFixture: true,
      ...(client ? { client: { name: client, ...(clientVersion ? { version: clientVersion } : {}) } } : {}),
      fixture: {
        dimensions: `${FIXTURE_SPEC.width}x${FIXTURE_SPEC.height}`,
        frameRate: `${FIXTURE_SPEC.frameRate}/1`,
        sceneCount: FIXTURE_SPEC.sceneCount,
        sourceSceneDurationMs: FIXTURE_SPEC.sceneDurationMs,
        providerRequestSeconds: FIXTURE_SPEC.requestSeconds,
        manifestDurationMs: FIXTURE_SPEC.durationMs,
        masterAudio: {
          sampleRate: FIXTURE_SPEC.sampleRate,
          channels: FIXTURE_SPEC.channels,
          bitsPerSample: FIXTURE_SPEC.bitsPerSample,
          sampleFrames: master.sampleFrames,
          nonZeroSamples: master.nonZeroSamples,
          sha256: master.sha256,
          sha256VerifiedByCanonicalTools: true,
        },
      },
      preparedAudio: {
        canonicalDecodedMasterOnce: preparation.decodedMasterOnce === true,
        ...preparedAudio,
      },
      assembly: {
        canonicalReportOk: canonical.ok === true,
        canonicalDiscardedRequestPaddingMs: canonical.discardedRequestPaddingMs,
        canonicalGeneratedClipAudioDiscarded: canonical.generatedClipAudioDiscarded === true,
        canonicalFullDecodeVerified: canonical.fullDecodeVerified === true,
        ...boundaryColors,
        ...media,
        ...audioFingerprint,
      },
    };
    return assertSanitizedReport(report);
  } catch (error) {
    if (error instanceof FixtureFailure) throw error;
    throw new FixtureFailure(`${stage}_FAILED`);
  } finally {
    const resolved = path.resolve(root);
    const expectedParent = path.resolve(tmpdir());
    if (path.dirname(resolved) === expectedParent && path.basename(resolved).startsWith("slopcannon-agent-sync-")) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
}

async function main() {
  try {
    const report = await runFixture(parseFixtureArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const code = error instanceof FixtureFailure ? error.code : "FIXTURE_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, fixtureVersion: FIXTURE_VERSION, errorCode: code })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) await main();
