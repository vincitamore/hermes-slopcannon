#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const MAX_BYTES = 256 * 1024;
const MIN_SCENE_MS = 5_000;
const MAX_SCENE_MS = 15_000;
const MAX_SCENES = 512;
const MAX_CAST = 9;
const MAX_CAST_NAME = 40;
const MAX_BEAT = 4_000;
const MAX_TOTAL_BEAT = 120_000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1_000;
const H3_DIALOGUE = /<d>\[([A-Za-z][A-Za-z -]{0,31})\]([\s\S]*?)<\/d>/gu;
const VISIBLE_VOCAL = /\b(?:sings?|raps?|whispers?|lip-syncs?|performs?\s+(?:the\s+)?(?:line|lyric|vocal))\b/iu;
const SILENT_MOUTH = /\b(?:mouths?\s+(?:remain|remains|stay|stays|kept)\s+(?:fully\s+)?closed|closed-mouth|remain(?:s)?\s+(?:vocally\s+)?silent|stay(?:s)?\s+(?:vocally\s+)?silent)\b/iu;
const CAST_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'’-]*$/u;

function usage() {
  return "Usage: node scripts/validate-timed-plan.mjs <plan.json> [--duration-ms N] [--cast \"NAME 1,NAME 2\"] [--require-h3-vocals]\nA plan of exactly one scene carrying sourceAudioAssetId (a prepare --server scene plan) may start where that scene starts in the song; any other plan starts at 0.";
}

function parseArgs(argv) {
  const [file, ...rest] = argv;
  if (!file) throw new Error(usage());
  let expectedDuration;
  let allowedCast;
  let requireH3Vocals = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--require-h3-vocals") {
      requireH3Vocals = true;
    } else if (flag === "--duration-ms" && value !== undefined) {
      expectedDuration = Number(value);
      index += 1;
    } else if (flag === "--cast" && value !== undefined) {
      allowedCast = value.split(",").map((name) => name.normalize("NFKC").trim()).filter(Boolean);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${flag}\n${usage()}`);
    }
  }
  return { file, expectedDuration, allowedCast, requireH3Vocals };
}

function normalized(value) {
  return value.normalize("NFKC").trim().toLocaleUpperCase("en-US");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function speakerIsMapped(beat, cast, speakerId) {
  const id = escapeRegex(speakerId);
  return cast.some((rawName) => {
    if (typeof rawName !== "string") return false;
    const normalizedName = rawName.normalize("NFKC").trim();
    if (!normalizedName) return false;
    const name = escapeRegex(normalizedName);
    const boundedName = `(?:^|[^\\p{L}\\p{N}])${name}(?=$|[^\\p{L}\\p{N}])`;
    return new RegExp(
      `(?:${boundedName}[^.\\n]{0,160}(?:\\(${id}\\)|=\\s*${id}\\b)|(?:\\(${id}\\)|\\b${id}\\s*=)[^.\\n]{0,160}${boundedName})`,
      "iu",
    ).test(beat);
  });
}

/** The direction that asks for a visible vocal, quoted with the words before it in its sentence, or null. */
function visibleVocalDirection(beat) {
  const match = VISIBLE_VOCAL.exec(beat);
  if (!match) return null;
  const sentence = beat.slice(0, match.index).split(/[.!?;\n]/u).at(-1).trim();
  return `${sentence.length > 60 ? `...${sentence.slice(-57)}` : sentence} ${match[0]}`.trim();
}

function validateH3Vocals(beat, cast, path, sceneDurationMs, add) {
  const tags = [...beat.matchAll(H3_DIALOGUE)];
  const openCount = (beat.match(/<d>/gu) ?? []).length;
  const closeCount = (beat.match(/<\/d>/gu) ?? []).length;
  if (openCount !== tags.length || closeCount !== tags.length) {
    add(`${path}.beat`, "Every H3 dialogue tag must use complete <d>[Language]Exact lyric.</d> syntax.");
  }
  const vocal = tags.length === 0 ? visibleVocalDirection(beat) : null;
  if (vocal) {
    add(`${path}.beat`, `Visible vocal direction ("${vocal}") requires an exact local onset, named speaker ID, and <d>[Language]...</d> span; generic singing direction is not enough.`);
  }
  // Lyric text is sound, not direction: a cast name sung inside a span maps no speaker.
  const direction = beat.replace(H3_DIALOGUE, "<d>.</d>");
  let previousDialogueEnd = 0;
  for (const tag of tags) {
    if (!tag[2].trim()) add(`${path}.beat`, "H3 dialogue spans must not be empty.");
    const prefix = beat.slice(Math.max(previousDialogueEnd, tag.index - 260), tag.index);
    const onsetMatches = [...prefix.matchAll(/\b(?:At|From)\s+00:(\d{2})\.(\d{3})\b/giu)];
    const onset = onsetMatches.at(-1);
    if (!onset) {
      add(`${path}.beat`, "Each H3 dialogue span must be preceded by an exact local onset such as At 00:03.420.");
    } else {
      const onsetMs = Number(onset[1]) * 1_000 + Number(onset[2]);
      if (onsetMs >= sceneDurationMs) {
        add(`${path}.beat`, `H3 dialogue onset ${onset[0]} falls outside the scene.`);
      }
    }
    const speakerMatches = [...prefix.matchAll(/\((S\d+(?:\s*,\s*S\d+)*)\)/giu)];
    const speaker = speakerMatches.at(-1);
    previousDialogueEnd = tag.index + tag[0].length;
    if (!speaker) {
      add(`${path}.beat`, "Each H3 dialogue span must be preceded by an explicit speaker ID such as (S1).");
      continue;
    }
    for (const rawId of speaker[1].split(",")) {
      const speakerId = rawId.trim().toLocaleUpperCase("en-US");
      if (!speakerIsMapped(direction, cast, speakerId)) {
        add(`${path}.beat`, `Speaker ${speakerId} must map to an explicit named scene cast member. A speaker who is not in this scene's cast is heard off screen: write that line without a <d> span and keep every visible mouth closed while it plays.`);
      }
    }
  }
  if (tags.length > 0 && cast.length > 1 && !SILENT_MOUTH.test(beat)) {
    add(`${path}.beat`, "Scenes with visible non-singers must explicitly keep their mouths closed or vocally silent.");
  }
}

function validate(value, options) {
  const issues = [];
  const add = (path, message) => issues.push({ path, message });
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{ path: "$", message: "Plan must be an object." }];
  if (value.schemaVersion !== 1) add("$.schemaVersion", "Must equal 1.");
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs < MIN_SCENE_MS || value.durationMs > MAX_DURATION_MS) {
    add("$.durationMs", "Must be an integer from 5000 through 7200000.");
  }
  if (options.expectedDuration !== undefined) {
    if (!Number.isSafeInteger(options.expectedDuration) || options.expectedDuration <= 0) add("--duration-ms", "Must be a positive integer.");
    else if (Number.isSafeInteger(value.durationMs) && Math.abs(value.durationMs - options.expectedDuration) > 250) add("$.durationMs", `Must match decoded duration ${options.expectedDuration} within 250 ms.`);
  }
  if (!Array.isArray(value.scenes) || value.scenes.length === 0 || value.scenes.length > MAX_SCENES) {
    add("$.scenes", `Must contain 1-${MAX_SCENES} scenes.`);
    return issues;
  }
  const castLookup = options.allowedCast ? new Set(options.allowedCast.map(normalized)) : null;
  // A one-scene plan cut from the master on the server (prepare --server) keeps the
  // scene's real place in the song: it starts where the scene starts and durationMs
  // is the scene's end. Every other plan covers its song from 0.
  const [onlyScene] = value.scenes;
  const sceneAudioPlan = value.scenes.length === 1 && Boolean(onlyScene) && typeof onlyScene === "object"
    && typeof onlyScene.sourceAudioAssetId === "string" && onlyScene.sourceAudioAssetId.trim() !== "";
  let previousEnd = sceneAudioPlan && Number.isSafeInteger(onlyScene.startMs) && onlyScene.startMs >= 0 ? onlyScene.startMs : 0;
  let totalBeat = 0;
  value.scenes.forEach((scene, index) => {
    const path = `$.scenes[${index}]`;
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
      add(path, "Must be an object.");
      return;
    }
    if (scene.sourceAudioAssetId !== undefined && (typeof scene.sourceAudioAssetId !== "string" || !scene.sourceAudioAssetId.trim())) {
      add(`${path}.sourceAudioAssetId`, "Must be a non-empty scene audio asset ID.");
    }
    if (!Number.isSafeInteger(scene.startMs) || scene.startMs < 0) add(`${path}.startMs`, "Must be a non-negative integer.");
    if (!Number.isSafeInteger(scene.endMs) || scene.endMs <= 0) add(`${path}.endMs`, "Must be a positive integer.");
    if (Number.isSafeInteger(scene.startMs) && scene.startMs !== previousEnd) {
      add(`${path}.startMs`, index === 0
        ? `Must equal previous end ${previousEnd}. Only a plan of exactly one scene carrying sourceAudioAssetId may start later in the song.`
        : `Must equal previous end ${previousEnd}.`);
    }
    if (Number.isSafeInteger(scene.startMs) && Number.isSafeInteger(scene.endMs)) {
      const duration = scene.endMs - scene.startMs;
      if (duration < MIN_SCENE_MS || duration > MAX_SCENE_MS) add(`${path}.endMs`, "Scene duration must be 5000-15000 ms.");
      previousEnd = scene.endMs;
    }
    if (!Array.isArray(scene.cast) || scene.cast.length > MAX_CAST) add(`${path}.cast`, `Must be an array with at most ${MAX_CAST} names.`);
    else {
      const seen = new Set();
      scene.cast.forEach((name, castIndex) => {
        const castPath = `${path}.cast[${castIndex}]`;
        if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_CAST_NAME || !CAST_NAME.test(name.normalize("NFKC").trim())) {
          add(castPath, "Invalid cast name.");
          return;
        }
        const key = normalized(name);
        if (seen.has(key)) add(castPath, "Duplicate cast name in scene.");
        if (castLookup && !castLookup.has(key)) add(castPath, "Name is not in --cast.");
        seen.add(key);
      });
    }
    if (typeof scene.beat !== "string" || !scene.beat.trim() || scene.beat.trim().length > MAX_BEAT) add(`${path}.beat`, `Must contain 1-${MAX_BEAT} characters.`);
    else {
      const beat = scene.beat.trim();
      totalBeat += beat.length;
      if (options.requireH3Vocals && Number.isSafeInteger(scene.startMs) && Number.isSafeInteger(scene.endMs)) {
        validateH3Vocals(beat, Array.isArray(scene.cast) ? scene.cast : [], path, scene.endMs - scene.startMs, add);
      }
    }
  });
  if (totalBeat > MAX_TOTAL_BEAT) add("$.scenes", `Combined beat text exceeds ${MAX_TOTAL_BEAT} characters.`);
  if (Number.isSafeInteger(value.durationMs) && previousEnd !== value.durationMs) add("$.scenes", `Final end ${previousEnd} must equal durationMs ${value.durationMs}.`);
  if (Number.isSafeInteger(options.expectedDuration) && Math.abs(previousEnd - options.expectedDuration) > 250) add("$.scenes", `Final end ${previousEnd} must match decoded duration ${options.expectedDuration} within 250 ms.`);
  return issues;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const source = await readFile(options.file);
  if (source.byteLength > MAX_BYTES) throw new Error(`Plan exceeds ${MAX_BYTES} bytes.`);
  const parsed = JSON.parse(source.toString("utf8"));
  const issues = validate(parsed, options);
  if (issues.length) {
    console.error(JSON.stringify({ ok: false, issues }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, scenes: parsed.scenes.length, durationMs: parsed.durationMs }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
