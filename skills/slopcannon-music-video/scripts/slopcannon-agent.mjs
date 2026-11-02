#!/usr/bin/env node

// SLOPCANNON hosted agent-plane driver.
//
// One zero-dependency script that lets an agent with a shell take a production
// from a song and references to a finished MP4 on the hosted agent plane:
// discover the deployment's contract, present the rights statement, create
// one project, upload bounded media, build and validate a timed plan, slice scene
// audio that fits the deployment's caps, quote, submit against an exact
// approval, poll, retrieve content, and download the verified server master.
// Explicit --assembly local uses the same takes with assemble-master.mjs.
//
// Control plane is MCP (POST /api/mcp); bytes travel over authenticated HTTP.
// State lives in a JSON ledger so every idempotency key is written before the
// call it protects and reused on an ambiguous outcome. The human is asked for
// exactly four things: the prompt, explicit post-disclosure rights sign-off, the quote approval (or
// a standing cap), and take feedback.
//
// Requirements: Node 22.13+, SLOPCANNON_AGENT_TOKEN in the environment.
// Only local media operations require FFmpeg/FFprobe (or the corresponding
// SLOPCANNON_FFMPEG_PATH / SLOPCANNON_FFPROBE_PATH overrides). No packages.

import { readExportReadiness, resumeExportUpload } from "./resumable-export.mjs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeMedia, runMediaTool } from "./assemble-master.mjs";
import { readPngHeader } from "./end-card.mjs";
import { fileDigest, saveArtifactResponse, verifiedLocalArtifact } from "./artifact-download.mjs";
import { writePreparedWav } from "./prepare-scene-audio.mjs";
import { instrumentalClause as instrumentalSilence, offScreenClause, silentCastClause } from "./plan-templates.mjs";
import { ORIGIN_ENV, allowedOrigin, trustedOrigin } from "./trusted-origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RIGHTS_HEADER = "X-Slopcannon-Rights-Attestation";
const TOKEN_ENV = "SLOPCANNON_AGENT_TOKEN";
const MAX_ERROR_TEXT = 2_000;
const MIN_SCENE_MS = 5_000;
const MAX_SCENE_MS = 15_000;
const SAMPLE_RATE_LADDER = [48_000, 32_000, 24_000, 16_000];
const HOSTED_ASSET_MAX_BYTES = 50 * 1024 * 1024;
const SCENE_AUDIO_POLL_MS = 2_000;
const SCENE_AUDIO_POLL_ATTEMPTS = 300;
const MIME_BY_EXT = new Map([
  [".wav", "audio/wav"], [".mp3", "audio/mpeg"], [".m4a", "audio/mp4"], [".flac", "audio/flac"], [".ogg", "audio/ogg"],
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"],
]);

const VERBS = {
  caps: ["--origin", "--ledger"],
  rights: ["--ledger", "--site-origin"],
  project: ["--ledger", "--scene", "--name", "--concept", "--aspect"],
  upload: ["--ledger", "--scene", "--kind", "--file", "--label", "--rights", "--duration-ms"],
  plan: ["--ledger", "--transcript", "--directions", "--duration-ms", "--cuts", "--out"],
  prepare: ["--ledger", "--plan", "--song", "--out-dir", "--server"],
  quote: ["--ledger", "--scene", "--plan", "--cast", "--bible", "--aspect", "--source-audio-asset"],
  submit: ["--ledger", "--scene", "--approve-units", "--reference"],
  recover: ["--ledger", "--scene"],
  "retry-failed": ["--ledger", "--scene"],
  poll: ["--ledger", "--scene", "--interval", "--timeout"],
  content: ["--ledger", "--scene", "--out", "--name"],
  manifest: ["--ledger", "--plan", "--song", "--out", "--clip-prefix"],
  assemble: ["--manifest", "--song", "--clips-dir", "--output"],
  workspace: ["--ledger", "--project"],
  cuts: ["--ledger", "--project", "--pace", "--scene-min-ms", "--scene-max-ms", "--revision"],
  direct: ["--ledger", "--project", "--scene-id", "--instruction", "--revision"],
  select: ["--ledger", "--project", "--scene-id", "--take", "--revision"],
  check: ["--ledger", "--scene", "--plan", "--cast", "--voice-over", "--force"],
  reroll: ["--ledger", "--scene", "--plan", "--cast", "--direction", "--bible", "--aspect", "--approve-units", "--max-credits"],
  cut: ["--ledger", "--plan", "--takes", "--title", "--output", "--accept-checks", "--end-card", "--end-card-from-ms", "--rights", "--graphics"],
  usage: ["--ledger", "--cursor", "--limit"],
  status: ["--ledger"],
  run: ["--ledger", "--production", "--rights-accepted", "--approve", "--max-credits", "--review-first", "--concurrency", "--assembly", "--accept-checks"],
  character: ["--ledger", "--action", "--slug", "--character-id", "--version", "--reference-id", "--project", "--scene", "--label", "--name", "--rights", "--revision", "--asset-id", "--query", "--tag", "--owned", "--limit", "--offset", "--spec"],
  "publish-link": ["--ledger", "--action", "--project", "--asset-id", "--title", "--description", "--link-id", "--limit"],
  spot: ["--ledger", "--action", "--project", "--brief", "--length", "--energy", "--cast", "--must-say-file", "--products", "--end-card", "--max-credits", "--rights", "--key", "--spot", "--timeout", "--interval", "--beat", "--text", "--direction", "--kind", "--cue", "--prompt", "--remove", "--out-dir", "--pitch"],
  pitch: ["--ledger", "--action", "--project", "--website", "--name", "--address", "--notes", "--max-credits", "--rights", "--key", "--pitch", "--timeout", "--interval"],
};

export function usage() {
  return [
    "Usage:",
    "  node slopcannon-agent.mjs <verb> [--flag value ...]",
    "",
    "  caps     --origin <https://host> [--ledger <file>]",
    "  rights   [--ledger <file>] [--site-origin <https://site>]",
    "  project  --scene <id> --name <title> [--concept <text>] [--aspect 16:9]",
    "  upload   --scene <id> --kind song|character_reference|set_reference --file <path> --label <name> --rights <version> [--duration-ms <n>]",
    "  plan     --transcript <words.json> --directions <directions.json> --duration-ms <n> --out <plan.json> [--cuts a,b,c]",
    "  prepare  --plan <plan.json> --song <master> --out-dir <new-directory>",
    "  prepare  --server <projectId> --plan <plan.json> [--out-dir <directory>]",
    "  quote    --scene <id> --plan <scene-plan.json> --cast <cast.json> [--bible <text-file>] [--aspect 16:9]",
    "  submit   --scene <id> --approve-units <exact quoted amount> [--reference <label>]",
    "  recover  --scene <id>  (find a lost response without submitting or spending)",
    "  retry-failed --scene <id>  (stage only a confirmed failed scene for a NEW paid quote; retains attempt history; the retry keeps the scene's declared length and cast pictures)",
    "  poll     --scene <id> [--interval <seconds>] [--timeout <seconds>]",
    "  content  --scene <id> --out <directory> [--name <file.mp4>]",
    "  manifest --plan <plan.json> --song <master> --out <manifest.json> [--clip-prefix slopcannon-scene]",
    "  assemble --manifest <manifest.json> --song <master> --clips-dir <directory> --output <final.mp4>",
    "  workspace --project <hosted project id>  (read the saved film and the revision a change must carry)",
    "  cuts     --project <id> [--pace patient|music|hyper] [--scene-min-ms <n>] [--scene-max-ms <n>] [--revision <n>]  (cut the song into scenes on the server)",
    "  direct   --project <id> [--scene-id <n>] [--instruction <text>] [--revision <n>]  (draft scene text and cast for the saved timeline)",
    "  select   --project <id> --scene-id <n> --take <n> --revision <n>  (choose a scene's take)",
    "  check    --scene <id> --plan <scene-plan.json> --cast <cast.json> [--voice-over yes|no] [--force yes]  (look for character defects in the delivered take)",
    "  reroll   --scene <id> --plan <scene-plan.json> --cast <cast.json> [--direction <text>] [--bible <the film's text-file>] [--aspect <only for older ledgers>] [--approve-units <exact quoted amount>] [--max-credits <production ceiling>]  (a new take of one delivered scene: quotes first, then submits, downloads and checks once approved)",
    "  cut      --plan <timed-plan.json> --takes <scene=take,...> --title <title> --output <film.mp4> [--accept-checks all|<scene,scene>]  (assemble the film on the server with chosen rerolls)",
    "  cut      ... --end-card <card.png> --end-card-from-ms <ms in the film> --rights <version>  (and lay an exact-text PNG at the film's size over the last scene from that moment; --takes may then be left out)",
    "  cut      ... --graphics <audio spot id>  (and draw that spot's planned on-screen graphics, its exact facts, over the film; --takes may then be left out)",
    "  usage    [--cursor <next cursor>] [--limit <1-200>]  (page this account's Cannon Credit ledger)",
    "  status   [--ledger <file>]",
    "  run      --production <production.json> [--rights-accepted <version>] [--approve all|<credits per scene>] [--max-credits <production ceiling>] [--review-first <first clip sha256>] [--concurrency 1..16, default 4] [--assembly server|local] [--accept-checks all|<scene,scene>]",
    "  character --action list|get|import|create|update|add-reference|publish|unpublish [--slug <slug>] [--character-id <id>] [--version <n>] [--reference-id <id>] [--project <id>] [--scene <id>] [--label <name>] [--name <name>] [--rights <version>] [--revision <n>] [--asset-id <id>] [--spec <file.json>]",
    "  publish-link --action create|get|films [--project <id>] [--asset-id <id>] [--title <text>] [--description <text>] [--link-id <spl_...>] [--limit <1-50>]",
    "  spot     --action options|list [--project <id>]  (Ad Cannon audio spots: prices, voices, your spots)",
    "  spot     --action create --project <id> --brief <text> --length <seconds> --cast <cast.json> [--must-say-file <facts.txt>] [--products <products.json>] [--end-card <end-card.json>] --max-credits <approved price> --rights <version> [--energy calm|lively|hype] [--key <idempotency key>]",
    "           (products.json: up to 4 {name: UPPER_SNAKE, photoAssetId, description} make it a product ad; end-card.json: {name, street?, phone?, website?} for the closing line)",
    "  spot     --action get|wait --spot <id> [--timeout <seconds>] [--interval <seconds>]",
    "  spot     --action edit --spot <id> --beat <beatId> --text <new line> [--direction <how it is read>]  (free; re-records one line)",
    "  spot     --action edit-sound --spot <id> --kind sfx --beat <beatId> --prompt <new sound> | --kind music --cue <index> --prompt <new cue>  (free; remakes one sound)",
    "  spot     --action edit-sound --spot <id> --kind sfx --beat <beatId> --remove yes  (free; takes one effect out)",
    "  spot     --action load --spot <id> --rights <version>  (the master becomes the project's song, each shot a scene)",
    "  spot     --action download --spot <id> --out-dir <directory>  (master.wav, stems, captions.srt, cutlist.json)",
    "  spot     --action create ... --pitch <adpitch id> --direction <0-3>  (fire a pitch's direction; the pitch's credits come back once)",
    "  pitch    --action create [--project <id>] [--website <url>] [--name <text>] [--address <text>] [--notes <text>] --max-credits <approved price> [--rights <version> with --website] [--key <idempotency key>]",
    "  pitch    --action get|wait --pitch <id> [--timeout <seconds>] [--interval <seconds>]  (research a business and pitch 4 ad directions)",
    "",
    `The bearer token is read only from ${TOKEN_ENV} and is sent only to https://api.slop.cc, or to the origin set in ${ORIGIN_ENV}. The ledger defaults to ./slopcannon-agent.json.`,
    "Rights assent, spend approval and the credit ceiling are taken only from this command line, never from the production file or ledger.",
  ].join("\n");
}

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  if (!verb || !Object.hasOwn(VERBS, verb)) throw new Error(usage());
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(usage());
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set(VERBS[verb]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}\n${usage()}`);
  return { verb, options: values };
}

function need(options, flag) {
  const value = options.get(flag);
  if (!value) throw new Error(`Missing ${flag}.\n${usage()}`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const width = Number(concurrency);
  if (!Number.isSafeInteger(width) || width < 1 || width > 16) {
    throw new Error("--concurrency must be a whole number from 1 through 16.");
  }
  const results = new Array(items.length);
  let cursor = 0;
  let failure;
  async function lane() {
    for (;;) {
      if (failure) return;
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { failure ??= error; return; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => lane()));
  if (failure) throw failure;
  return results;
}
/** The bearer token, released only for a URL on the trusted origin. */
function token(url) {
  if (url === undefined) throw new Error("The agent token is released only for a named URL.");
  trustedOrigin(new URL(url).origin);
  const value = process.env[TOKEN_ENV]?.trim();
  if (!value || !value.startsWith("slop_live_")) {
    throw new Error(`${TOKEN_ENV} must hold a SLOPCANNON agent token (slop_live_...). Create one at /account; never pass it as a flag.`);
  }
  return value;
}

function newKey(prefix) {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Include uncertain attempts in the ceiling; a lost response is not free work. */
export function productionSpend(ledger, pending, maxCredits) {
  const limit = Number(maxCredits);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("--max-credits must be a non-negative whole Cannon Credit production ceiling.");
  let committedCredits = 0;
  for (const entry of Object.values(ledger.scenes)) {
    const attempts = [...(entry.attempts ?? []), ...(entry.generation?.key || entry.generation?.id ? [entry.generation] : [])];
    for (const attempt of attempts) {
    const approval = attempt.submission?.approval ?? entry.quote;
    if (approval?.currency !== "CANNON_CREDIT" || approval?.creditUnit !== "cannon-credit" || !Number.isSafeInteger(approval.amountUnits) || approval.amountUnits < 0) {
      throw new Error("An earlier attempt has no verified Cannon Credit amount. Reconcile that attempt before authorizing more spend; keep its ledger for recovery.");
    }
    committedCredits += approval.amountUnits;
    }
  }
  const pendingCredits = pending.reduce((total, quote) => {
    if (!Number.isSafeInteger(quote.amountUnits) || quote.amountUnits < 0) throw new Error("Invalid pending Cannon Credit quote.");
    return total + quote.amountUnits;
  }, 0);
  const exposureCredits = committedCredits + pendingCredits;
  if (!Number.isSafeInteger(exposureCredits)) throw new Error("Production spending exceeds the safe integer range.");
  return { limitCredits: limit, committedCredits, pendingCredits, exposureCredits, withinLimit: exposureCredits <= limit };
}

/** A review acknowledges exact downloaded bytes, never merely a scene number. */
export function firstSceneReview(ledger, sceneIds, acknowledgedDigest) {
  if (sceneIds.length < 2) return { required: false, accepted: true };
  const first = ledger.scenes[sceneIds[0]];
  const downloaded = first?.downloaded;
  const digest = downloaded?.sha256;
  const valid = typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);
  const accepted = valid && (ledger.firstSceneReview?.sha256 === digest || acknowledgedDigest === digest);
  return { required: true, accepted: Boolean(accepted), scene: sceneIds[0], artifact: downloaded ?? null, sha256: valid ? digest : null };
}

/** Reference kinds a production or cast file may give: character (the default) or product. */
const REFERENCE_KINDS = new Set(["character", "product"]);

/**
 * The cast file `run` writes: one entry per production reference, carrying its
 * kind only when the reference gives one, so a production without kinds writes
 * the same file as before. A product is food, a product, an object or a place
 * as the business photographed it.
 */
export function productionCast(production) {
  return (production.references ?? []).map((reference, index) => {
    if (reference?.kind !== undefined && !REFERENCE_KINDS.has(reference.kind)) {
      throw new Error(`references[${index}].kind must be "character" or "product".`);
    }
    return { id: reference.id ?? `cast-${index + 1}`, name: reference.name, label: reference.label ?? `ref-${index + 1}`, ...(reference.kind ? { kind: reference.kind } : {}) };
  });
}

/** The asset kind a production reference picture is uploaded as: a product is a set picture. */
export function referenceAssetKind(reference) {
  return reference?.kind === "product" ? "set_reference" : "character_reference";
}

/** The asset kinds a cast member's picture may be quoted and checked with: a product may be either picture kind. */
function castAssetKinds(member) {
  return member?.kind === "product" ? ["character_reference", "set_reference"] : ["character_reference"];
}

export function referencedCastForPlan(cast, plan) {
  const names = new Set(plan.scenes.flatMap((entry) => entry.cast));
  for (const name of names) {
    if (!cast.some((member) => member.name === name)) throw new Error(`Timed scene references unknown cast member ${name}.`);
  }
  return cast.filter((member) => names.has(member.name));
}

export function fileInventory(files) {
  return files.map(({ file, ...identity }) => {
    const hash = createHash("sha256");
    const bytes = hashFileInto(file, hash);
    return { ...identity, file, bytes, sha256: hash.digest("hex") };
  });
}

function hashFileInto(file, hash, beforeBytes = () => {}) {
  const descriptor = openSync(file, "r");
  try {
    const size = fstatSync(descriptor).size;
    beforeBytes(size);
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      hash.update(buffer.subarray(0, count));
    }
    if (total !== size) throw new Error("Production source changed while reading; freeze its bytes before retrying.");
    return total;
  } finally { closeSync(descriptor); }
}

export function preparedRevision(plan, files) {
  return sha256(stableJson({ plan, files: files.map(({ role, scene, bytes, sha256: digest }) => ({ role, scene, bytes, sha256: digest })) }));
}

export function fingerprintProduction(productionFile, production) {
  const base = path.dirname(productionFile);
  const productionSpec = { ...production };
  delete productionSpec.approve;
  delete productionSpec.rightsAccepted;
  delete productionSpec.workDir;
  const inputs = [
    ["song", production.song ? path.resolve(base, production.song) : null],
    ["transcript", production.transcript ? path.resolve(base, production.transcript) : null],
    ["bible", production.bible ? path.resolve(base, production.bible) : null],
    ...(production.references ?? []).map((reference, index) => [
      `reference-${index + 1}`,
      reference?.path ? path.resolve(base, reference.path) : null,
    ]),
  ].filter(([, file]) => file);
  const hash = createHash("sha256");
  hash.update(stableJson(productionSpec)).update("\0");
  for (const [label, file] of inputs) {
    hashFileInto(file, hash, (size) => hash.update(label).update("\0").update(path.basename(file)).update("\0").update(String(size)).update("\0"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------- ledger

export function emptyLedger(origin) {
  return { version: 1, origin, endpoints: null, generation: null, rights: null, productionFingerprint: null, scenes: {} };
}

export function loadLedger(file) {
  if (!existsSync(file)) return emptyLedger(null);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.scenes)) throw new Error(`Ledger ${file} is not a version 1 slopcannon-agent ledger.`);
  return parsed;
}

/**
 * Merge-save by scene so a fresh read preserves unrelated state. Separate
 * mutating processes must still serialize access to one ledger; filesystem
 * writes alone are not a cross-process transaction.
 */
export function saveLedger(file, ledger, sceneId) {
  const directory = path.dirname(file);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  let merged = ledger;
  if (sceneId && existsSync(file)) {
    try {
      const onDisk = JSON.parse(readFileSync(file, "utf8"));
      if (isRecord(onDisk) && onDisk.version === 1 && isRecord(onDisk.scenes)) {
        onDisk.scenes[sceneId] = ledger.scenes[sceneId];
        for (const key of ["origin", "endpoints", "generation", "rights", "productionFingerprint", "preparedFingerprint", "spendCapCredits", "firstSceneReview", "sceneAudio"]) if (ledger[key] != null) onDisk[key] = ledger[key];
        merged = onDisk;
      } else throw new Error("Invalid saved ledger");
    } catch {
      throw new Error("The saved ledger could not be safely merged. Preserve it for recovery; no state was overwritten.");
    }
  }
  const candidate = `${file}.candidate-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    const descriptor = openSync(candidate, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(candidate, file);
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

function scene(ledger, id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error("--scene must be a short alphanumeric id.");
  ledger.scenes[id] ??= { assets: {}, log: [] };
  return ledger.scenes[id];
}

function note(entry, step, text) {
  entry.log.push({ at: new Date().toISOString(), step, note: text });
}

function requireOrigin(ledger, options) {
  const origin = options.get("--origin") ?? ledger.origin ?? allowedOrigin();
  return trustedOrigin(origin);
}

function endpoint(ledger, name, fallbackPath) {
  const url = ledger.endpoints?.[name];
  const resolved = url ? new URL(url) : new URL(fallbackPath, ledger.origin);
  if (resolved.origin !== new URL(ledger.origin).origin) {
    throw new Error(`Capability endpoint ${name} resolves outside the configured SLOPCANNON origin.`);
  }
  return resolved;
}

// ---------------------------------------------------------------- transport

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000), ...init });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Unexpected redirect from ${new URL(url).origin}; credentials were not forwarded.`);
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, json, text };
}

let rpcId = 1;
/**
 * A character check can take the server three minutes plus a retry. An audio spot read can run one stage of the spot,
 * and a line or sound edit renders it during the call. Every other tool answers well inside 30 s.
 */
const MCP_TOOL_TIMEOUT_MS = {
  slopcannon_check_take: 540_000,
  slopcannon_get_audio_spot: 180_000,
  // a pitch read can run the writer's stage, which thinks before it writes
  slopcannon_get_ad_pitch: 300_000,
  slopcannon_edit_audio_spot_line: 180_000,
  slopcannon_edit_audio_spot_sound: 180_000,
};

export async function mcpCall(ledger, tool, params) {
  const url = endpoint(ledger, "mcp", "/api/mcp");
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS[tool] ?? 30_000),
    headers: {
      Authorization: `Bearer ${token(url)}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: tool, arguments: params } }),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Unexpected MCP redirect; the account token was not forwarded.");
  }
  const text = await response.text();
  let body;
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    body = JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join(""));
  } else {
    body = JSON.parse(text);
  }
  if (body.error) throw new Error(`MCP ${tool}: rpc error ${body.error.code} ${body.error.message}`);
  const result = body.result;
  if (result?.isError) {
    const error = result.structuredContent?.error ?? {};
    const failure = new Error(`MCP ${tool}: ${error.code ?? "error"} ${error.message ?? ""}`.trim());
    failure.code = error.code;
    failure.details = error.details;
    failure.retryable = error.retryable === true;
    throw failure;
  }
  return result.structuredContent;
}

async function httpAuthed(url, init = {}) {
  return fetchJson(url, { ...init, headers: { Authorization: `Bearer ${token(url)}`, ...(init.headers ?? {}) } });
}

// ---------------------------------------------------------------- verbs: contract

export function summarizeCapabilities(manifest) {
  const hosted = manifest?.hostedRuntime ?? {};
  const generation = manifest?.contract?.generation ?? {};
  return {
    status: hosted.status,
    canonicalApi: hosted.canonicalApi ?? null,
    quoteReady: hosted.quoteReady === true,
    submissionReady: hosted.submissionReady === true,
    contentReady: hosted.contentReady === true,
    projectReady: hosted.projectReady === true,
    songAnalysisControlReady: hosted.songAnalysisControlReady === true,
    serverSideSlicing: generation.serverSideSlicing === true,
    serverAssemblyReady: manifest?.contract?.assembly?.serverReady === true,
    trackedFilmAssemblyReady: manifest?.contract?.assembly?.trackedFilmReady === true,
    finalExportMaxBytes: manifest?.contract?.assetUploadLimits?.finalExportMaxBytes ?? null,
    resumableExport: manifest?.contract?.assetUploadLimits?.resumable ?? null,
    maximumProjectScenes: manifest?.contract?.workspace?.maximumScenes ?? 120,
    sourceAudioAssetIdAccepted: generation.sourceAudioAssetIdAccepted === true,
    maximumScenesPerQuote: Number.isSafeInteger(generation.maximumScenesPerQuote) ? generation.maximumScenesPerQuote : null,
    sceneDurationMs: generation.sceneDurationMs ?? { minimum: MIN_SCENE_MS, maximum: MAX_SCENE_MS },
    sourceAudioDurationMs: generation.sourceAudioDurationMs ?? null,
    sourceAssetMaxBytes: Number.isSafeInteger(generation.sourceAssetMaxBytes) ? generation.sourceAssetMaxBytes : null,
    audioReferenceSupport: generation.audioReferenceSupport ?? null,
    minimumCannonCreditsPerGeneration: generation.minimumCannonCreditsPerGeneration ?? null,
    downloadUrlTtlSeconds: generation.downloadUrlTtlSeconds ?? null,
    imageReferencesPerScene: generation.imageReferencesPerScene ?? 9,
    mcpTools: manifest?.contract?.mcp?.toolNames ?? [],
    renderRequests: manifest?.contract?.renderRequests ?? null,
  };
}

async function verbCaps(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  const origin = requireOrigin(ledger, options);
  const { status, json } = await fetchJson(new URL("/api/v1/capabilities", origin));
  if (status !== 200 || !isRecord(json)) throw new Error(`GET ${origin}/api/v1/capabilities returned ${status}.`);
  const summary = summarizeCapabilities(json);
  ledger.origin = origin;
  ledger.endpoints = isRecord(json.endpoints) ? json.endpoints : null;
  ledger.generation = summary;
  saveLedger(ledgerFile, ledger);
  const ready = summary.submissionReady && summary.contentReady;
  return {
    ok: true,
    origin,
    ready,
    ...summary,
    advice: ready
      ? "This origin can quote, submit and deliver."
      : "This origin cannot deliver a managed generation. Ask the human whether a separate hosted API origin exists before using the browser workflow.",
  };
}

async function verbRights(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const { status, json } = await fetchJson(endpoint(ledger, "rightsAttestation", "/api/v1/rights-attestation"));
  const data = json?.data ?? json;
  if (status !== 200 || !isRecord(data) || typeof data.statement !== "string") throw new Error(`Rights discovery returned ${status}.`);
  const siteOrigin = options.get("--site-origin") ?? ledger.origin.replace(/^https:\/\/api\./, "https://");
  const resolve = (value) => (typeof value === "string" ? new URL(value, siteOrigin).toString() : null);
  ledger.rights = { version: data.requiredVersion, statementSha256: data.statementSha256 ?? sha256(data.statement), presentedAt: new Date().toISOString() };
  saveLedger(ledgerFile, ledger);
  return {
    ok: true,
    requiredVersion: data.requiredVersion,
    header: data.header ?? RIGHTS_HEADER,
    statement: data.statement,
    termsUrl: resolve(data.termsUrl),
    acceptableUseUrl: resolve(data.acceptableUseUrl),
    termsVersion: data.termsVersion ?? null,
    acceptableUseVersion: data.acceptableUseVersion ?? null,
    instruction: "Show the statement and both links to the human verbatim with the files (name, bytes, sha256). Only after explicit affirmative sign-off may the requiredVersion be passed to upload --rights; `I agree` is sufficient, and an unambiguous post-disclosure directive to proceed with the upload also counts. One sign-off covers this version for the rest of the session: pass it for later files the same human supplies or directs you to create, naming them as information, until the version changes, another person directs the work, or the human withdraws it.",
  };
}

// ---------------------------------------------------------------- verbs: project + upload

async function verbProject(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const entry = scene(ledger, id);
  if (entry.projectId) return { ok: true, scene: id, projectId: entry.projectId, replayed: true };
  entry.projectKey ??= newKey("proj");
  saveLedger(ledgerFile, ledger, id);
  const params = { name: need(options, "--name"), idempotencyKey: entry.projectKey, aspectRatio: options.get("--aspect") ?? "16:9", targetResolution: "2K" };
  if (options.get("--concept")) params.concept = options.get("--concept");
  const result = await mcpCall(ledger, "slopcannon_create_project", params);
  entry.projectId = result.project.id;
  note(entry, "project", `${result.project.id} replayed=${result.replayed === true}`);
  saveLedger(ledgerFile, ledger, id);
  return { ok: true, scene: id, projectId: entry.projectId, replayed: result.replayed === true };
}

async function decodedDurationMs(file) {
  const probe = await probeMedia(file);
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const seconds = Number.parseFloat(audio?.duration ?? probe.format?.duration);
  if (!Number.isFinite(seconds)) throw new Error(`Could not decode the duration of ${file}.`);
  return Math.round(seconds * 1000);
}

async function verbUpload(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const entry = scene(ledger, id);
  if (!entry.projectId) throw new Error(`Scene ${id} has no project. Run project first.`);
  const file = path.resolve(need(options, "--file"));
  const kind = need(options, "--kind");
  const label = need(options, "--label");
  const rights = need(options, "--rights");
  if (ledger.rights?.version && ledger.rights.version !== rights) {
    throw new Error(`--rights ${rights} does not match the presented version ${ledger.rights.version}. Re-run rights and obtain fresh assent.`);
  }
  const caps = ledger.generation ?? {};
  // Where the platform cuts the scenes, the uploaded master is the source of
  // those cuts rather than the source asset of a generation, so it is bounded
  // by the hosted asset limit instead of the per-generation source cap.
  // An `other` picture (an end card) is never a generation source either: the hosted asset limit bounds it too.
  const wholeMaster = (kind === "song" && caps.serverSideSlicing === true) || kind === "other";
  const fileBytes = statSync(file).size;
  const byteCeiling = wholeMaster ? HOSTED_ASSET_MAX_BYTES : caps.sourceAssetMaxBytes ?? 786432;
  if (fileBytes <= 0 || fileBytes > byteCeiling) throw new Error(`Source file must be 1-${byteCeiling} bytes. Cut long audio into scene audio before upload.`);
  const bytes = readFileSync(file);
  if (bytes.length !== fileBytes || bytes.length > byteCeiling) throw new Error("Source changed while reading; freeze its bytes before upload.");
  const digest = sha256(bytes);
  const existing = entry.assets[label];
  if (existing?.id && existing.sha256 === digest && existing.kind === kind) return { ok: true, scene: id, label, assetId: existing.id, replayed: true };
  const contentType = MIME_BY_EXT.get(path.extname(file).toLowerCase());
  if (!contentType) throw new Error(`Unsupported media extension on ${file}.`);
  if (!wholeMaster && caps.sourceAssetMaxBytes && bytes.length > caps.sourceAssetMaxBytes) {
    throw new Error(`${file} is ${bytes.length} bytes; this origin caps source assets at ${caps.sourceAssetMaxBytes}. Cut it into scene audio before uploading.`);
  }
  // A changed body is a new idempotent operation. Reusing the prior key with
  // different bytes correctly conflicts at the server and would make a
  // reference or scene-audio replacement impossible to resume.
  const assetKey = existing && (existing.sha256 !== digest || existing.kind !== kind) ? newKey("asset") : existing?.key ?? newKey("asset");
  const headers = { "Content-Type": contentType, "Idempotency-Key": assetKey, "x-content-sha256": digest, [RIGHTS_HEADER]: rights };
  if (kind === "song" && !(wholeMaster && !options.get("--duration-ms"))) {
    // An origin that decodes the master measures the length itself, so the
    // header is sent only where it was asked for, and it is still checked.
    const measured = await decodedDurationMs(file);
    const declared = options.get("--duration-ms") ? Number(options.get("--duration-ms")) : measured;
    if (!Number.isSafeInteger(declared) || Math.abs(declared - measured) > 250) {
      throw new Error(`--duration-ms ${declared} does not match the decoded duration ${measured} ms. The server checks this header against its own decode; send the truth.`);
    }
    const range = caps.sourceAudioDurationMs;
    if (!wholeMaster && range && (declared < range.minimum || declared > range.maximum)) {
      throw new Error(`Song duration ${declared} ms is outside this origin's sourceAudioDurationMs ${range.minimum}-${range.maximum}.`);
    }
    headers["x-media-duration-ms"] = String(declared);
  }
  const query = new URLSearchParams({ projectId: entry.projectId, kind, filename: path.basename(file) });
  const requestIdentity = sha256(stableJson({ query: query.toString(), digest, contentType, durationMs: headers["x-media-duration-ms"] ?? null, rights }));
  if (existing?.key && !existing.id && existing.requestIdentity && existing.requestIdentity !== requestIdentity) {
    throw new Error("An upload response is unresolved and its metadata changed. Restore the original file, filename and headers to replay its saved key; do not replace this operation.");
  }
  const url = endpoint(ledger, "assets", "/api/v1/assets");
  url.search = query.toString();
  entry.assets[label] = { id: null, kind, sha256: digest, filename: path.basename(file), sizeBytes: bytes.length, key: assetKey, requestIdentity };
  saveLedger(ledgerFile, ledger, id);
  const { status, json, text, headers: responseHeaders } = await httpAuthed(url, { method: "POST", headers, body: bytes });
  if (status !== 201 && status !== 200) throw new Error(`Upload ${label} returned ${status}: ${text.slice(0, 400)}`);
  const asset = json.data;
  if (asset.sha256 !== digest) throw new Error(`Server digest ${asset.sha256} differs from local ${digest}.`);
  entry.assets[label] = { id: asset.id, kind: asset.kind, sha256: digest, filename: asset.filename, sizeBytes: asset.sizeBytes, key: headers["Idempotency-Key"] };
  note(entry, "upload", `${label} ${asset.id} ${asset.sizeBytes}B replayed=${responseHeaders.get("idempotency-replayed")}`);
  saveLedger(ledgerFile, ledger, id);
  return { ok: true, scene: id, label, assetId: asset.id, sizeBytes: asset.sizeBytes, sha256: digest, replayed: status === 200 };
}

// ---------------------------------------------------------------- verbs: plan + prepare

/**
 * Optional voice attribution on a transcript phrase or segment: `speaker` names
 * who voices it (a roster name) and `offScreen: true` marks a line heard while
 * that speaker is not on camera. Absent fields leave the phrase unattributed.
 */
function phraseAttribution(source) {
  const attribution = {};
  if (typeof source?.speaker === "string" && source.speaker.trim()) attribution.speaker = source.speaker.trim();
  if (source?.offScreen === true) attribution.offScreen = true;
  return attribution;
}

export function readTranscript(doc) {
  const words = [];
  const phrases = [];
  if (Array.isArray(doc?.segments)) {
    for (const segment of doc.segments) {
      const segmentWords = (segment.words ?? [])
        .map((word) => ({ text: String(word.word ?? word.text ?? "").trim(), startMs: Math.round(Number(word.start) * 1000), endMs: Math.round(Number(word.end) * 1000) }))
        .filter((word) => word.text && Number.isFinite(word.startMs) && Number.isFinite(word.endMs));
      if (segmentWords.length === 0) continue;
      words.push(...segmentWords);
      phrases.push({ startMs: segmentWords[0].startMs, endMs: segmentWords.at(-1).endMs, words: segmentWords, ...phraseAttribution(segment) });
    }
  } else if (Array.isArray(doc?.phrases)) {
    for (const phrase of doc.phrases) {
      const phraseWords = (phrase.words ?? []).map((word) => ({ text: String(word.text ?? "").trim(), startMs: Number(word.startMs), endMs: Number(word.endMs) }))
        .filter((word) => word.text && Number.isSafeInteger(word.startMs) && Number.isSafeInteger(word.endMs));
      if (phraseWords.length === 0) continue;
      words.push(...phraseWords);
      phrases.push({ startMs: phraseWords[0].startMs, endMs: phraseWords.at(-1).endMs, words: phraseWords, ...phraseAttribution(phrase) });
    }
  } else {
    throw new Error("Transcript must be Whisper JSON (segments[].words[]) or { phrases: [{ words: [{ text, startMs, endMs }] }] }.");
  }
  if (words.length === 0) throw new Error("Transcript has no timed words.");
  words.sort((left, right) => left.startMs - right.startMs);
  phrases.sort((left, right) => left.startMs - right.startMs);
  return { words, phrases };
}

/** Phrase-safe cuts: the widest inter-word silence inside each legal window. */
export function planCuts(words, durationMs, forced = [], bounds = { minimum: MIN_SCENE_MS, maximum: MAX_SCENE_MS }) {
  if (forced.length > 0) {
    const edges = [0, ...forced, durationMs];
    return edges.slice(0, -1).map((start, index) => [start, edges[index + 1]]);
  }
  const gaps = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    const gap = words[index + 1].startMs - words[index].endMs;
    if (gap > 0) gaps.push({ at: words[index].endMs + Math.round(gap / 2), width: gap });
  }
  const scenes = [];
  let cursor = 0;
  while (durationMs - cursor > bounds.maximum) {
    const low = cursor + bounds.minimum;
    const high = Math.min(cursor + bounds.maximum, durationMs - bounds.minimum);
    const pick = gaps.filter((gap) => gap.at >= low && gap.at <= high).sort((left, right) => right.width - left.width || left.at - right.at)[0];
    const cut = pick ? pick.at : high;
    scenes.push([cursor, cut]);
    cursor = cut;
  }
  scenes.push([cursor, durationMs]);
  return scenes;
}

function localTimecode(absoluteMs, sceneStartMs) {
  const localMs = absoluteMs - sceneStartMs;
  const seconds = Math.floor(localMs / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(localMs % 1000).padStart(3, "0")}`;
}

/**
 * Join hand-authored directions with a word-timed transcript. Lyric text is
 * copied from the transcript into <d> spans and never retyped; the agent
 * authors camera, subject, action and identity only.
 */
const DELIVERY_VERBS = new Set(["sings", "says"]);

function speakerKey(name) {
  return String(name).normalize("NFKC").trim().toLocaleUpperCase("en-US");
}

/**
 * The voices a plan may attribute lines to. `directions.speakers` is an optional
 * roster of { name, speakerId } for productions with several voices (a duet, a
 * dialogue episode); `directions.singer` stays the default voice, and is required
 * unless a roster is given, in which case the roster's first entry is the default.
 */
function planVoices(directions) {
  const roster = directions.speakers;
  if (roster !== undefined && (!Array.isArray(roster) || roster.length === 0)) throw new Error("directions.speakers must be a non-empty array of { name, speakerId }.");
  const byName = new Map();
  const ids = new Set();
  for (const entry of roster ?? []) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim() || typeof entry.speakerId !== "string" || !/^S\d+$/u.test(entry.speakerId)) {
      throw new Error("Each directions.speakers entry needs { name, speakerId } with a speakerId such as S1.");
    }
    const key = speakerKey(entry.name);
    if (byName.has(key)) throw new Error(`directions.speakers names ${entry.name} twice.`);
    if (ids.has(entry.speakerId)) throw new Error(`directions.speakers uses ${entry.speakerId} twice; each voice needs its own speaker ID.`);
    byName.set(key, { name: entry.name.trim(), speakerId: entry.speakerId });
    ids.add(entry.speakerId);
  }
  const singer = directions.singer;
  const singerValid = isRecord(singer) && singer.name && singer.speakerId;
  if (!singerValid && byName.size === 0) throw new Error("directions.singer needs { name, speakerId }.");
  const fallback = singerValid ? singer : [...byName.values()][0];
  if (singerValid && byName.size > 0) {
    const listed = byName.get(speakerKey(singer.name));
    if (listed && listed.speakerId !== singer.speakerId) throw new Error(`directions.singer ${singer.name} is ${singer.speakerId} but directions.speakers lists it as ${listed.speakerId}.`);
    if (!listed && ids.has(singer.speakerId)) throw new Error(`directions.singer uses ${singer.speakerId}, which directions.speakers gives to another voice.`);
  }
  const delivery = directions.delivery ?? "sings";
  if (!DELIVERY_VERBS.has(delivery)) throw new Error(`directions.delivery must be "sings" or "says", not ${JSON.stringify(delivery)}.`);
  return { roster: byName, fallback, delivery, hasRoster: byName.size > 0 };
}

function resolveSpeaker(voices, phrase, vocalist) {
  if (!phrase.speaker) return vocalist;
  const found = voices.roster.get(speakerKey(phrase.speaker))
    ?? (speakerKey(phrase.speaker) === speakerKey(vocalist.name) ? vocalist : undefined)
    ?? (speakerKey(phrase.speaker) === speakerKey(voices.fallback.name) ? voices.fallback : undefined);
  if (!found) throw new Error(`Transcript phrase at ${phrase.startMs} ms names speaker ${phrase.speaker}, who is not in directions.speakers or directions.singer.`);
  return found;
}

function shotVocalist(shot, fallback) {
  return isRecord(shot?.singer) && shot.singer.name && shot.singer.speakerId ? shot.singer : fallback;
}

/**
 * Whether a line plays on camera in a scene. It does not when the transcript
 * marks it off screen, or when the scene names its cast and the speaker is not
 * in it: the speaker is not in the shot, so the line is heard, not seen. An
 * empty cast puts nobody on camera. An unknown speaker or cast leaves only the
 * transcript's mark.
 */
function lineOnCamera(phrase, speakerName, cast) {
  if (phrase.offScreen) return false;
  if (!Array.isArray(cast) || !speakerName) return true;
  return cast.some((name) => speakerKey(name) === speakerKey(speakerName));
}

/**
 * Whether a voice is only ever heard off screen: it has lines and every one of
 * them is marked offScreen (a narrator). An unattributed phrase counts as the
 * voice's own, since it is voiced by the scene's singer.
 */
function heardOnlyOffScreen(phrases, voice) {
  const own = phrases.filter((phrase) => !phrase.speaker || speakerKey(phrase.speaker) === speakerKey(voice.name));
  return own.length > 0 && own.every((phrase) => phrase.offScreen);
}

/**
 * Join hand-authored directions with a word-timed transcript. Lyric text is
 * copied from the transcript into <d> spans and never retyped; the agent
 * authors camera, subject, action and identity only.
 *
 * A phrase may name its speaker and may be off screen (see readTranscript). An
 * on-screen phrase is voiced by its speaker; an off-screen phrase gets no <d>
 * span, since the video model would move a visible mouth to it, and is instead
 * named as a window during which every mouth on screen stays closed. Off screen
 * is decided per scene: in a scene whose `cast` leaves the speaker out, the
 * speaker's lines are off screen there too.
 *
 * A scene's `cast` is what is on camera, so a voice heard off screen is never
 * added to it. A scene that gives `cast: []` (a location or product shot with
 * no reference) keeps it empty. A scene that gives no `cast` gets the speakers
 * on camera in it, or else its singer, unless the singer is heard off screen
 * in that scene or only ever off screen (a narrator): then it is empty too.
 */
export function buildTimedPlan({ transcript, directions, durationMs, cuts = [], bounds }) {
  const { words, phrases } = readTranscript(transcript);
  const voices = planVoices(directions);
  const language = directions.language ?? "English";
  const silentCast = Array.isArray(directions.silentCast) ? directions.silentCast : [];
  const shots = directions.scenes;
  const sceneCuts = planCuts(words, durationMs, cuts, bounds);
  if (!Array.isArray(shots) || (shots.length !== 1 && shots.length !== sceneCuts.length)) {
    throw new Error(`directions.scenes has ${shots?.length ?? 0} entries but the cut produced ${sceneCuts.length} scenes; pass --cuts or supply matching directions.`);
  }
  const scenes = sceneCuts.map(([startMs, endMs], index) => {
    const shot = shots.length === 1 ? shots[0] : shots[index];
    const vocalist = shotVocalist(shot, voices.fallback);
    const inScene = (word) => word.startMs >= startMs && word.startMs < endMs;
    const scenePhrases = phrases
      .map((phrase) => ({ phrase, sceneWords: phrase.words.filter(inScene) }))
      .filter(({ sceneWords }) => sceneWords.length > 0)
      .map(({ phrase, sceneWords }) => ({ phrase, sceneWords, speaker: resolveSpeaker(voices, phrase, vocalist) }));
    // An authored cast is kept as written, an empty one too: nobody is on camera in it.
    const namedCast = Array.isArray(shot.cast) ? shot.cast : null;
    const onScreen = scenePhrases.filter(({ phrase, speaker }) => lineOnCamera(phrase, speaker.name, namedCast));
    const offScreen = scenePhrases.filter((entry) => !onScreen.includes(entry));
    // Speakers on camera, in order of first line.
    const speakers = [];
    for (const { speaker } of onScreen) if (!speakers.some((entry) => speakerKey(entry.name) === speakerKey(speaker.name))) speakers.push(speaker);
    const vocalistOffScreen = offScreen.some(({ speaker }) => speakerKey(speaker.name) === speakerKey(vocalist.name)) || heardOnlyOffScreen(phrases, vocalist);
    const cast = namedCast
      ? namedCast
      : speakers.length > 1 || (speakers.length === 1 && speakerKey(speakers[0].name) !== speakerKey(vocalist.name))
        ? speakers.map((speaker) => speaker.name)
        : speakers.length === 0 && vocalistOffScreen ? [] : [vocalist.name];
    const spans = onScreen
      .map(({ sceneWords, speaker }) => {
        const text = sceneWords.map((word) => word.text).join(" ").replace(/\s+([,.!?])/g, "$1");
        return `At ${localTimecode(sceneWords[0].startMs, startMs)}, ${speaker.name} (${speaker.speakerId}) ${voices.delivery}, <d>[${language}]${text}</d>`;
      });
    // The video model follows the order of the shot prose over a bare onset: a shot
    // written "the phone breaches, then LEAD sings" plays the line over the phone.
    // State each speaker's whole vocal window and what must be on screen during it.
    const performanceClauses = speakers.map((speaker) => {
      const spoken = onScreen.filter((entry) => speakerKey(entry.speaker.name) === speakerKey(speaker.name)).flatMap((entry) => entry.sceneWords);
      return `Performance window ${localTimecode(spoken[0].startMs, startMs)} to ${localTimecode(Math.min(spoken.at(-1).endMs, endMs), startMs)}: ${speaker.name} is on screen facing the camera in medium close-up or closer, face unobstructed and mouth clearly visible, articulating every word in time with the vocal; no entrance, cutaway, occlusion, time-lapse or camera pull-back during this window, and any other action happens before or after it.`;
    });
    const turnTakingClause = speakers.length > 1
      ? `Each speaker's mouth stays closed while another speaker's line plays.`
      : "";
    const offScreenClauses = offScreen.map(({ sceneWords }) => {
      const visible = cast.filter((name) => voices.roster.has(speakerKey(name)) || speakerKey(name) === speakerKey(vocalist.name));
      return offScreenClause(localTimecode(sceneWords[0].startMs, startMs), localTimecode(Math.min(sceneWords.at(-1).endMs, endMs), startMs), visible);
    });
    const talking = new Set((speakers.length > 0 ? speakers : [vocalist]).map((speaker) => speakerKey(speaker.name)));
    const listeners = [
      ...(voices.hasRoster ? cast.filter((name) => voices.roster.has(speakerKey(name))) : []),
      ...silentCast.filter((name) => cast.includes(name)),
    ];
    const silent = (voices.hasRoster ? [...new Set(listeners)] : listeners).filter((name) => !talking.has(speakerKey(name)));
    const silentClause = silent.length > 0 ? silentCastClause(silent) : "";
    const instrumentalClause = spans.length === 0 && offScreen.length === 0 && cast.includes(vocalist.name)
      ? instrumentalSilence(vocalist.name)
      : "";
    const identity = index === 0 || directions.repeatIdentityLock !== false ? String(directions.identityLock ?? "").trim() : "";
    const beat = [`[Shot ${index + 1}] ${String(shot.shot ?? "").trim()}`, identity, spans.join(" "), ...performanceClauses, turnTakingClause, ...offScreenClauses, silentClause, instrumentalClause].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { startMs, endMs, cast, beat };
  });
  return { schemaVersion: 1, durationMs, scenes };
}

const ACTION_BEFORE_LINE = /\b(?:then|until|finally|appears?|emerges?|reveal(?:s|ing)?|time-?lapse|pulls? back|pull-?back|push(?:es)?-?in through|whip-?pans?|cuts? to|settles on|before)\b/iu;
const STILL_MOUTH = /\b(?:whispers?|whispering|mumbles?|mumbling|murmurs?|hushed)\b/iu;

/**
 * Direction problems that break lip-sync but pass the plan validator: a line that
 * starts in the first moments of a scene whose shot describes action that comes
 * first, delivery words that ask for a still mouth, and a speaker who talks in a
 * scene that does not cast them, whose line therefore plays off screen.
 */
export function directionWarnings({ transcript, directions, plan }) {
  const { phrases } = readTranscript(transcript);
  const shots = directions.scenes ?? [];
  const lock = String(directions.identityLock ?? "");
  const warnings = [];
  const lockStill = lock.match(STILL_MOUTH);
  if (lockStill) warnings.push(`Identity lock: "${lockStill[0]}" asks for a nearly still mouth in every scene, which reads as broken lip-sync. Direct clear, articulated delivery.`);
  // A hand-placed plan may come with directions the builder would refuse; warn on what can still be read.
  let voices;
  try {
    voices = planVoices(directions);
  } catch {
    voices = undefined;
  }
  plan.scenes.forEach((scene, index) => {
    const direction = shots.length === 1 ? shots[0] : shots[index];
    const shot = String(direction?.shot ?? "");
    const vocalist = shotVocalist(direction, voices?.fallback);
    const inScene = (word) => word.startMs >= scene.startMs && word.startMs < scene.endMs;
    const speakerOf = (phrase) => (phrase.speaker ? voices?.roster.get(speakerKey(phrase.speaker))?.name ?? phrase.speaker : vocalist?.name);
    const onCamera = (phrase) => lineOnCamera(phrase, speakerOf(phrase), scene.cast);
    const voiceIds = new Set([...scene.beat.matchAll(/\((S\d+)\) (?:sings|says), <d>/gu)].map((match) => match[1]));
    if (voiceIds.size > 1) {
      warnings.push(`Scene ${index + 1}: ${voiceIds.size} speakers voice lines on camera in one take (${[...voiceIds].join(", ")}). Two speaking mouths in one take are not yet proven to keep each line on the right mouth; expect rerolls, or give each speaker their own scene and play the other's line off screen.`);
    }
    const uncast = new Map();
    for (const phrase of phrases) {
      if (phrase.offScreen || onCamera(phrase) || !phrase.words.some(inScene)) continue;
      const key = speakerKey(speakerOf(phrase));
      if (!uncast.has(key)) uncast.set(key, speakerOf(phrase));
    }
    for (const name of uncast.values()) {
      warnings.push(`Scene ${index + 1}: ${name} speaks in this scene but is not in its cast, so the line plays off screen with every visible mouth closed. Add ${name} to the scene's cast to show it on camera, or mark the phrase offScreen.`);
    }
    const spans = (list) => list.map((phrase) => phrase.words.filter(inScene)).filter((sceneWords) => sceneWords.length > 0).map((sceneWords) => [sceneWords[0].startMs, sceneWords.at(-1).endMs]);
    const heard = spans(phrases.filter((phrase) => !onCamera(phrase)));
    const seen = spans(phrases.filter(onCamera));
    if (heard.some(([start, end]) => seen.some(([onStart, onEnd]) => start < onEnd && onStart < end))) {
      warnings.push(`Scene ${index + 1}: an off-screen line overlaps a line spoken on camera. The model hears both in the scene audio and may move the visible mouth to the off-screen voice; separate them or accept a reroll.`);
    }
    const first = phrases.filter(onCamera).flatMap((phrase) => phrase.words).find(inScene);
    if (!first) return;
    const onsetMs = first.startMs - scene.startMs;
    // Action the shot explicitly places after the line is the recommended shape.
    const beforeLine = shot.split(/\bafter (?:the|his|her|their) (?:last|final) (?:word|line)\b/iu)[0];
    const action = beforeLine.match(ACTION_BEFORE_LINE);
    if (onsetMs < 1_500 && action) {
      warnings.push(`Scene ${index + 1}: the vocal starts at ${localTimecode(first.startMs, scene.startMs)} but the shot describes action that comes first ("${action[0]}"). The model follows the prose order, so the line plays over that action. Move the action after the last word, or start the line later.`);
    }
    const still = shot.match(STILL_MOUTH);
    if (still) warnings.push(`Scene ${index + 1}: "${still[0]}" asks for a nearly still mouth, which reads as broken lip-sync. Direct clear, articulated delivery.`);
  });
  return warnings;
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function validatePlan(planFile, durationMs, castNames) {
  const result = await runNode(path.join(SCRIPT_DIR, "validate-timed-plan.mjs"), [planFile, "--duration-ms", String(durationMs), "--cast", castNames.join(","), "--require-h3-vocals"]);
  if (result.code !== 0) throw new Error(`Timed plan failed validation: ${result.stderr.trim() || result.stdout.trim()}`);
}

async function verbPlan(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  const transcript = JSON.parse(readFileSync(path.resolve(need(options, "--transcript")), "utf8"));
  const directions = JSON.parse(readFileSync(path.resolve(need(options, "--directions")), "utf8"));
  const durationMs = Number(need(options, "--duration-ms"));
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_SCENE_MS) throw new Error("--duration-ms must be a whole number of milliseconds of at least 5000.");
  const cuts = (options.get("--cuts") ?? "").split(",").map((value) => value.trim()).filter(Boolean).map(Number);
  if (cuts.some((cut) => !Number.isSafeInteger(cut))) throw new Error("--cuts must be a comma-separated list of integer milliseconds.");
  const bounds = ledger.generation?.sceneDurationMs ?? undefined;
  const plan = buildTimedPlan({ transcript, directions, durationMs, cuts, bounds });
  const out = path.resolve(need(options, "--out"));
  const candidate = `${out}.candidate-${randomBytes(8).toString("hex")}`;
  writeFileSync(candidate, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const castNames = [...new Set(plan.scenes.flatMap((entry) => entry.cast))];
  try {
    await validatePlan(candidate, durationMs, castNames);
    renameSync(candidate, out);
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
  const warnings = directionWarnings({ transcript, directions, plan });
  return {
    ok: true,
    out,
    durationMs,
    warnings,
    sceneCount: plan.scenes.length,
    scenes: plan.scenes.map((entry, index) => ({ index: index + 1, startMs: entry.startMs, endMs: entry.endMs, durationMs: entry.endMs - entry.startMs, vocalSpans: (entry.beat.match(/<d>/g) ?? []).length, beatChars: entry.beat.length })),
  };
}

export function sceneFileStem(index) {
  return `sc${String(index).padStart(2, "0")}`;
}

/** Largest PCM sample rate on the ladder whose mono 16-bit slice fits the cap. */
export function chooseSampleRate(sceneMs, maxBytes) {
  if (!maxBytes) return SAMPLE_RATE_LADDER[0];
  for (const rate of SAMPLE_RATE_LADDER) if (Math.ceil((sceneMs / 1000) * rate) * 2 + 44 <= maxBytes) return rate;
  throw new Error(`No PCM sample rate on ${SAMPLE_RATE_LADDER.join("/")} fits a ${sceneMs} ms mono slice under ${maxBytes} bytes.`);
}

function scenePlanFor(entry, sceneMs, sourceAudioAssetId) {
  const scene = { startMs: entry.startMs, endMs: entry.endMs, cast: entry.cast, beat: entry.beat };
  if (sourceAudioAssetId) scene.sourceAudioAssetId = sourceAudioAssetId;
  return {
    schemaVersion: 1,
    durationMs: sourceAudioAssetId ? entry.endMs : sceneMs,
    scenes: sourceAudioAssetId ? [scene] : [{ ...scene, startMs: 0, endMs: sceneMs }],
  };
}

function capsRetryDelays() {
  const raw = process.env.SLOPCANNON_AGENT_CAPS_RETRY_MS ?? "3000,10000";
  return raw.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the origin to cut the uploaded master into one source-audio asset per
 * scene. Nothing is decoded here: the ticket and the asset IDs it produces are
 * recorded in the ledger, and a resumed run reuses the same ticket.
 */
async function verbPrepareServer(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  if (ledger.generation && ledger.generation.serverSideSlicing !== true) {
    throw new Error("This origin does not currently provide managed scene audio. Retry when its capabilities report readiness.");
  }
  const projectId = need(options, "--server");
  const planFile = path.resolve(need(options, "--plan"));
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.scenes)) throw new Error("--plan must be a schema 1 timed plan.");
  const scenes = plan.scenes.map((entry, index) => ({
    id: index + 1,
    startMs: entry.startMs,
    endMs: entry.endMs,
    requestSeconds: Math.ceil((entry.endMs - entry.startMs) / 1000),
  }));
  const key = sha256(stableJson({ projectId, scenes }));
  ledger.sceneAudio ??= {};
  let record = ledger.sceneAudio[key];
  const url = endpoint(ledger, "sceneAudio", "/api/v1/projects/{projectId}/scene-audio");
  url.pathname = url.pathname.replace("%7BprojectId%7D", encodeURIComponent(projectId)).replace("{projectId}", encodeURIComponent(projectId));
  if (!record?.ticketId) {
    const started = await httpAuthed(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenes }),
    });
    if (started.status !== 202 || !started.json?.data?.ticketId) {
      throw new Error(`Scene audio returned ${started.status}: ${started.text.slice(0, 400)}`);
    }
    record = { ticketId: started.json.data.ticketId, projectId };
    ledger.sceneAudio[key] = record;
    saveLedger(ledgerFile, ledger);
  }
  url.search = new URLSearchParams({ ticketId: record.ticketId }).toString();
  let data = null;
  for (let attempt = 0; attempt < SCENE_AUDIO_POLL_ATTEMPTS; attempt += 1) {
    const read = await httpAuthed(url, { method: "GET" });
    if (read.status !== 200 || !isRecord(read.json?.data)) {
      throw new Error(`Scene audio ${record.ticketId} returned ${read.status}: ${read.text.slice(0, 400)}`);
    }
    data = read.json.data;
    if (data.phase === "failed") throw new Error(`Scene audio ${record.ticketId} failed: ${data.error ?? "unknown"}`);
    if (data.phase === "completed") break;
    await sleep(SCENE_AUDIO_POLL_MS);
  }
  if (data?.phase !== "completed") throw new Error(`Scene audio ${record.ticketId} did not finish in time. Re-run prepare to resume this ticket.`);
  if (data.sceneAudio.length !== scenes.length) throw new Error(`Scene audio returned ${data.sceneAudio.length} assets for ${scenes.length} scenes.`);

  const outDir = options.get("--out-dir") ? path.resolve(options.get("--out-dir")) : null;
  if (outDir) mkdirSync(path.join(outDir, "scene-plans"), { recursive: true });
  const prepared = scenes.map((scene, index) => {
    const produced = data.sceneAudio.find((candidate) => candidate.sceneId === scene.id);
    if (!produced) throw new Error(`Scene ${scene.id} has no scene audio.`);
    const stem = sceneFileStem(index + 1);
    const entry = plan.scenes[index];
    if (outDir) {
      writeFileSync(
        path.join(outDir, "scene-plans", `${stem}.json`),
        `${JSON.stringify(scenePlanFor(entry, entry.endMs - entry.startMs, produced.assetId), null, 2)}\n`,
        "utf8",
      );
    }
    return {
      scene: stem,
      sceneId: scene.id,
      startMs: scene.startMs,
      endMs: scene.endMs,
      durationMs: produced.durationMs,
      requestSeconds: scene.requestSeconds,
      assetId: produced.assetId,
      sizeBytes: produced.bytes,
      sha256: produced.sha256,
      ...(outDir ? { plan: path.join(outDir, "scene-plans", `${stem}.json`) } : {}),
    };
  });
  record.scenes = prepared;
  record.songDurationMs = data.songDurationMs ?? null;
  ledger.sceneAudio[key] = record;
  saveLedger(ledgerFile, ledger);
  return {
    ok: true,
    server: true,
    projectId,
    ticketId: record.ticketId,
    sceneCount: prepared.length,
    sampleRate: data.sampleRate,
    channels: data.channels,
    songDurationMs: record.songDurationMs,
    scenes: prepared,
  };
}

async function verbPrepare(options, ledgerFile) {
  if (options.has("--server")) return verbPrepareServer(options, ledgerFile);
  const ledger = loadLedger(ledgerFile);
  const planFile = path.resolve(need(options, "--plan"));
  const song = path.resolve(need(options, "--song"));
  const outDir = path.resolve(need(options, "--out-dir"));
  if (existsSync(outDir)) throw new Error(`--out-dir ${outDir} already exists.`);
  const stagingDir = `${outDir}.candidate-${randomBytes(8).toString("hex")}`;
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.scenes)) throw new Error("--plan must be a schema 1 timed plan.");
  await validatePlan(planFile, await decodedDurationMs(song), [...new Set(plan.scenes.flatMap((entry) => entry.cast))]);
  const maxBytes = ledger.generation?.sourceAssetMaxBytes ?? null;
  const rate = Math.min(...plan.scenes.map((entry) => chooseSampleRate(entry.endMs - entry.startMs, maxBytes)));
  mkdirSync(path.join(stagingDir, "scene-plans"), { recursive: true });
  const scenes = [];
  const decodedFile = path.join(stagingDir, "master.pcm");
  try {
    // Decode the long master once; copy exact absolute PCM ranges for all scenes.
    await runMediaTool("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", song, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(rate), "-c:a", "pcm_s16le", "-f", "s16le", decodedFile]);
    const decodedBytes = statSync(decodedFile).size;
    if (decodedBytes % 2 !== 0 || decodedBytes < plan.durationMs * (rate / 1000) * 2) throw new Error("Decoded master is incomplete; no scene audio was published.");
    for (const [index, entry] of plan.scenes.entries()) {
      const stem = sceneFileStem(index + 1);
      const sceneMs = entry.endMs - entry.startMs;
      const stagedWav = path.join(stagingDir, `${stem}.wav`);
      await writePreparedWav({ decodedFile, outputFile: stagedWav, channels: 1, sampleRate: rate, startSample: entry.startMs * (rate / 1000), activeSamples: sceneMs * (rate / 1000), requestSamples: sceneMs * (rate / 1000) });
      const sizeBytes = statSync(stagedWav).size;
      if (maxBytes && sizeBytes > maxBytes) throw new Error(`${stem}.wav is ${sizeBytes} bytes, over the ${maxBytes} cap.`);
      const singlePlan = { schemaVersion: 1, durationMs: sceneMs, scenes: [{ startMs: 0, endMs: sceneMs, cast: entry.cast, beat: entry.beat }] };
      const stagedPlan = path.join(stagingDir, "scene-plans", `${stem}.json`);
      writeFileSync(stagedPlan, `${JSON.stringify(singlePlan, null, 2)}\n`, "utf8");
      scenes.push({
        scene: stem,
        startMs: entry.startMs,
        endMs: entry.endMs,
        durationMs: sceneMs,
        sampleRate: rate,
        wav: path.join(outDir, `${stem}.wav`),
        sizeBytes,
        plan: path.join(outDir, "scene-plans", `${stem}.json`),
      });
    }
    unlinkSync(decodedFile);
    renameSync(stagingDir, outDir);
  } finally {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
  }
  return { ok: true, outDir, sceneCount: scenes.length, sourceAssetMaxBytes: maxBytes, decodedMasterOnce: true, sampleRate: rate, scenes };
}

/** Persist the full approved film before the first paid member. The journal is
 * written before the declaration call, so an uncertain reply reuses its key. */
export async function ensureProductionRenderRequest({ledgerFile, projectId, members, call=mcpCall}) {
  let ledger=loadLedger(ledgerFile);
  const readiness=ledger.generation?.renderRequests, saved=ledger.renderRequest;
  const validBinding=b=>isRecord(b)&&/^pcr_[a-f0-9]{64}$/.test(b.requestId??"")&&typeof b.memberKey==="string"&&
    /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,119}$/.test(b.memberKey)&&
    (b.previousExecutionId===undefined||/^pqr_[a-f0-9]{64}$/.test(b.previousExecutionId));
  const canonicalMember=m=>({key:m.key,seconds:m.seconds,resolution:m.resolution,audio:m.audio,visual:m.visual,
    ...(m.source!==undefined?{source:m.source}:{})});
  const shape=list=>stableJson(list.map(m=>({key:m.key,seconds:m.seconds,resolution:m.resolution,audio:m.audio,visual:m.visual})));
  const baseBinding=(requestId,m)=>m.source??{requestId,memberKey:m.key};
  const sameBinding=(a,b)=>a.requestId===b.requestId&&a.memberKey===b.memberKey;
  const records=new Map();
  const existing=new Map();
  for(const member of members) {
    const entry=ledger.scenes[member.key];
    if(!entry||entry.projectId!==projectId)throw new Error("A request member has no matching prepared project.");
    const binding=entry.customerRequest??entry.generation?.submission?.customerRequest;
    if(binding!==undefined) {
      if(!validBinding(binding))throw new Error("Invalid original member binding; preserve this ledger for recovery.");
      if(entry.customerRequest&&entry.generation?.submission&&stableJson(entry.generation.submission.customerRequest)!==stableJson(binding))
        throw new Error("An existing submission does not match its original member. Preserve its key for recovery.");
      existing.set(member.key,binding);
    }
  }
  if(!saved && !existing.size && (!readiness || readiness.mode==="legacy")) return null;
  let request={projectId,kind:"film",members};
  const sceneSnapshot=stableJson(members.map(m=>ledger.scenes[m.key]));
  const assertUnchanged=journal=>{
    const current=loadLedger(ledgerFile);
    if(stableJson(current.renderRequest)!==stableJson(journal)||stableJson(members.map(m=>current.scenes[m.key]))!==sceneSnapshot)
      throw new Error("The request journal or scenes changed during recovery. Serialize writers before continuing.");
    return current;
  };
  const validateRecord=record=>{
    if(!/^pcr_[a-f0-9]{64}$/.test(record?.id??"")||record.projectId!==projectId||!["scene","batch","film"].includes(record.kind)||
      !Number.isSafeInteger(record.acceptedAt)||record.acceptedAt<0||!Array.isArray(record.members)||
      record.members.some((m,i)=>m.position!==i||(m.source!==undefined&&(!validBinding(m.source)||m.source.previousExecutionId!==undefined))))
      throw new Error("The server did not confirm the original complete film request. Preserve the journal; no new paid work was sent.");
    return record;
  };
  if(saved) {
    if(saved.request?.projectId!==projectId||saved.request.kind!=="film"||!Array.isArray(saved.request.members)||shape(saved.request.members)!==shape(members))
      throw new Error("The tracked film membership changed. Preserve this ledger and recover its original request; do not replace its identity.");
    request=saved.request;
  } else {
    // Read the original owned members before journaling a composite. Never attach
    // paid history solely by a scene label, provider job number or timestamps.
    for(const binding of existing.values()) if(!records.has(binding.requestId)) {
      const response=await call(ledger,"slopcannon_get_render_request",{requestId:binding.requestId});
      const record=validateRecord(response.request??response);
      if(record.id!==binding.requestId)throw new Error("The original member request changed during recovery.");
      records.set(record.id,record);assertUnchanged(saved);
    }
    for(const member of members) {
      const binding=existing.get(member.key);if(!binding)continue;
      const observed=records.get(binding.requestId).members.find(m=>m.key===binding.memberKey);
      const entry=ledger.scenes[member.key];
      if(!observed||(entry.generation?.id&&observed.generationId!==entry.generation.id))
        throw new Error("The original scene does not match this generation receipt. Recover the exact generation first.");
    }
    let recovered=null;
    for(const record of records.values()) if(record.kind==="film"&&shape(record.members)===shape(members)&&members.every((m,i)=>
      !existing.has(m.key)||sameBinding(existing.get(m.key),baseBinding(record.id,record.members[i])))) { recovered=record;break; }
    if(recovered)request={projectId,kind:"film",members:recovered.members.map(canonicalMember)};
    else {
      request={projectId,kind:"film",members:members.map(member=>{
        const binding=existing.get(member.key);if(!binding)return member;
        const original=records.get(binding.requestId).members.find(m=>m.key===binding.memberKey);
        if(!original||original.source!==undefined||shape([{...original,key:member.key}])!==shape([member]))
          throw new Error("An original scene has a different cohort or is not a direct member. Recover it before composition.");
        const entry=ledger.scenes[member.key];
        if(entry.generation?.id&&original.generationId!==entry.generation.id)
          throw new Error("The original scene does not match this generation receipt. Recover the exact generation first.");
        return {...member,source:{requestId:binding.requestId,memberKey:binding.memberKey}};
      })};
    }
    if(!recovered&&(readiness?.mode!=="queue"||readiness.boundSubmissionReady!==true||readiness.declarationReady===false))
      throw new Error("Queue request tracking is not ready. No film members were submitted.");
    if(members.some(m=>!existing.has(m.key)&&(ledger.scenes[m.key]?.generation?.key||ledger.scenes[m.key]?.generation?.id)))
      throw new Error("This film already has unbound paid work. Recover the existing ledger; it needs a reviewed import before queue tracking can be attached.");
    ledger=assertUnchanged(saved);
    ledger.renderRequest={request,idempotencyKey:newKey("film"),id:recovered?.id??null,acceptedAt:recovered?.acceptedAt??null};
    saveLedger(ledgerFile,ledger);
  }
  const journal=ledger.renderRequest;
  const response=journal.id
    ? await call(ledger,"slopcannon_get_render_request",{requestId:journal.id})
    : await call(ledger,"slopcannon_create_render_request",{...request,idempotencyKey:journal.idempotencyKey});
  const record=validateRecord(response.request??response);
  if(record.kind!=="film"||stableJson(record.members.map(canonicalMember))!==stableJson(request.members)||
      (journal.id&&(journal.id!==record.id||journal.acceptedAt!==record.acceptedAt)))
    throw new Error("The server did not confirm the original complete film request. Preserve the journal; no new paid work was sent.");
  // A failed declaration never installs partial member bindings; concurrent
  // scene changes are preserved rather than overwritten after the read.
  const current=assertUnchanged(journal);
  current.renderRequest={...journal,id:record.id,acceptedAt:record.acceptedAt};
  for(const [index,member] of request.members.entries()) {
    const entry=current.scenes[member.key], prior=existing.get(member.key);
    const binding={...baseBinding(record.id,member),...(prior?.previousExecutionId?{previousExecutionId:prior.previousExecutionId}:{})};
    if(prior&&!sameBinding(prior,binding))throw new Error("A scene is already bound to another request.");
    if(entry.generation?.id&&record.members[index].generationId!==entry.generation.id)
      throw new Error("The tracked member no longer matches this saved generation. Recover its original receipt before continuing.");
    if(binding.previousExecutionId) {
      const observed=record.members[index];
      const waiting=observed.executionId===binding.previousExecutionId&&observed.retryable===true;
      const ownSubmission=observed.previousExecutionId===binding.previousExecutionId&&entry.generation?.key&&
        (!entry.generation.id||observed.generationId===entry.generation.id);
      if(!waiting&&!ownSubmission)throw new Error("The retry predecessor changed or is no longer retryable. Recover the existing generation before any new purchase.");
    }
    if(entry.generation?.submission&&stableJson(entry.generation.submission.customerRequest)!==stableJson(binding))throw new Error("An existing submission does not match the tracked request. Recover it without replacing its key.");
    entry.customerRequest=binding;
  }
  saveLedger(ledgerFile,current);
  return {id:record.id,acceptedAt:record.acceptedAt,memberCount:record.members.length};
}

export function productionRequestMembers(sceneIds, prepDir, cast) {
  return sceneIds.map(key=>{
    const plan=JSON.parse(readFileSync(path.join(prepDir,"scene-plans",`${key}.json`),"utf8"));
    if(!Array.isArray(plan.scenes)||plan.scenes.length!==1) throw new Error("Each tracked member must have one prepared scene.");
    const requested=plan.scenes[0];
    return {key,seconds:Math.ceil((requested.endMs-requested.startMs)/1000),resolution:"2K",audio:true,visual:referencedCastForPlan(cast,plan).length>0};
  });
}

// ---------------------------------------------------------------- verbs: quote → content

async function verbQuote(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const entry = scene(ledger, id);
  if (!entry.projectId) throw new Error(`Scene ${id} has no project.`);
  if (entry.generation?.key || entry.generation?.id) throw new Error(`Scene ${id} already has a submission. Use recover/poll/content; a replacement quote must use a new scene revision.`);
  const plan = JSON.parse(readFileSync(path.resolve(need(options, "--plan")), "utf8"));
  const maximum = ledger.generation?.maximumScenesPerQuote;
  if (maximum && plan.scenes.length > maximum) throw new Error(`This origin accepts ${maximum} scene(s) per quote; the plan has ${plan.scenes.length}.`);
  const cast = JSON.parse(readFileSync(path.resolve(need(options, "--cast")), "utf8"));
  // A staged retry buys the same member again, so it keeps the shape that member was declared with: its length and
  // whether it shows cast pictures. The server refuses anything else; say why before quoting.
  const retryOf = entry.customerRequest?.previousExecutionId ? declaredMember(ledger, id, entry.customerRequest) : null;
  if (retryOf && plan.scenes?.length === 1 && outputShape(retryOf) !== outputShape(rerollMember(plan, cast, retryOf.key))) {
    throw new Error(`Scene ${id} is staged as a retry of its failed take, and a retry keeps the shape its film declared (${retryOf.seconds} s, ${retryOf.visual ? "with" : "without"} cast pictures). The cast or pictures changed: start a new revision (a new work directory and --ledger) rather than retrying. No quote was requested.`);
  }
  const song = entry.assets.song;
  if (!song) throw new Error(`Scene ${id} has no uploaded song asset (label "song").`);
  const members = referencedCastForPlan(cast, plan).map((member) => {
    const asset = entry.assets[member.label];
    if (!asset) throw new Error(`Cast ${member.name} references label "${member.label}", which is not uploaded for scene ${id}.`);
    const kinds = castAssetKinds(member);
    if (!kinds.includes(asset.kind)) throw new Error(`Cast ${member.name} must be a ${kinds.join(" or ")} asset; ${asset.kind} is not quotable.`);
    // the kind travels only when the cast file gives one, so a cast without kinds quotes exactly as before
    return { id: member.id, name: member.name, referenceAssetId: asset.id, ...(member.kind ? { kind: member.kind } : {}) };
  });
  const sourceAudioAssetId = options.get("--source-audio-asset") ?? entry.sceneAudioAssetId ?? null;
  if (sourceAudioAssetId) {
    if (ledger.generation && ledger.generation.sourceAudioAssetIdAccepted !== true) {
      throw new Error("This origin does not accept a scene audio asset on a quote.");
    }
    plan.scenes = plan.scenes.map((sceneEntry) => ({ ...sceneEntry, sourceAudioAssetId }));
  }
  const aspectRatio = options.get("--aspect") ?? "16:9";
  const bible = options.get("--bible") ? readFileSync(path.resolve(options.get("--bible")), "utf8").trim() : null;
  const params = { schemaVersion: "1.0", projectId: entry.projectId, songAssetId: song.id, cast: members, timedPlan: plan, output: { resolution: "2K", aspectRatio, container: "mp4" } };
  if (bible !== null) params.creativeBible = bible;
  const result = await mcpCall(ledger, "slopcannon_create_quote", params);
  const quote = result.quote ?? result;
  const total = quote.price.customerTotal;
  // The output shape and look a take was bought with, so a later reroll of the scene matches the film (verbReroll).
  entry.quote = { id: quote.id, amountUnits: total.amountUnits, currency: total.currency, creditUnit: total.creditUnit, expiresAt: quote.expiresAt, lineItems: quote.price.lineItems ?? null,
    aspectRatio, bibleSha256: bible !== null ? sha256(bible) : null };
  note(entry, "quote", `${quote.id} ${total.amountUnits} ${total.creditUnit} expires ${quote.expiresAt}`);
  saveLedger(ledgerFile, ledger, id);
  return { ok: true, scene: id, quoteId: quote.id, amountUnits: total.amountUnits, currency: total.currency, creditUnit: total.creditUnit, cannonCredits: total.amountUnits, expiresAt: quote.expiresAt, lineItems: entry.quote.lineItems };
}

async function verbSubmit(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const entry = scene(ledger, id);
  if (!entry.quote) throw new Error(`Scene ${id} has no quote.`);
  if (entry.quote.currency !== "CANNON_CREDIT" || entry.quote.creditUnit !== "cannon-credit") {
    throw new Error(`Scene ${id} has a legacy quote in ${entry.quote.creditUnit}. Request a fresh Cannon Credit quote before submitting.`);
  }
  const approved = Number(need(options, "--approve-units"));
  if (approved !== entry.quote.amountUnits) throw new Error(`--approve-units ${approved} does not equal the quoted ${entry.quote.amountUnits}. Refusing to submit.`);
  // A generation the server has moved on is answered from the ledger. One still `accepted` was claimed but never
  // confirmed in the queue: its frozen submission is sent again under the same key, which recovers or settles it.
  if (entry.generation?.id && !["accepted", "reserving_funds"].includes(entry.generation.status)) {
    return { ok: true, scene: id, generationId: entry.generation.id, status: entry.generation.status, replayed: true };
  }
  if (ledger.spendCapCredits !== undefined && !entry.generation?.key) {
    const exposure = productionSpend(ledger, [entry.quote], ledger.spendCapCredits);
    if (!exposure.withinLimit) throw new Error(`This submission would exceed the production ceiling (${exposure.exposureCredits} > ${exposure.limitCredits} Cannon Credits). No paid request was sent.`);
  }
  if(ledger.renderRequest && !entry.customerRequest) throw new Error("Recover the film request before submitting this member.");
  if(entry.customerRequest && !entry.generation?.key && ledger.generation?.renderRequests?.boundSubmissionReady!==true)
    throw new Error("Queued submission is not ready. Preserve the bound request and resume when intake is available.");
  if(entry.customerRequest?.previousExecutionId && !entry.generation?.key && ledger.generation?.renderRequests?.memberRetryReady!==true)
    throw new Error("Customer retry admission is not ready. Preserve the staged predecessor and resume when available.");
  const key = entry.generation?.key ?? newKey("gen");
  const proposedSubmission = {
    schemaVersion: "1.0",
    quoteId: entry.quote.id,
    approval: { amountUnits: entry.quote.amountUnits, currency: entry.quote.currency, creditUnit: entry.quote.creditUnit },
    idempotencyKey: key,
    clientReference: options.get("--reference") ?? `scene ${id}`,
    ...(entry.customerRequest?{customerRequest:entry.customerRequest}:{}),
  };
  const submission = entry.generation?.submission ?? proposedSubmission;
  if (submission.quoteId !== entry.quote.id || stableJson(submission.approval) !== stableJson(proposedSubmission.approval) || stableJson(submission.customerRequest) !== stableJson(proposedSubmission.customerRequest)) {
    throw new Error("This scene has an unresolved submission with different quote terms. Recover the original attempt; do not replace its quote or key.");
  }
  entry.generation = { id: entry.generation?.id ?? null, key, status: "submitting", quoteId: entry.quote.id, submission };
  saveLedger(ledgerFile, ledger, id);
  let result;
  try {
    result = await mcpCall(ledger, "slopcannon_submit_generation", submission);
  } catch (error) {
    // A refusal names the generation it ended (failed, nothing held); keep that receipt with the key.
    const refused = error?.details?.generation;
    if (refused?.id && refused.quoteId === entry.quote.id && typeof refused.status === "string") {
      entry.generation = { ...entry.generation, id: refused.id, status: refused.status, errorCode: refused.errorCode ?? null, recoveryUrl: refused.recoveryUrl ?? null };
    }
    note(entry, "submit", `ambiguous or failed: ${error.message}; key retained for recovery`);
    saveLedger(ledgerFile, ledger, id);
    throw error;
  }
  const generation = result.generation ?? result;
  entry.generation = { id: generation.id, key, status: generation.status, quoteId: entry.quote.id, submission, recoveryUrl: generation.recoveryUrl ?? null };
  note(entry, "submit", `${generation.id} ${generation.status}`);
  saveLedger(ledgerFile, ledger, id);
  return { ok: true, scene: id, generationId: generation.id, status: generation.status, replayed: result.replayed === true };
}

// submission_unknown is not here: the server resolves it by itself, so `poll` keeps polling it (bounded by --timeout).
const TERMINAL = new Set(["succeeded", "failed", "billing_unknown"]);

async function verbRecover(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const entry = scene(ledger, id);
  if (!entry.generation?.key) throw new Error(`Scene ${id} has no stored submission key.`);
  const result = await mcpCall(ledger, "slopcannon_recover_generation", { idempotencyKey: entry.generation.key });
  const generation = result.generation ?? result;
  if (!generation?.id || generation.quoteId !== entry.generation.quoteId) throw new Error("Recovered generation does not match the original quote; no local state changed.");
  entry.generation = { ...entry.generation, id: generation.id, status: generation.status, errorCode: generation.errorCode ?? null, recoveryUrl: generation.recoveryUrl ?? null };
  note(entry, "recovery", `${generation.id} ${generation.status}; no submission`);
  saveLedger(ledgerFile, ledger, id);
  return { ok: true, scene: id, generationId: generation.id, status: generation.status, replayed: true };
}

/** The output shape this ledger journaled for a bound member (the film request's own member, one composed from it,
 * or a scene's own request), or null when the ledger does not hold it; the server checks it either way. */
export function declaredMember(ledger, sceneId, binding) {
  const film = ledger.renderRequest;
  const members = Array.isArray(film?.request?.members) ? film.request.members : [];
  const fromFilm = members.find((m) => (film.id === binding.requestId && m.key === binding.memberKey && m.source === undefined)
    || (m.source?.requestId === binding.requestId && m.source?.memberKey === binding.memberKey));
  if (fromFilm) return fromFilm;
  const own = ledger.scenes[sceneId]?.sceneRequest;
  const single = own?.id === binding.requestId ? own.request?.members?.[0] : null;
  return single?.key === binding.memberKey ? single : null;
}

function verbRetryFailed(options, ledgerFile) {
  return stageFailedSceneRetry({ledgerFile,sceneId:need(options,"--scene")});
}

/** Read-only verification precedes one atomic ledger save. A staged retry never
 * submits work; quote approval and the server's predecessor CAS gate purchase. */
export async function stageFailedSceneRetry({ledgerFile,sceneId,call=mcpCall}) {
  const ledger=loadLedger(ledgerFile),entry=scene(ledger,sceneId);
  const stagedResult={ok:false,needs:"approval",scene:sceneId,message:"Only this failed scene is staged for a fresh quote and approval. Prior attempts and their budget exposure remain. A retry keeps the scene's declared length and cast pictures; a changed cast or pictures is a new revision. No new paid job was submitted."};
  if(!entry.generation && entry.retryStagedFrom && entry.customerRequest?.previousExecutionId===entry.retryStagedFrom.executionId &&
    entry.attempts?.at(-1)?.id===entry.retryStagedFrom.generationId) return stagedResult;
  // re-staged after a submission the queue never admitted: the binding is the one that attempt carried
  if(!entry.generation && entry.customerRequest && entry.attempts?.at(-1)?.status==="failed" && entry.attempts.at(-1).neverAdmitted===true &&
    stableJson(entry.attempts.at(-1).submission?.customerRequest)===stableJson(entry.customerRequest)) return stagedResult;
  if (!entry.generation?.id || entry.generation.status !== "failed") throw new Error("Only a confirmed failed generation may be staged for retry. Recover or poll pending/unknown submissions; they must never be replaced.");
  if (!entry.generation.submission?.approval) throw new Error("This legacy attempt has no frozen debit. Reconcile its cost before authorizing a new attempt.");
  const original=stableJson(entry),journal=stableJson(ledger.renderRequest);
  const binding=entry.customerRequest??entry.generation.submission.customerRequest;
  let retryBinding=null,predecessor=null;
  if(binding) {
    if(stableJson(entry.generation.submission.customerRequest)!==stableJson(binding)) throw new Error("The failed submission and saved member binding disagree. Preserve the ledger for recovery.");
    const response=await call(ledger,"slopcannon_get_render_request",{requestId:binding.requestId});
    const record=response.request??response,member=record?.members?.find(m=>m.key===binding.memberKey);
    const filmMember=ledger.renderRequest?.request?.members?.find(m=>m.key===sceneId);
    const compositeSource=filmMember?.source?.requestId===binding.requestId&&filmMember.source.memberKey===binding.memberKey;
    const sameScope=record?.id===binding.requestId && record.projectId===entry.projectId &&
      !(ledger.renderRequest && !compositeSource && (ledger.renderRequest.id!==record.id||ledger.renderRequest.acceptedAt!==record.acceptedAt));
    // A failed submission the queue never admitted (refused, or ended once its quote lapsed) left the member exactly as
    // it was: still waiting on the same settled predecessor, or never submitted. It is staged again with that binding.
    const neverAdmitted=sameScope && member && member.generationId!==entry.generation.id && (binding.previousExecutionId
      ? member.executionId===binding.previousExecutionId && member.retryable===true && member.usableAt===null
      : member.executionId===null && member.admission==="not_submitted");
    if(neverAdmitted) {
      retryBinding={...binding};
      predecessor=entry.retryStagedFrom??null;
    } else if(!sameScope ||
      !member || member.generationId!==entry.generation.id || member.retryable!==true ||
      !/^pqr_[a-f0-9]{64}$/.test(member.executionId??"") || !Number.isSafeInteger(member.revision) || member.revision<0 ||
      !Number.isSafeInteger(member.closedAt) || member.closedAt<0 || !member.failureCode || member.usableAt!==null)
      throw new Error("The server has not confirmed this exact member as a settled retryable failure. Keep the existing generation for recovery.");
    else {
      retryBinding={requestId:binding.requestId,memberKey:binding.memberKey,previousExecutionId:member.executionId};
      predecessor={executionId:member.executionId,generationId:entry.generation.id,revision:member.revision};
    }
    if(neverAdmitted) entry.generation={...entry.generation,neverAdmitted:true};
  }
  const current=loadLedger(ledgerFile);
  if(stableJson(current.scenes[sceneId])!==original || stableJson(current.renderRequest)!==journal)
    throw new Error("The scene or film journal changed during retry verification. Serialize writers and recover before continuing.");
  entry.attempts??=[];
  entry.attempts.push({...entry.generation,archivedAt:new Date().toISOString()});
  if(retryBinding){entry.customerRequest=retryBinding;if(predecessor)entry.retryStagedFrom=predecessor;else delete entry.retryStagedFrom;}
  delete entry.generation;delete entry.quote;delete entry.downloaded;delete entry.artifact;
  note(entry,"retry-staged","Explicit failed-scene retry; a fresh quote and approval are required. Prior exposure remains in the budget.");
  current.scenes[sceneId]=entry;saveLedger(ledgerFile,current,sceneId);
  return stagedResult;
}

// ---------------------------------------------------------------- verbs: reroll + cut

const MAX_TAKE_DIRECTION = 600;
const MAX_SCENE_TEXT = 4_000;

/** A reroll's one-scene plan: the same window, cast and scene audio, with the new direction after the scene text. */
export function rerollPlan(plan, direction) {
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.scenes) || plan.scenes.length !== 1 || typeof plan.scenes[0]?.beat !== "string") {
    throw new Error("--plan must be the scene's own one-scene plan (scene-plans/<scene>.json from prepare or run).");
  }
  const revised = structuredClone(plan);
  if (direction === null || direction === undefined) return revised;
  const text = String(direction).trim().replace(/\s+/g, " ");
  if (!text || text.length > MAX_TAKE_DIRECTION) throw new Error(`--direction must be 1-${MAX_TAKE_DIRECTION} characters.`);
  const beat = `${revised.scenes[0].beat.trim()}\nDirection for this take: ${text}`;
  if (beat.length > MAX_SCENE_TEXT) throw new Error(`The scene text plus --direction is over ${MAX_SCENE_TEXT} characters. Shorten the direction or edit the plan.`);
  revised.scenes[0].beat = beat;
  return revised;
}

/** The output shape a reroll declares: the same shape `run` declares for the scene it replaces. */
export function rerollMember(plan, cast, key) {
  const requested = plan.scenes[0];
  return { key, seconds: Math.ceil((requested.endMs - requested.startMs) / 1000), resolution: "2K", audio: true, visual: referencedCastForPlan(cast, plan).length > 0 };
}

const outputShape = (member) => stableJson({ seconds: member.seconds, resolution: member.resolution, audio: member.audio, visual: member.visual });

/**
 * The reroll to continue for a scene, or null when the next one is new. A reroll that is quoted, running or
 * unresolved is always continued (an unknown outcome is never replaced); one that finished or failed is history.
 */
export function openReroll(ledger, root, identity = null) {
  const checkable = (ledger.generation?.mcpTools ?? []).includes("slopcannon_check_take");
  const takes = Object.entries(ledger.scenes).filter(([, entry]) => entry?.rerollOf === root)
    .map(([id, entry]) => ({ id, entry, n: Number(/\.r(\d+)$/.exec(id)?.[1] ?? 0) })).sort((a, b) => a.n - b.n);
  const latest = takes.at(-1);
  const next = `${root}.r${(latest?.n ?? 0) + 1}`;
  if (!latest) return { id: next, open: false };
  const status = latest.entry.generation?.status;
  if (status === "failed") return { id: next, open: false };
  // A delivered take is finished once downloaded. One the origin could check but has no stored check is continued
  // only by a call for that same take (to finish its check); any other call opens the next take, so a scene whose
  // take can never be checked (no references) can still be rerolled again.
  if (status === "succeeded" && latest.entry.downloaded) {
    const unchecked = checkable && !latest.entry.shotCheck;
    return unchecked && identity !== null && latest.entry.reroll?.plan === identity ? { id: latest.id, open: true } : { id: next, open: false };
  }
  return { id: latest.id, open: true };
}

/**
 * Declare a reroll as its own one-member scene request when the film is tracked, so the new purchase is bound to
 * a new member and the original film and its successful scene stay as they were (hosted-api.md, creative rerolls).
 * The key is saved before the call; a lost reply replays it. An untracked film's reroll is untracked too.
 */
export async function ensureRerollRequest({ ledgerFile, sceneId, member, call = mcpCall }) {
  const ledger = loadLedger(ledgerFile);
  const entry = ledger.scenes[sceneId];
  const root = entry?.rerollOf ? ledger.scenes[entry.rerollOf] : null;
  if (!entry || !root) throw new Error("A reroll needs the scene it replaces in this ledger.");
  const readiness = ledger.generation?.renderRequests;
  // Only a tracked film's reroll is tracked: an untracked film's reroll stays untracked so its cut can assemble.
  const tracked = Boolean(ledger.renderRequest || root.customerRequest || root.generation?.submission?.customerRequest
    || entry.sceneRequest || entry.customerRequest);
  if (!tracked) return null;
  let journal = entry.sceneRequest;
  const sameMember = (a, b) => a?.key === b.key && outputShape(a) === outputShape(b) && a.source === undefined;
  if (journal && (journal.request?.projectId !== entry.projectId || journal.request.kind !== "scene"
      || journal.request.members?.length !== 1 || !sameMember(journal.request.members[0], member))) {
    if (entry.generation?.key || entry.generation?.id) throw new Error(`${sceneId} was submitted with another output shape. Finish or recover it; a new reroll takes the new shape.`);
    // Not purchased yet: the earlier declaration is left unused and the reroll is declared again.
    journal = null;
    delete entry.customerRequest;
  }
  if (journal?.id && entry.customerRequest?.requestId === journal.id) return { id: journal.id, acceptedAt: journal.acceptedAt };
  if (!journal) {
    if (readiness?.mode !== "queue" || readiness.boundSubmissionReady !== true || readiness.declarationReady === false) {
      throw new Error("Queue request tracking is not ready, so this tracked film cannot take a reroll yet. Nothing was declared or submitted.");
    }
    journal = { request: { projectId: entry.projectId, kind: "scene", members: [member] }, idempotencyKey: newKey("reroll"), id: null, acceptedAt: null };
    entry.sceneRequest = journal;
    saveLedger(ledgerFile, ledger, sceneId);
  }
  const response = journal.id
    ? await call(ledger, "slopcannon_get_render_request", { requestId: journal.id })
    : await call(ledger, "slopcannon_create_render_request", { ...journal.request, idempotencyKey: journal.idempotencyKey });
  const record = response?.request ?? response;
  if (!/^pcr_[a-f0-9]{64}$/.test(record?.id ?? "") || record.projectId !== entry.projectId || record.kind !== "scene"
      || !Number.isSafeInteger(record.acceptedAt) || record.acceptedAt < 0 || !Array.isArray(record.members) || record.members.length !== 1
      || record.members[0].position !== 0 || !sameMember(record.members[0], journal.request.members[0])
      || (journal.id && (record.id !== journal.id || record.acceptedAt !== journal.acceptedAt))) {
    throw new Error("The server did not confirm this reroll's scene request. Keep the ledger; nothing was submitted.");
  }
  const current = loadLedger(ledgerFile);
  const saved = current.scenes[sceneId];
  if (stableJson(saved?.sceneRequest) !== stableJson(journal)) throw new Error("The reroll changed during its declaration. Serialize writers and retry.");
  saved.sceneRequest = { ...journal, id: record.id, acceptedAt: record.acceptedAt };
  saved.customerRequest = { requestId: record.id, memberKey: member.key };
  note(saved, "request", `scene request ${record.id}`);
  saveLedger(ledgerFile, current, sceneId);
  return { id: record.id, acceptedAt: record.acceptedAt };
}

/**
 * A new take of one delivered scene. The first call opens the take as a new ledger scene (`<scene>.r<n>`, same
 * project, references and scene audio), declares it when the film is tracked and quotes it: nothing is spent.
 * Called again with the exact quote as --approve-units, it submits, waits, downloads and checks the take.
 * The scene's own take, the film and every other scene stay as they were; `cut` assembles a film with the new take.
 */
async function verbReroll(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const from = ledger.scenes[id];
  if (!from) throw new Error(`Scene ${id} is not in this ledger.`);
  const root = from.rerollOf ?? id;
  const original = ledger.scenes[root];
  const status = from.generation?.status;
  if (!from.generation?.id) throw new Error(`Scene ${id} has no delivered take to reroll. Quote and submit its first take instead.`);
  if (status === "failed") throw new Error(`Scene ${id} failed. Use retry-failed --scene ${id}; a reroll replaces a take that was delivered.`);
  if (status !== "succeeded") throw new Error(`Scene ${id} is ${status}. Poll it until it finishes; a running or unknown job is never replaced.`);
  if (!original?.projectId || original.rerollOf) throw new Error(`Scene ${root} is missing its project in this ledger.`);
  const cast = JSON.parse(readFileSync(path.resolve(need(options, "--cast")), "utf8"));
  const plan = rerollPlan(JSON.parse(readFileSync(path.resolve(need(options, "--plan")), "utf8")), options.get("--direction"));
  const audioId = plan.scenes[0].sourceAudioAssetId;
  if (original.sceneAudioAssetId && audioId && audioId !== original.sceneAudioAssetId) {
    throw new Error(`--plan is cut from other scene audio than scene ${root}. Use ${root}'s own scene plan.`);
  }
  // The take must have the film's shape and look: its aspect ratio (a take of another size cannot be cut in) and
  // creative bible, as the scene's own quote recorded them.
  const filmQuote = original.quote ?? {};
  const aspectRatio = options.get("--aspect") ?? filmQuote.aspectRatio ?? null;
  if (!aspectRatio) throw new Error(`Scene ${root}'s quote does not record its aspect ratio. Pass --aspect with the film's ratio (21:9, 16:9, 4:3, 1:1, 3:4 or 9:16) so the new take matches the others.`);
  if (filmQuote.aspectRatio && aspectRatio !== filmQuote.aspectRatio) throw new Error(`The film was quoted at ${filmQuote.aspectRatio}; a ${aspectRatio} take could not be cut into it.`);
  const bibleFile = options.get("--bible") ? path.resolve(options.get("--bible")) : null;
  const bible = bibleFile ? readFileSync(bibleFile, "utf8").trim() : "";
  const bibleSha256 = bibleFile ? sha256(bible) : null;
  if (Object.hasOwn(filmQuote, "bibleSha256") && filmQuote.bibleSha256 !== bibleSha256) {
    throw new Error(filmQuote.bibleSha256
      ? `Scene ${root} was quoted with a creative bible. Pass the same file with --bible so the new take keeps the film's look.`
      : `Scene ${root} was quoted without a creative bible. Leave out --bible so the new take keeps the film's look.`);
  }
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  // what the quote is for: changing any of it before approval quotes the take again
  const planDigest = sha256(stableJson({ plan: planText, aspectRatio, bibleSha256, cast }));
  const { id: takeId, open } = openReroll(ledger, root, planDigest);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(takeId)) throw new Error(`The reroll id ${takeId} is too long; use shorter scene ids.`);
  let take = ledger.scenes[takeId];
  if (!take) {
    take = ledger.scenes[takeId] = {
      projectId: original.projectId, assets: { ...original.assets },
      ...(original.sceneAudioAssetId ? { sceneAudioAssetId: original.sceneAudioAssetId } : {}),
      rerollOf: root, reroll: { from: id, direction: options.get("--direction") ?? null, plan: planDigest }, log: [],
    };
    note(take, "reroll", `new take of ${root}${options.has("--direction") ? " with new direction" : ""}`);
  } else if (take.reroll?.plan !== planDigest) {
    if (take.generation?.key || take.generation?.id) {
      throw new Error(`${takeId} was already submitted with other scene text, cast or settings. Finish it (reroll --scene ${id} --approve-units <its quote>) before starting another.`);
    }
    take.reroll = { ...take.reroll, from: id, direction: options.get("--direction") ?? null, plan: planDigest };
    delete take.quote;
    note(take, "reroll", "scene text, cast or settings changed before submission; quoting again");
  }
  // one folder per ledger, so two ledgers in one directory never share a plan file
  const planFile = path.join(path.dirname(path.resolve(ledgerFile)), "rerolls", path.basename(ledgerFile).replace(/\.json$/i, ""), `${takeId}.json`);
  mkdirSync(path.dirname(planFile), { recursive: true });
  writeFileSync(planFile, planText, "utf8");
  saveLedger(ledgerFile, ledger, takeId);

  const request = await ensureRerollRequest({ ledgerFile, sceneId: takeId, member: rerollMember(plan, cast, takeId) });
  let current = loadLedger(ledgerFile).scenes[takeId];
  if (!current.generation?.key && !current.generation?.id) {
    const fresh = current.quote?.currency === "CANNON_CREDIT" && current.quote?.creditUnit === "cannon-credit"
      && new Date(current.quote.expiresAt) > new Date(Date.now() + 60_000);
    // An approval answers a quote the person has seen, so a quote made in this call is shown before anything is sent.
    if (!fresh) {
      const quoteOptions = new Map([["--scene", takeId], ["--plan", planFile], ["--cast", path.resolve(need(options, "--cast"))], ["--aspect", aspectRatio]]);
      if (bibleFile) quoteOptions.set("--bible", bibleFile);
      await verbQuote(quoteOptions, ledgerFile);
      current = loadLedger(ledgerFile).scenes[takeId];
    }
    if (!fresh || !options.has("--approve-units")) {
      const cap = loadLedger(ledgerFile).spendCapCredits;
      return {
        ok: false, needs: "approval", scene: takeId, rerollOf: root, resumed: open, plan: planFile,
        quoteId: current.quote.id, amountUnits: current.quote.amountUnits, cannonCredits: current.quote.amountUnits, creditUnit: current.quote.creditUnit, expiresAt: current.quote.expiresAt,
        aspectRatio, creativeBible: !bibleSha256 ? "none" : Object.hasOwn(filmQuote, "bibleSha256") ? "the film's" : "the one given (this ledger cannot confirm it is the film's)",
        ...(request ? { renderRequestId: request.id } : {}), ...(cap !== undefined ? { productionCeilingCredits: cap } : {}),
        message: (options.has("--approve-units") && !fresh ? "This quote was made just now (the earlier one expired or the scene text changed), so nothing was submitted. " : "")
          + `A reroll is a new paid generation. Show the person this quote; once they approve, run reroll again with the same --scene, --plan, --cast, --direction, --bible${filmQuote.aspectRatio ? "" : " and --aspect"} plus --approve-units ${current.quote.amountUnits}.`
          + (cap !== undefined ? " It counts toward the production ceiling with every earlier attempt; pass --max-credits with a new ceiling only if they raise it." : ""),
      };
    }
  }
  if (!current.generation?.id) {
    if (!options.has("--approve-units")) return { ok: false, needs: "recovery", scene: takeId, message: `Run recover --scene ${takeId} to find its submission without spending.` };
    // the approval is compared before anything else is saved, so a refused one leaves the ceiling as it was
    const approved = Number(options.get("--approve-units"));
    if (approved !== current.quote?.amountUnits) throw new Error(`--approve-units ${options.get("--approve-units")} does not equal the quoted ${current.quote?.amountUnits}. Refusing to submit.`);
    if (options.has("--max-credits")) {
      const latest = loadLedger(ledgerFile);
      productionSpend(latest, [], options.get("--max-credits"));
      latest.spendCapCredits = Number(options.get("--max-credits"));
      saveLedger(ledgerFile, latest);
    }
    await verbSubmit(new Map([["--scene", takeId], ["--approve-units", options.get("--approve-units")], ["--reference", `reroll of ${root}`]]), ledgerFile);
    current = loadLedger(ledgerFile).scenes[takeId];
  }
  const polled = TERMINAL.has(current.generation.status)
    ? { status: current.generation.status, errorCode: current.generation.errorCode ?? null }
    : await verbPoll(new Map([["--scene", takeId]]), ledgerFile);
  if (polled.status !== "succeeded") {
    return { ok: false, scene: takeId, rerollOf: root, status: polled.status, errorCode: polled.errorCode ?? null,
      advice: polled.status === "failed"
        ? `The reroll failed; ${root}'s own take is unchanged. Run reroll --scene ${root} again for a new take and a new quote.`
        : `Ambiguous outcome. Do not resubmit: run poll --scene ${takeId} later, then reroll again to download and check it.` };
  }
  current = loadLedger(ledgerFile).scenes[takeId];
  let downloaded = current.downloaded;
  if (!await verifiedLocalArtifact(downloaded)) {
    const outDir = original.downloaded?.path ? path.dirname(original.downloaded.path) : path.join(path.dirname(path.resolve(ledgerFile)), "clips");
    const fetched = await verbContent(new Map([["--scene", takeId], ["--out", outDir], ["--name", `${takeId}.mp4`]]), ledgerFile);
    downloaded = { path: fetched.path, sha256: fetched.sha256, bytes: fetched.bytes };
  }
  let check = null;
  if ((loadLedger(ledgerFile).generation?.mcpTools ?? []).includes("slopcannon_check_take")) {
    try { check = await checkScene(ledgerFile, takeId, { plan, cast }); } catch (error) { check = uncheckedResult(takeId, error); }
  }
  return {
    ok: true, scene: takeId, rerollOf: root, path: downloaded.path, sha256: downloaded.sha256, ...(check ? { check } : {}),
    message: `Show the person the new take${check?.verdict === "fail" ? " and each issue the check found" : ""}. To use it, run cut --plan <timed-plan.json> --takes ${root}=${takeId} --title <title> --output <film.mp4>; ${root}'s first take stays available.`,
  };
}

/**
 * One take per film scene from a --takes list of scene=take swaps; every swap must be a reroll of that scene. A cut that adds an
 * end card (`endCard`) is a new film even with every original take, so it may name no swap at all.
 */
export function cutTakes(ledger, sceneIds, value, { endCard = false } = {}) {
  if (!value && endCard) return [...sceneIds];
  if (!value) throw new Error("--takes needs at least one scene=take swap, such as sc03=sc03.r1.");
  const chosen = new Map();
  for (const pair of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const parts = pair.split("=");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`--takes entry ${pair} must be scene=take.`);
    const [sceneId, takeId] = parts;
    if (!sceneIds.includes(sceneId)) throw new Error(`--takes names unknown scene ${sceneId}.`);
    if (chosen.has(sceneId)) throw new Error(`--takes names ${sceneId} twice.`);
    if (takeId !== sceneId && ledger.scenes[takeId]?.rerollOf !== sceneId) throw new Error(`${takeId} is not a reroll of ${sceneId}.`);
    chosen.set(sceneId, takeId);
  }
  if (!endCard && ![...chosen].some(([sceneId, takeId]) => sceneId !== takeId)) throw new Error("--takes changes no scene. Finish the original cut with run.");
  return sceneIds.map((sceneId) => chosen.get(sceneId) ?? sceneId);
}

/**
 * The film request of a tracked cut: a new film whose members observe the chosen takes' own members (the original
 * film's members for unchanged scenes, each reroll's scene member). It buys nothing and has its own clock; the
 * original film request stays in history. Journaled under ledger.cuts before the call.
 */
export async function ensureCutRequest({ ledgerFile, cutId, takeIds, call = mcpCall }) {
  const ledger = loadLedger(ledgerFile);
  const film = ledger.renderRequest;
  const cut = ledger.cuts?.[cutId];
  if (!cut) throw new Error("Declare the cut before its request.");
  if (!film) {
    if (takeIds.some((id) => ledger.scenes[id]?.customerRequest)) throw new Error("Recover the original film journal before cutting; tracked takes cannot join an untracked cut.");
    return null;
  }
  if (!/^pcr_[a-f0-9]{64}$/.test(film.id ?? "") || film.request?.kind !== "film" || !Array.isArray(film.request.members) || film.request.members.length !== takeIds.length) {
    throw new Error("Recover the original complete film journal before cutting.");
  }
  const members = film.request.members.map((member, index) => {
    const take = ledger.scenes[takeIds[index]];
    const binding = take?.customerRequest ?? take?.generation?.submission?.customerRequest;
    if (!binding || !/^pcr_[a-f0-9]{64}$/.test(binding.requestId ?? "") || typeof binding.memberKey !== "string") {
      throw new Error(`Take ${takeIds[index]} has no tracked request, so it cannot join this tracked film.`);
    }
    if (takeIds[index] !== member.key) {
      const declared = take.sceneRequest?.request?.members?.[0];
      if (!declared || outputShape(declared) !== outputShape(member)) {
        throw new Error(`${takeIds[index]} has a different output shape (length, resolution or cast) than ${member.key}, so it cannot take its place in the film.`);
      }
    }
    return { key: member.key, seconds: member.seconds, resolution: member.resolution, audio: member.audio, visual: member.visual,
      source: { requestId: binding.requestId, memberKey: binding.memberKey } };
  });
  let journal = cut.renderRequest;
  if (journal && stableJson(journal.request?.members) !== stableJson(members)) throw new Error("This cut's takes changed since it was declared. Preserve the ledger and start a new cut.");
  if (!journal) {
    const readiness = ledger.generation?.renderRequests;
    if (readiness?.mode !== "queue" || readiness.boundSubmissionReady !== true || readiness.declarationReady === false) {
      throw new Error("Queue request tracking is not ready, so a tracked film cannot be recut yet. Nothing was declared or assembled.");
    }
    journal = { request: { projectId: film.request.projectId, kind: "film", members }, idempotencyKey: newKey("cut"), id: null, acceptedAt: null };
    cut.renderRequest = journal;
    saveLedger(ledgerFile, ledger);
  }
  const response = journal.id
    ? await call(ledger, "slopcannon_get_render_request", { requestId: journal.id })
    : await call(ledger, "slopcannon_create_render_request", { ...journal.request, idempotencyKey: journal.idempotencyKey });
  const record = response?.request ?? response;
  const shape = (list) => stableJson(list.map((m) => ({ key: m.key, seconds: m.seconds, resolution: m.resolution, audio: m.audio, visual: m.visual, source: m.source })));
  if (!/^pcr_[a-f0-9]{64}$/.test(record?.id ?? "") || record.projectId !== film.request.projectId || record.kind !== "film"
      || !Number.isSafeInteger(record.acceptedAt) || record.acceptedAt < 0 || !Array.isArray(record.members)
      || record.members.some((m, i) => m.position !== i) || shape(record.members) !== shape(members)
      || (journal.id && (record.id !== journal.id || record.acceptedAt !== journal.acceptedAt))) {
    throw new Error("The server did not confirm this cut's film request. Keep the ledger; nothing was assembled.");
  }
  const current = loadLedger(ledgerFile);
  if (stableJson(current.cuts?.[cutId]?.renderRequest) !== stableJson(journal)) throw new Error("The cut changed during its declaration. Serialize writers and retry.");
  current.cuts[cutId].renderRequest = { ...journal, id: record.id, acceptedAt: record.acceptedAt };
  saveLedger(ledgerFile, current);
  return { id: record.id, acceptedAt: record.acceptedAt };
}

/**
 * Where an end card starts inside the last scene, from the moment in the film `--end-card-from-ms` names: the card lies over the
 * last scene only, so a moment before that scene starts (or at or past the film's end) is refused, never moved.
 */
export function endCardLocalMs(plan, filmMs) {
  const last = plan.scenes.at(-1);
  if (!Number.isSafeInteger(filmMs) || filmMs < 0) throw new Error("--end-card-from-ms must be a whole number of milliseconds into the film.");
  if (filmMs < last.startMs) {
    throw new Error(`--end-card-from-ms ${filmMs} is before the last scene, which starts at ${last.startMs} ms. An end card shows over the last scene only: choose a moment from ${last.startMs} through ${last.endMs - 1}.`);
  }
  if (filmMs >= last.endMs) throw new Error(`--end-card-from-ms ${filmMs} is at or past the end of the film (${last.endMs} ms): choose a moment from ${last.startMs} through ${last.endMs - 1}.`);
  return filmMs - last.startMs;
}

/** The --end-card file, read and checked as a PNG before anything is uploaded or declared. The renderer checks its size against the film. */
async function cutEndCard(options, plan) {
  const named = options.get("--end-card");
  if (!named) {
    if (options.has("--end-card-from-ms")) throw new Error("--end-card-from-ms needs --end-card <card.png>.");
    return null;
  }
  const file = path.resolve(named);
  const fromMs = Number(need(options, "--end-card-from-ms"));
  const fromLocalMs = endCardLocalMs(plan, fromMs);
  const header = await readPngHeader(file);
  if (!header) throw new Error(`--end-card ${file} is not a PNG image. Draw the card as a PNG at the film's exact frame size; it is never scaled.`);
  if (header.interlace !== 0) throw new Error(`--end-card ${file} is an interlaced PNG, which the renderer does not read. Save it without interlacing.`);
  const rights = need(options, "--rights");
  return { file, fromMs, fromLocalMs, rights, sha256: sha256(readFileSync(file)), dimensions: `${header.width}x${header.height}` };
}

/** Assemble the film on the server with chosen rerolls in place of some scenes, and an end card when one is named. Spends no credits. */
async function verbCut(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const plan = JSON.parse(readFileSync(path.resolve(need(options, "--plan")), "utf8"));
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.scenes) || plan.scenes.length < 1) throw new Error("--plan must be the film's whole timed plan (timed-plan.json).");
  const title = need(options, "--title");
  const output = path.resolve(need(options, "--output"));
  if (!/\.mp4$/i.test(output)) throw new Error("--output must name an .mp4 file.");
  const production = ledger.scenes.production;
  if (!production?.projectId) throw new Error("cut assembles films made with run; this ledger has no shared production project.");
  const card = await cutEndCard(options, plan);
  // the spot whose planned graphics the server draws (docs/AD_GRAPHICS.md): only the spot is named, never the words
  const graphicsSpot = options.get("--graphics") ?? null;
  if (graphicsSpot !== null && !/^audiospot_[a-f0-9]{32}$/.test(graphicsSpot)) throw new Error("--graphics must name the audio spot (audiospot_...) whose planned graphics the film draws.");
  const sceneIds = plan.scenes.map((_, index) => sceneFileStem(index + 1));
  const takeIds = cutTakes(ledger, sceneIds, options.get("--takes"), { endCard: Boolean(card || graphicsSpot) });
  const accepted = acceptedChecks(options.get("--accept-checks"), sceneIds);
  const flagged = takeIds.map((takeId, index) => ({ scene: sceneIds[index], take: takeId, check: ledger.scenes[takeId]?.shotCheck }))
    .filter(({ take, check }) => check?.verdict === "fail" && check.assetId === ledger.scenes[take]?.artifact?.assetId)
    .filter(({ scene }) => !accepted.has(scene))
    .map(({ scene, take, check }) => ({ scene, take, issues: check.issues }));
  if (flagged.length > 0) {
    return { ok: false, needs: "shot_review", flagged,
      message: "The character check flagged these takes. Show the person each issue at its second; nothing was assembled. Choose other takes, or run cut again with --accept-checks naming the scenes they accept." };
  }
  // every take is delivered and owned before anything is declared
  takeIds.forEach((takeId, index) => {
    const take = ledger.scenes[takeId];
    if (take?.projectId !== production.projectId || !take.artifact?.assetId || !take.downloaded?.sha256 || take.artifact.sha256 !== take.downloaded.sha256) {
      throw new Error(`${takeId} (scene ${sceneIds[index]}) has no verified downloaded take yet. Finish it with reroll or content first; nothing was declared.`);
    }
  });
  // one cut per set of takes, title and end card, so a repeat resumes the same assembly and a new title or card is a new cut
  const cardIdentity = { ...(card ? { endCard: { sha256: card.sha256, fromLocalMs: card.fromLocalMs } } : {}), ...(graphicsSpot ? { graphics: { spotId: graphicsSpot } } : {}) };
  const cutId = sha256(stableJson({ projectId: production.projectId, takeIds, title, ...cardIdentity })).slice(0, 24);
  const swaps = Object.fromEntries(sceneIds.map((sceneId, index) => [sceneId, takeIds[index]]).filter(([sceneId, takeId]) => sceneId !== takeId));
  // The card is uploaded to the film's project (idempotently, by its digest) before the cut is declared.
  const cardAssetId = card ? (await verbUpload(new Map([["--scene", "production"], ["--kind", "other"], ["--file", card.file],
    ["--label", `end-card-${card.sha256.slice(0, 16)}`], ["--rights", card.rights]]), ledgerFile)).assetId : null;
  if (!loadLedger(ledgerFile).cuts?.[cutId]) {
    const current = loadLedger(ledgerFile);
    current.cuts ??= {};
    current.cuts[cutId] ??= { takes: swaps, takeIds, title, ...cardIdentity, createdAt: new Date().toISOString() };
    saveLedger(ledgerFile, current);
  }
  const request = await ensureCutRequest({ ledgerFile, cutId, takeIds });
  const endCard = card ? { assetId: cardAssetId, fromLocalMs: card.fromLocalMs } : null;
  const report = await finishServerProduction({ ledgerFile, plan, title, output, cut: { id: cutId, takeIds, ...(endCard ? { endCard } : {}), ...(graphicsSpot ? { graphics: { spotId: graphicsSpot } } : {}) } });
  const unchecked = (ledger.generation?.mcpTools ?? []).includes("slopcannon_check_take") ? uncheckedTakes(loadLedger(ledgerFile), sceneIds, takeIds) : [];
  return { ...report, cut: cutId, takes: swaps, ...(request ? { cutRenderRequestId: request.id } : {}), ...(unchecked.length > 0 ? { unchecked } : {}),
    ...(card ? { endCard: { ...endCard, fromMs: card.fromMs, sha256: card.sha256, dimensions: card.dimensions } } : {}),
    ...(graphicsSpot ? { graphics: { spotId: graphicsSpot } } : {}),
    ...(report.ok ? { message: `Review the master for identity, mouth timing and take quality; sync verification does not judge those.${card ? " Check the end card's text on the last frames." : ""}${graphicsSpot ? " Check each on-screen graphic's words and placement." : ""} The original cut and its takes are unchanged.${uncheckedMessage(unchecked)}` } : {}) };
}

async function verbPoll(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const entry = scene(ledger, id);
  if (!entry.generation?.id) throw new Error(`Scene ${id} has no generation.`);
  const interval = Math.max(5, Number(options.get("--interval") ?? 20)) * 1000;
  const timeoutSeconds = Math.max(30, Number(options.get("--timeout") ?? 1800));
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const result = await mcpCall(ledger, "slopcannon_get_generation", { generationId: entry.generation.id });
    const generation = result.generation ?? result;
    if (generation.status !== entry.generation.status) note(entry, "poll", `${generation.status}${generation.errorCode ? ` ${generation.errorCode}` : ""}`);
    entry.generation.status = generation.status;
    entry.generation.errorCode = generation.errorCode ?? null;
    entry.generation.contentMetadataUrl = generation.contentMetadataUrl ?? null;
    saveLedger(ledgerFile, ledger, id);
    if (TERMINAL.has(generation.status)) {
      const out = { ok: generation.status === "succeeded", scene: id, generationId: generation.id, status: generation.status, errorCode: generation.errorCode ?? null };
      if (generation.status !== "succeeded") {
        out.advice = generation.status === "failed"
          ? "This attempt failed. Inspect its error and billing state before choosing retry-failed; a new attempt needs a fresh quote and still counts against the production ceiling."
          : "Ambiguous outcome. Do not resubmit; poll again later with the same generation id.";
      }
      return out;
    }
    if (Date.now() > deadline) {
      if (generation.status === "submission_unknown") {
        const explanation = generation.message ?? "The submission is still being confirmed with the video service; it resolves by itself and is not charged again. Never resubmit.";
        throw new Error(`Still unresolved after ${timeoutSeconds}s. ${explanation} Resume with the same generation id: poll --scene ${id} --ledger ${ledgerFile} (raise --timeout as needed).`);
      }
      throw new Error(`Timed out at ${generation.status}; poll again later with the same generation id.`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function verbContent(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const entry = scene(ledger, id);
  if (!entry.generation?.id) throw new Error(`Scene ${id} has no generation.`);
  const outDir = path.resolve(need(options, "--out"));
  const url = endpoint(ledger, "generations", "/api/v1/generations");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(entry.generation.id)}/content`;
  const { status, json, text } = await httpAuthed(url);
  if (status !== 200) throw new Error(`Content metadata returned ${status}: ${text.slice(0, 300)}`);
  const metadata = json.data ?? json;
  const artifact = metadata.artifacts?.[0];
  if (!artifact?.downloadUrl) throw new Error("Content metadata carries no artifact.");
  entry.artifact = { assetId: artifact.assetId ?? null, downloadUrl: artifact.downloadUrl, expiresAt: artifact.expiresAt, bytes: artifact.bytes ?? null, sha256: artifact.sha256 ?? null };
  saveLedger(ledgerFile, ledger, id);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const destination = path.join(outDir, options.get("--name") ?? `${id}.mp4`);
  if (path.basename(destination) !== (options.get("--name") ?? `${id}.mp4`)) throw new Error("--name must be a filename, not a path.");
  const downloadUrl = new URL(artifact.downloadUrl);
  if (downloadUrl.origin !== new URL(ledger.origin).origin || downloadUrl.username || downloadUrl.password) throw new Error("Artifact URL must stay on the authenticated API origin.");
  const response = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token(downloadUrl)}` }, redirect: "manual", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    note(entry, "content", `download ${response.status} ${body}`);
    saveLedger(ledgerFile, ledger, id);
    throw new Error(`Artifact download returned ${response.status}${body ? `: ${body}` : ""}`);
  }
  const saved = await saveArtifactResponse(response, destination, artifact);
  entry.downloaded = { path: destination, bytes: saved.bytes, sha256: saved.sha256 };
  note(entry, "content", `${destination} ${saved.bytes}B`);
  saveLedger(ledgerFile, ledger, id);
  return { ok: true, scene: id, ...saved, expiresAt: artifact.expiresAt };
}

// ---------------------------------------------------------------- verbs: manifest + assemble

export function manifestFromPlan(plan, songFile, songSha256, clipPrefix = "slopcannon-scene") {
  return {
    schemaVersion: 1,
    durationMs: plan.durationMs,
    masterAudio: { filename: path.basename(songFile), sha256: songSha256 },
    scenes: plan.scenes.map((entry, index) => {
      const sceneMs = entry.endMs - entry.startMs;
      return { id: index + 1, startMs: entry.startMs, endMs: entry.endMs, requestSeconds: Math.min(MAX_SCENE_MS / 1000, Math.max(MIN_SCENE_MS / 1000, Math.ceil(sceneMs / 1000))), clip: { filename: `${clipPrefix}-${String(index + 1).padStart(2, "0")}-take-01.mp4` } };
    }),
  };
}

async function verbManifest(options) {
  const plan = JSON.parse(readFileSync(path.resolve(need(options, "--plan")), "utf8"));
  const song = path.resolve(need(options, "--song"));
  const out = path.resolve(need(options, "--out"));
  if (existsSync(out)) throw new Error(`--out ${out} already exists.`);
  const manifest = manifestFromPlan(plan, song, (await fileDigest(song)).sha256, options.get("--clip-prefix") ?? "slopcannon-scene");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ok: true, out, sceneCount: manifest.scenes.length, clips: manifest.scenes.map((entry) => entry.clip.filename) };
}

async function verbAssemble(options) {
  const args = ["--manifest", need(options, "--manifest"), "--song", need(options, "--song"), "--clips-dir", need(options, "--clips-dir"), "--output", need(options, "--output")];
  const result = await runNode(path.join(SCRIPT_DIR, "assemble-master.mjs"), args);
  if (result.code !== 0) throw new Error(`assemble-master failed: ${(result.stderr || result.stdout).trim().slice(0, MAX_ERROR_TEXT)}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

/** Reuse only a verified master bound to these exact source/take bytes. */
export async function finishProduction({ ledgerFile, manifest, manifestFile, song, clipsDir, output, assemble = verbAssemble }) {
  const inputFingerprint = sha256(stableJson(manifest));
  const ledger = loadLedger(ledgerFile);
  const cached = ledger.assembly;
  const snapshot=current=>stableJson({productionFingerprint:current.productionFingerprint,scenes:current.scenes,
    renderRequest:current.renderRequest,assembly:current.assembly,localAssemblyReport:current.localAssemblyReport});
  const original=snapshot(ledger);
  if (cached?.inputFingerprint === inputFingerprint && cached.report?.ok === true && cached.report.fullDecodeVerified === true && await verifiedLocalArtifact(cached)) {
    return { ...cached.report, output: cached.path, alreadyAssembled: true };
  }
  if(ledger.localAssemblyReport)throw new Error("Preserve the recorded local master. Recover its uploaded bytes before attempting a new assembly.");
  // An existing movie without a matching receipt is not trusted or overwritten.
  // Rebuild only the local master from the already-paid clips under a new name.
  const destination = existsSync(output) || existsSync(`${output}.sync-report.json`)
    ? `${output.slice(0, -4)}.verified-${randomBytes(6).toString("hex")}.mp4` : output;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const report = await assemble(new Map([["--manifest", manifestFile], ["--song", song], ["--clips-dir", clipsDir], ["--output", destination]]));
  if (report.ok !== true || report.fullDecodeVerified !== true) throw new Error("The local master did not pass full decode verification; it is not marked complete.");
  const receipt = await fileDigest(destination);
  const current=loadLedger(ledgerFile);
  if(snapshot(current)!==original)throw new Error("The film changed during local assembly. The output was kept, but newer ledger state was not overwritten.");
  current.assembly = { ...receipt, path: destination, inputFingerprint, report, verifiedAt: new Date().toISOString() };
  saveLedger(ledgerFile, current);
  return { ...report, output: destination };
}

/** Upload and attribute the exact local master. Journals precede both effects;
 * recovery never rerenders, substitutes another cut or invents server verification. */
export async function reportLocalProduction({ledgerFile,manifest,plan,title,rights,call=mcpCall,fetcher=globalThis.fetch}) {
  const initial=loadLedger(ledgerFile),journal=initial.renderRequest,master=initial.assembly;
  if(!journal) {
    if(initial.localAssemblyReport || Object.values(initial.scenes).some(s=>s.customerRequest))throw new Error("Recover the original film membership before local reporting.");
    return {reported:false,reason:"untracked"};
  }
  const production=initial.scenes.production,sceneIds=plan.scenes.map((_,i)=>sceneFileStem(i+1));
  if(!/^pcr_[a-f0-9]{64}$/.test(journal.id??"") || !Number.isSafeInteger(journal.acceptedAt) || journal.acceptedAt<0 ||
    journal.request?.projectId!==production?.projectId || journal.request?.kind!=="film" || journal.request?.members?.length!==sceneIds.length ||
    journal.request.members.some((m,i)=>m.key!==sceneIds[i]) || !production.assets?.song?.id ||
    master?.report?.ok!==true || master.report.fullDecodeVerified!==true || master.inputFingerprint!==sha256(stableJson(manifest)) ||
    !/^[a-f0-9]{64}$/.test(master.sha256??"") || !Number.isSafeInteger(master.bytes) || master.bytes<=0 || !Number.isSafeInteger(Date.parse(master.verifiedAt)))
    throw new Error("Recover the exact film and verified local master before reporting.");
  const clips=plan.scenes.map((s,i)=>{
    const take=initial.scenes[sceneIds[i]],clip=manifest.scenes?.[i]?.clip;
    if(take?.projectId!==production.projectId || !take.artifact?.assetId || take.artifact.sha256!==take.downloaded?.sha256 ||
      clip?.sha256!==take.downloaded.sha256 || clip?.bytes!==take.downloaded.bytes ||
      manifest.scenes[i].startMs!==s.startMs || manifest.scenes[i].endMs!==s.endMs)
      throw new Error("The local assembly manifest does not match the selected owned takes.");
    return {assetId:take.artifact.assetId,startMs:s.startMs,endMs:s.endMs};
  });
  if(manifest.scenes.length!==sceneIds.length || manifest.durationMs!==plan.durationMs || manifest.masterAudio?.sha256!==production.assets.song.sha256)
    throw new Error("The local master manifest does not match this film's song and timeline.");
  const normalizedTitle=typeof title==="string"?title.trim().replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").slice(0,160):"";
  const assembly={projectId:production.projectId,customerRequestId:journal.id,title:normalizedTitle||"SLOPCANNON MASTER",durationMs:plan.durationMs,audioMode:"song",masterAudioAssetId:production.assets.song.id,clips};
  const plainManifest=manifestFromPlan(plan,manifest.masterAudio.filename,manifest.masterAudio.sha256);
  plainManifest.scenes.forEach((s,i)=>{s.clip.sha256=manifest.scenes[i].clip.sha256;s.clip.bytes=manifest.scenes[i].clip.bytes;});
  const renderOptionsHash=stableJson(plainManifest)===stableJson(manifest)?undefined:sha256(stableJson(manifest));
  const expectedInputHash=sha256(JSON.stringify(renderOptionsHash?{assembly,renderOptionsHash}:assembly));
  let saved=initial.localAssemblyReport;
  const facts=l=>stableJson({origin:l.origin,endpoints:l.endpoints,productionFingerprint:l.productionFingerprint,renderRequest:l.renderRequest,
    production:l.scenes.production,scenes:sceneIds.map(id=>l.scenes[id]),assembly:l.assembly});
  let expectedFacts=facts(initial),expectedReport=stableJson(saved??null);
  const current=()=>{const l=loadLedger(ledgerFile);if(facts(l)!==expectedFacts||stableJson(l.localAssemblyReport??null)!==expectedReport)
    throw new Error("The film or local receipt changed during reporting. Preserve the newer ledger and retry.");return l;};
  const save=()=>{const l=current();l.localAssemblyReport=structuredClone(saved);saveLedger(ledgerFile,l);expectedReport=stableJson(saved);};
  const film=await call(initial,"slopcannon_get_render_request",{requestId:journal.id});current();
  const owned=film.request??film,shape=ms=>ms.map(m=>({key:m.key,seconds:m.seconds,resolution:m.resolution,audio:m.audio,visual:m.visual,...(m.source?{source:m.source}:{})}));
  if(owned.id!==journal.id||owned.projectId!==production.projectId||owned.kind!=="film"||owned.acceptedAt!==journal.acceptedAt||
    !Array.isArray(owned.members)||stableJson(shape(owned.members))!==stableJson(shape(journal.request.members))||
    owned.members.some((m,i)=>m.position!==i||m.generationId!==initial.scenes[sceneIds[i]].generation?.id||!Number.isSafeInteger(m.usableAt)||m.usableAt<0))
    throw new Error("The server film does not match these delivered local scene revisions.");
  const identity=sha256(stableJson({assembly,renderOptionsHash:renderOptionsHash??null,sha256:master.sha256,bytes:master.bytes,completedAt:Date.parse(master.verifiedAt)}));
  if(saved&&saved.identity!==identity)throw new Error("The local cut or master changed. Preserve its receipt and use a new film revision.");
  const uploadUrl=endpoint(initial,"assets","/api/v1/assets");
  if(!saved) {
    if(initial.generation?.renderRequests?.localAssemblyReceiptReady!==true)throw new Error("Local assembly reporting is not ready on this origin. Keep the completed master for recovery.");
    const limit=initial.generation?.finalExportMaxBytes;
    let multipart=false;
    if(master.bytes>90*1024**2 && initial.generation?.resumableExport?.readinessEndpoint) {
      const root=endpoint(initial,"exportUploads","/api/v1/export-uploads").toString().replace(/\/$/,"");
      const ready=await readExportReadiness(fetcher,root,{redirect:"manual",signal:AbortSignal.timeout(30_000),headers:{Authorization:`Bearer ${token(root)}`}});current();
      multipart=ready.newUploads===true&&master.bytes<=ready.maxBytes;
    }
    if(!multipart && (!Number.isSafeInteger(limit)||limit<=0||master.bytes>limit))return {reported:false,reason:"upload_limit",output:master.path,
      message:"The verified local master exceeds the available upload limit, or readiness is unknown. It was preserved without re-encoding; hosted reporting remains pending."};
    if(!rights || (initial.rights?.version && rights!==initial.rights.version))throw new Error("Confirm the current rights statement before uploading the completed local master.");
    uploadUrl.search=new URLSearchParams({projectId:production.projectId,kind:"final_export",filename:path.basename(master.path)}).toString();
    saved={identity,upload:{url:uploadUrl.toString(),key:newKey("local-master"),rights},request:null};
    if(multipart) {
      const root=endpoint(initial,"exportUploads","/api/v1/export-uploads").toString().replace(/\/$/,"");
      saved.upload={...saved.upload,mode:"resumable",url:root,journal:{version:1,url:root,key:saved.upload.key,rights,
        manifest:{projectId:production.projectId,filename:path.basename(master.path),contentType:"video/mp4",sizeBytes:master.bytes,sha256:master.sha256}}};
    }
    save();
  }
  const frozenUrl=new URL(saved.upload?.url??"");
  const multipart=saved.upload.mode==="resumable",multipartRoot=endpoint(initial,"exportUploads","/api/v1/export-uploads").toString().replace(/\/$/,"");
  if((multipart ? frozenUrl.toString()!==multipartRoot||saved.upload.journal?.key!==saved.upload.key||saved.upload.journal?.rights!==saved.upload.rights :
    frozenUrl.origin!==uploadUrl.origin||frozenUrl.pathname!==uploadUrl.pathname||frozenUrl.searchParams.get("projectId")!==production.projectId||frozenUrl.searchParams.get("kind")!=="final_export")||!saved.upload.key||!saved.upload.rights)
    throw new Error("The saved local upload identity is invalid. Preserve it for recovery.");
  const asset=saved.upload.asset;
  if(asset && (asset.projectId!==production.projectId||asset.kind!=="final_export"||asset.sha256!==master.sha256||asset.sizeBytes!==master.bytes))
    throw new Error("The saved uploaded master identity does not match this local file.");
  if(!await verifiedLocalArtifact(master)) {
    if(!asset?.id)throw new Error("The original local master is missing or changed. Restore its exact bytes before replaying the upload.");
    const url=endpoint(initial,"assets","/api/v1/assets");url.pathname+=`/${encodeURIComponent(asset.id)}`;
    const response=await fetcher(url,{redirect:"manual",signal:AbortSignal.timeout(120_000),headers:{Authorization:`Bearer ${token(url)}`}});
    if(!response.ok)throw new Error(`Recovering the recorded local master returned ${response.status}. No replacement was assembled.`);
    const destination=existsSync(master.path)?`${master.path.slice(0,-4)}.recovered-${randomBytes(6).toString("hex")}.mp4`:master.path;
    await saveArtifactResponse(response,destination,{bytes:master.bytes,sha256:master.sha256},master.bytes);
    const l=current();l.assembly.path=destination;saveLedger(ledgerFile,l);master.path=destination;expectedFacts=facts(l);
  }
  current();
  if(!saved.upload.asset && multipart) {
    const expectedManifest={projectId:production.projectId,filename:saved.upload.journal.manifest.filename,contentType:"video/mp4",sizeBytes:master.bytes,sha256:master.sha256};
    const uploaded=await resumeExportUpload({journal:saved.upload.journal,url:multipartRoot,manifest:expectedManifest,
      fetch:fetcher,requestOptions:{redirect:"manual",headers:{Authorization:`Bearer ${token(multipartRoot)}`}},current,
      save:value=>{current();saved.upload.journal=value;save();},
      readPart:async(start,end)=>{
        const fd=openSync(master.path,"r");try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size!==master.bytes)throw new Error("The original master changed.");
          const bytes=Buffer.alloc(end-start);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,start+offset);if(!n)throw new Error("The original master was truncated.");offset+=n;}return bytes;
        }finally{closeSync(fd);}},hashPart:async bytes=>sha256(bytes)});
    current();saved.upload.asset=uploaded;save();
  }
  if(!saved.upload.asset) {
    const bytes=readFileSync(master.path);
    if(bytes.length!==master.bytes||sha256(bytes)!==master.sha256)throw new Error("The local master changed while opening the upload.");
    const response=await fetcher(frozenUrl,{method:"POST",redirect:"manual",signal:AbortSignal.timeout(120_000),headers:{Authorization:`Bearer ${token(frozenUrl)}`,
      "Content-Type":"video/mp4","Idempotency-Key":saved.upload.key,"x-content-sha256":master.sha256,[RIGHTS_HEADER]:saved.upload.rights},body:bytes});
    current();
    if(response.status!==200&&response.status!==201)throw new Error(`Local master upload returned ${response.status}. Keep the saved bytes and upload key.`);
    const uploaded=(await response.json()).data;
    if(typeof uploaded?.id!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(uploaded.id)||uploaded.projectId!==production.projectId||uploaded.kind!=="final_export"||uploaded.contentType!=="video/mp4"||
      uploaded.sha256!==master.sha256||uploaded.sizeBytes!==master.bytes)throw new Error("The uploaded master receipt does not match the original bytes.");
    saved.upload.asset=uploaded;save();
  }
  if(!saved.request) {
    saved.request={assembly,renderer:"ffmpeg",...(renderOptionsHash?{renderOptionsHash}:{}),outputAssetId:saved.upload.asset.id,sha256:master.sha256,sizeBytes:master.bytes,
      completedAt:Date.parse(master.verifiedAt),idempotencyKey:newKey("local-receipt")};save();
  }
  const request=saved.request;
  if(stableJson(request.assembly)!==stableJson(assembly)||request.renderer!=="ffmpeg"||request.outputAssetId!==saved.upload.asset.id||
    request.renderOptionsHash!==renderOptionsHash||
    request.sha256!==master.sha256||request.sizeBytes!==master.bytes||request.completedAt!==Date.parse(master.verifiedAt)||!request.idempotencyKey)
    throw new Error("The saved local report body changed. Preserve the original request.");
  const reported=await call(initial,"slopcannon_report_local_assembly",request);current();
  const receipt=reported.receipt;
  if(!/^pla_[a-f0-9]{64}$/.test(receipt?.id??"")||receipt.verification!=="client_reported"||receipt.renderer!=="ffmpeg"||
    receipt.inputHash!==expectedInputHash||receipt.reportedCompletedAt!==request.completedAt||!Number.isSafeInteger(receipt.recordedAt)||receipt.recordedAt<journal.acceptedAt||
    receipt.artifact?.assetId!==request.outputAssetId||receipt.artifact.sha256!==master.sha256||receipt.artifact.sizeBytes!==master.bytes||typeof receipt.artifact.available!=="boolean"||
    (saved.receipt&&stableJson({...saved.receipt,artifact:receipt.artifact})!==stableJson(receipt)))
    throw new Error("The local completion receipt did not match the saved report. Resume with its original key.");
  saved.receipt=receipt;save();
  return {reported:receipt.artifact.available===true,receipt,output:master.path,reason:receipt.artifact.available===true?"recorded":"artifact_unavailable"};
}

export async function finishLocalProduction(input) {
  const before=loadLedger(input.ledgerFile);
  const report=before.localAssemblyReport ? before.assembly?.report : await finishProduction(input);
  const completion=await reportLocalProduction(input);
  return {...report,output:completion.output??report.output??loadLedger(input.ledgerFile).assembly?.path,localCompletion:completion};
}

// ---------------------------------------------------------------- verbs: review

/** One durable server assembly attempt, recoverable after a lost response. */
export async function finishServerProduction({ ledgerFile, plan, title, output, cut = null, call = mcpCall, wait = sleep, fetcher = globalThis.fetch }) {
  const ledger = loadLedger(ledgerFile);
  const production = ledger.scenes.production;
  if (!production?.projectId || !production.assets?.song?.id) throw new Error("A managed master and shared project are required.");
  const sceneIds=plan.scenes.map((_,index)=>sceneFileStem(index+1));
  // A cut (verb cut) puts chosen rerolls in place of some scenes. It keeps its own film and assembly journals
  // under ledger.cuts, so the original film, its request and its assembly stay as they were.
  const takeIds=cut?.takeIds??sceneIds;
  if(takeIds.length!==sceneIds.length)throw new Error("A cut names exactly one take for every scene.");
  const journalOf=current=>cut?current.cuts?.[cut.id]?.renderRequest:current.renderRequest;
  const assemblyOf=current=>cut?current.cuts?.[cut.id]?.serverAssembly:current.serverAssembly;
  if(cut&&!ledger.cuts?.[cut.id])throw new Error("Declare the cut before assembling it.");
  const relevant=current=>stableJson({production:current.scenes.production,renderRequest:journalOf(current),
    scenes:takeIds.map(id=>{const s=current.scenes[id];return {projectId:s?.projectId,generationId:s?.generation?.id,
      binding:s?.customerRequest,artifact:s?.artifact,downloaded:s?.downloaded};})});
  const original=relevant(ledger);
  let expectedAssembly=stableJson(assemblyOf(ledger)??null);
  const currentLedger=()=>{
    const current=loadLedger(ledgerFile);
    if(relevant(current)!==original || stableJson(assemblyOf(current)??null)!==expectedAssembly)
      throw new Error("The film or assembly journal changed during recovery. Preserve the newer ledger and retry.");
    return current;
  };
  const clips = plan.scenes.map((entry, index) => {
    const take = ledger.scenes[takeIds[index]];
    if (take?.projectId !== production.projectId || !take.artifact?.assetId || !take.downloaded?.sha256 || take.artifact.sha256 !== take.downloaded.sha256) {
      throw new Error(`Scene ${index + 1} needs a verified downloaded take with its matching owned asset ID. Refresh content before assembly.`);
    }
    return { assetId: take.artifact.assetId, startMs: entry.startMs, endMs: entry.endMs };
  });
  let saved = assemblyOf(ledger);
  const journal=journalOf(ledger);
  const trackedId=saved ? saved.request?.customerRequestId : journal?.id;
  if(journal && (!/^pcr_[a-f0-9]{64}$/.test(journal.id??"") || !Number.isSafeInteger(journal.acceptedAt) || journal.acceptedAt<0 ||
      journal.request?.projectId!==production.projectId || journal.request?.kind!=="film" || journal.request?.members?.length!==sceneIds.length ||
      journal.request.members.some((m,i)=>m.key!==sceneIds[i])))
    throw new Error("Recover the original complete film journal before assembly.");
  if((trackedId && trackedId!==journal?.id) || (!journal && takeIds.some(id=>ledger.scenes[id]?.customerRequest)))
    throw new Error("Recover the original film membership before assembly; tracked work cannot become untracked.");
  if(!saved && trackedId && ledger.generation?.trackedFilmAssemblyReady!==true)
    throw new Error("The serving app has not confirmed tracked film assembly readiness. No assembly was submitted.");
  // A cut's end card ({ assetId, fromLocalMs }) travels with the request and is part of its fingerprint: another card is another assembly.
  const input = { projectId: production.projectId, ...(trackedId?{customerRequestId:trackedId}:{}), title, durationMs: plan.durationMs, audioMode: "song", masterAudioAssetId: production.assets.song.id, clips,
    ...(cut?.endCard ? { endCard: { assetId: cut.endCard.assetId, fromLocalMs: cut.endCard.fromLocalMs } } : {}),
    ...(cut?.graphics ? { graphics: { spotId: cut.graphics.spotId } } : {}) };
  const inputFingerprint = sha256(stableJson(input));
  if (saved && saved.inputFingerprint !== inputFingerprint) throw new Error("The selected server assembly inputs changed. Preserve this ledger for recovery and use a new revision.");
  const saveAssembly=()=>{
    const current=currentLedger();
    if(cut)current.cuts[cut.id].serverAssembly=structuredClone(saved);else current.serverAssembly=structuredClone(saved);
    saveLedger(ledgerFile,current);
    expectedAssembly=stableJson(saved);
  };
  const verifyFilm=async(assembly)=>{
    if(!trackedId)return null;
    const response=await call(ledger,"slopcannon_get_render_request",{requestId:trackedId});
    currentLedger();
    const film=response.request??response;
    const shape=members=>members.map(m=>({key:m.key,seconds:m.seconds,resolution:m.resolution,audio:m.audio,visual:m.visual,...(m.source?{source:m.source}:{})}));
    if(film.id!==trackedId || film.projectId!==production.projectId || film.kind!=="film" || film.acceptedAt!==journal.acceptedAt ||
        !Array.isArray(film.members) || stableJson(shape(film.members))!==stableJson(shape(journal.request.members)) ||
        film.members.some((m,i)=>m.position!==i || m.generationId!==ledger.scenes[takeIds[i]].generation?.id || !Number.isSafeInteger(m.usableAt) || m.usableAt<0))
      throw new Error("The owned film receipt does not match these delivered scene revisions. Recover the original film before continuing.");
    if(assembly) {
      const receipt=film.assembly;
      if(!receipt || receipt.id!==assembly.id || !/^[a-f0-9]{64}$/.test(assembly.inputHash??"") || receipt.inputHash!==assembly.inputHash ||
          !Number.isSafeInteger(receipt.acceptedAt) || receipt.acceptedAt<journal.acceptedAt || !Number.isSafeInteger(receipt.revision) || receipt.revision<0 ||
          (saved?.trackingReceipt && (saved.trackingReceipt.id!==receipt.id || saved.trackingReceipt.inputHash!==receipt.inputHash ||
            saved.trackingReceipt.revision!==receipt.revision || saved.trackingReceipt.acceptedAt!==receipt.acceptedAt ||
            (saved.trackingReceipt.usableAt!==null && saved.trackingReceipt.usableAt!==receipt.usableAt))))
        throw new Error("The server has not confirmed this exact assembly against the film. Keep the saved key and recover it.");
      if(assembly.status==="completed" && (receipt.state!=="completed" || !Number.isSafeInteger(receipt.usableAt) || receipt.usableAt<receipt.acceptedAt))
        throw new Error("The film's delivered assembly receipt is not ready. Resume the same saved assembly.");
      return receipt;
    }
    return film;
  };
  await verifyFilm();
  if (saved?.completed && await verifiedLocalArtifact(saved.completed)) {
    currentLedger();
    if(trackedId)await verifyFilm({id:saved.id,inputHash:saved.trackingReceipt?.inputHash,status:"completed"});
    return { ok: true, output: saved.completed.path, alreadyAssembled: true, assemblyId: saved.id,
      ...(trackedId?{renderRequestId:trackedId,filmCompletedAt:saved.trackingReceipt.usableAt}:{}) };
  }
  if (!saved) {
    saved = { inputFingerprint, request: { ...input, idempotencyKey: newKey("assembly") } };
    saveAssembly();
  }
  let assembly;
  if (!saved.id) {
    ({ assembly } = await call(ledger, "slopcannon_start_assembly", saved.request));
    if (!assembly?.id) throw new Error("Server assembly returned no durable ID; retry the saved request.");
    saved.id = assembly.id;
    saveAssembly();
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!assembly) ({ assembly } = await call(ledger, "slopcannon_get_assembly", { assemblyId: saved.id }));
    if(assembly?.id!==saved.id)throw new Error("The server returned a different assembly identity. Recover the saved assembly.");
    const receipt=await verifyFilm(assembly);
    if(receipt)saved.trackingReceipt=receipt;
    saved.lastStatus = assembly.status;
    saveAssembly();
    if (["completed", "failed", "uncertain"].includes(assembly.status)) break;
    await wait(5000);
    assembly = null;
  }
  if (assembly?.status !== "completed") return { ok: false, needs: "assembly", assemblyId: saved.id, status: saved.lastStatus,
    // A refusal the customer can act on (a take to reroll, an end card of the wrong size) is the server's own sentence.
    ...(typeof assembly?.error === "string" && assembly.status === "failed" ? { error: assembly.error } : {}),
    message: "Resume this ledger to observe the same assembly; no replacement was submitted." };
  if (assembly.engine !== "native" || assembly.syncVerified !== true || !/^[a-f0-9]{64}$/i.test(assembly.sha256 ?? "") || !(assembly.sizeBytes > 0)) throw new Error("Server master lacks the required native verification receipt.");
  if (["reserved", "captured", "released"].some((key) => assembly.credits?.[key] !== 0)) throw new Error("Included assembly unexpectedly reports a customer charge; stop and investigate.");
  const url = new URL(assembly.downloadUrl, ledger.origin);
  if (url.origin !== new URL(ledger.origin).origin || url.username || url.password) throw new Error("Master download must remain on the authenticated API origin.");
  const destination = existsSync(output) ? `${output.replace(/\.mp4$/i, "")}.verified-${randomBytes(6).toString("hex")}.mp4` : output;
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token(url)}` }, redirect: "manual", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Master download returned ${response.status}; resume the same assembly.`);
  // Native masters have a 4 GiB bound; individual take downloads keep their
  // smaller default ceiling. The transfer remains streamed and hash-verified.
  const receipt = await saveArtifactResponse(response, destination, { bytes: assembly.sizeBytes, sha256: assembly.sha256 }, 4 * 1024 ** 3);
  saved.completed = { ...receipt, path: destination };
  saveAssembly();
  return { ok: true, output: destination, assemblyId: saved.id, syncVerified: true, credits: assembly.credits,
    ...(trackedId?{renderRequestId:trackedId,filmCompletedAt:saved.trackingReceipt.usableAt}:{}) };
}

function positiveIntegerOption(options, flag, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = need(options, flag);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function workspaceSummary(workspace) {
  const scenes = workspace?.state?.timelineMedia?.scenes ?? [];
  return {
    projectId: workspace?.projectId ?? null,
    revision: workspace?.revision ?? null,
    scenes: scenes.map((scene) => ({
      sceneId: scene.sceneId,
      selectedTake: scene.selectedTake,
      approved: scene.approved === true,
      takes: (scene.takes ?? []).map((take) => ({
        id: take.id,
        label: take.label,
        hostedAssetId: take.hostedAssetId,
      })),
    })),
  };
}

async function verbWorkspace(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const projectId = need(options, "--project");
  const result = await mcpCall(ledger, "slopcannon_get_workspace", { projectId });
  // The revision belongs to the caller's next write, so it is printed rather
  // than stored: a stale saved revision would invite a blind overwrite.
  return { ok: true, ...workspaceSummary(result.workspace) };
}

/**
 * Cut the song on the server.
 *
 * The revision is optional and is what authorizes replacing an existing
 * timeline; without it a project that already has one answers with the plan and
 * `written: false` rather than losing the cut it has.
 */
async function verbCuts(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const pace = options.get("--pace");
  if (pace !== undefined && !["patient", "music", "hyper"].includes(pace)) {
    throw new Error("--pace must be patient, music or hyper.");
  }
  const result = await mcpCall(ledger, "slopcannon_plan_cuts", {
    projectId: need(options, "--project"),
    ...(pace === undefined ? {} : { pace }),
    ...(options.has("--scene-min-ms") ? { sceneMinMs: positiveIntegerOption(options, "--scene-min-ms") } : {}),
    ...(options.has("--scene-max-ms") ? { sceneMaxMs: positiveIntegerOption(options, "--scene-max-ms") } : {}),
    ...(options.has("--revision") ? { expectedRevision: positiveIntegerOption(options, "--revision", { minimum: 0 }) } : {}),
  });
  return {
    ok: true,
    projectId: result.plan.projectId,
    pace: result.plan.pace,
    sceneCount: result.plan.scenes.length,
    usedWordTiming: result.plan.usedWordTiming,
    written: result.plan.written,
    ...(result.plan.notWrittenReason ? { notWrittenReason: result.plan.notWrittenReason } : {}),
    revision: result.plan.workspaceRevision,
    scenes: result.plan.scenes,
  };
}

async function verbDirect(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const instruction = options.get("--instruction");
  const result = await mcpCall(ledger, "slopcannon_direct_scenes", {
    projectId: need(options, "--project"),
    ...(options.has("--scene-id") ? { sceneId: positiveIntegerOption(options, "--scene-id", { minimum: 0 }) } : {}),
    ...(instruction === undefined ? {} : { instruction }),
    ...(options.has("--revision") ? { expectedRevision: positiveIntegerOption(options, "--revision", { minimum: 0 }) } : {}),
  });
  return {
    ok: true,
    projectId: result.direction.projectId,
    model: result.direction.model,
    sceneCount: result.direction.scenes.length,
    revision: result.direction.workspaceRevision,
    scenes: result.direction.scenes.map((scene) => ({
      id: scene.id,
      cast: scene.cast,
      beatChars: scene.sceneText.length,
    })),
  };
}

async function verbSelect(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const result = await mcpCall(ledger, "slopcannon_select_take", {
    projectId: need(options, "--project"),
    sceneId: positiveIntegerOption(options, "--scene-id", { minimum: 0 }),
    takeId: positiveIntegerOption(options, "--take"),
    expectedRevision: positiveIntegerOption(options, "--revision", { minimum: 0 }),
  });
  return {
    ok: true,
    projectId: result.workspace.projectId,
    sceneId: result.selected.sceneId,
    takeId: result.selected.takeId,
    revision: result.workspace.revision,
  };
}

// ---------------------------------------------------------------- character check

/**
 * The scene's cast references and whether anyone on screen speaks, read from its prepared one-scene plan. A product
 * is checked as a product (identity, not shape); a character is sent without a kind, as before.
 */
export function shotCheckInputs(entry, plan, cast) {
  const references = referencedCastForPlan(cast, plan).map((member) => {
    const asset = entry.assets?.[member.label];
    if (!asset?.id || !castAssetKinds(member).includes(asset.kind)) return null;
    return { assetId: asset.id, name: member.name, ...(member.kind === "product" ? { kind: "product" } : {}) };
  }).filter(Boolean).slice(0, 6);
  // an on-camera vocal span (<d>...</d>) means someone on screen speaks; otherwise every voice is off camera
  const voiceOver = !plan.scenes.some((sceneEntry) => /<d>/.test(sceneEntry.beat ?? ""));
  return { references, voiceOver };
}

/**
 * Why a take has no check, kept with the scene beside (never in place of) `shotCheck`: a missing `shotCheck` still
 * means unchecked everywhere (openReroll, cut), and this says why, so a report can name it instead of passing it.
 */
function recordShotCheckError(ledgerFile, id, assetId, { code, message, retryable }) {
  const latest = loadLedger(ledgerFile);
  const current = scene(latest, id);
  current.shotCheckError = { assetId, code: code ?? null, message: String(message).slice(0, 500), retryable: retryable === true, at: new Date().toISOString() };
  note(current, "check", `unchecked${code ? ` ${code}` : ""}`);
  saveLedger(ledgerFile, latest, id);
  return current.shotCheckError;
}

/** Check one delivered take on the server and keep the verdict with the scene. Spends no credits. */
async function checkScene(ledgerFile, id, { plan, cast, voiceOver, force }) {
  const ledger = loadLedger(ledgerFile);
  const entry = scene(ledger, id);
  const assetId = entry.artifact?.assetId;
  if (!assetId) throw new Error(`Scene ${id} has no delivered take yet. Run poll and content first.`);
  const inputs = shotCheckInputs(entry, plan, cast);
  if (inputs.references.length === 0) {
    const reason = "The scene casts no character or product with an uploaded reference.";
    recordShotCheckError(ledgerFile, id, assetId, { code: "no_references", message: reason, retryable: false });
    return { scene: id, verdict: "unchecked", reason, code: "no_references", retryable: false };
  }
  let result;
  try {
    result = await mcpCall(ledger, "slopcannon_check_take", {
      assetId, references: inputs.references, voiceOver: voiceOver ?? inputs.voiceOver, ...(force ? { force: true } : {}),
    });
  } catch (error) {
    recordShotCheckError(ledgerFile, id, assetId, { code: error?.code, message: error instanceof Error ? error.message : String(error), retryable: error?.retryable });
    throw error;
  }
  const check = isRecord(result?.check) ? result.check : result;
  if (!["pass", "fail"].includes(check?.verdict) || !Array.isArray(check.issues)) {
    const reason = "The server returned an unreadable character check.";
    recordShotCheckError(ledgerFile, id, assetId, { code: "unreadable_check", message: reason, retryable: true });
    throw Object.assign(new Error(reason), { code: "unreadable_check", retryable: true });
  }
  const latest = loadLedger(ledgerFile);
  const current = scene(latest, id);
  current.shotCheck = { assetId, verdict: check.verdict, issues: check.issues, voiceOver: check.voiceOver, checkedAt: check.checkedAt };
  delete current.shotCheckError;
  note(current, "check", `${check.verdict}${check.issues.length ? " " + check.issues.map((issue) => `${issue.kind}@${issue.atSeconds}s`).join(",") : ""}`);
  saveLedger(ledgerFile, latest, id);
  return { scene: id, verdict: check.verdict, issues: check.issues, cached: check.cached === true };
}

/** A check that could not run, as a run reports it: the scene, why, and whether asking again can help. */
function uncheckedResult(id, error) {
  return { scene: id, verdict: "unchecked", reason: error instanceof Error ? error.message : String(error),
    code: error?.code ?? null, retryable: error?.retryable === true };
}

/**
 * The takes of a film that carry no character check of their own bytes, and why (the scene's shotCheckError), so a
 * report names them: a take that was never checked has not passed.
 */
export function uncheckedTakes(ledger, sceneIds, takeIds = sceneIds) {
  return takeIds.flatMap((takeId, index) => {
    const entry = ledger.scenes?.[takeId];
    const assetId = entry?.artifact?.assetId;
    if (!assetId || entry.shotCheck?.assetId === assetId) return [];
    const error = entry.shotCheckError?.assetId === assetId ? entry.shotCheckError : null;
    return [{ scene: sceneIds[index], take: takeId, reason: error?.message ?? "This take was never checked.", code: error?.code ?? null, retryable: error ? error.retryable === true : true }];
  });
}

/** The sentence a report adds when some takes went unchecked. */
export function uncheckedMessage(unchecked) {
  if (unchecked.length === 0) return "";
  const named = unchecked.map((item) => `${item.scene}${item.code ? ` (${item.code})` : ""}`).join(", ");
  return ` ${unchecked.length} take${unchecked.length === 1 ? " was" : "s were"} not checked by the character check: ${named}. Not checked is not passed: show the person those takes to review by eye${unchecked.some((item) => item.retryable) ? ", or run check --scene <id> again for the ones marked retryable" : ""}.`;
}

async function verbCheck(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const id = need(options, "--scene");
  const plan = JSON.parse(readFileSync(path.resolve(need(options, "--plan")), "utf8"));
  const cast = JSON.parse(readFileSync(path.resolve(need(options, "--cast")), "utf8"));
  const voice = options.get("--voice-over");
  if (voice !== undefined && voice !== "yes" && voice !== "no") throw new Error("--voice-over must be yes or no.");
  const force = options.get("--force");
  if (force !== undefined && force !== "yes") throw new Error("--force takes yes.");
  const result = await checkScene(ledgerFile, id, { plan, cast, voiceOver: voice === undefined ? undefined : voice === "yes", force: force === "yes" });
  return { ok: true, ...result, ...(result.verdict === "fail" ? { message: "Show the person each issue at its second. Rerolling (reroll --scene <id>) is a new paid generation and needs their approval." } : {}) };
}

/** Scenes whose failed check the person has seen and accepted: "all" or a comma list of scene ids. */
export function acceptedChecks(value, sceneIds) {
  if (value === undefined || value === null) return new Set();
  if (value === "all") return new Set(sceneIds);
  const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
  for (const id of ids) if (!sceneIds.includes(id)) throw new Error(`--accept-checks names unknown scene ${id}.`);
  return new Set(ids);
}

async function verbUsage(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const url = endpoint(ledger, "usage", "/api/v1/usage");
  const cursor = options.get("--cursor");
  if (cursor) url.searchParams.set("cursor", cursor);
  if (options.has("--limit")) {
    url.searchParams.set("limit", String(positiveIntegerOption(options, "--limit", { maximum: 200 })));
  }
  const { status, json } = await httpAuthed(url);
  if (status !== 200 || !isRecord(json)) throw new Error(`GET ${url.pathname} returned ${status}.`);
  return {
    ok: true,
    entries: Array.isArray(json.data) ? json.data : [],
    nextCursor: typeof json.nextCursor === "string" ? json.nextCursor : null,
  };
}

async function verbCharacter(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const action = options.get("--action") ?? "list";
  if (action === "list") {
    return mcpCall(ledger, "slopcannon_list_characters", {
      ...(options.has("--query") ? { query: options.get("--query") } : {}),
      ...(options.has("--tag") ? { tag: options.get("--tag") } : {}),
      ...(options.has("--owned") ? { owned: options.get("--owned") === "true" } : {}),
      ...(options.has("--limit") ? { limit: positiveIntegerOption(options, "--limit", { maximum: 50 }) } : {}),
      ...(options.has("--offset") ? { offset: positiveIntegerOption(options, "--offset", { minimum: 0, maximum: 10000 }) } : {}),
    });
  }
  if (action === "get") {
    return mcpCall(ledger, "slopcannon_get_character", {
      ...(options.has("--slug") ? { slug: options.get("--slug") } : {}),
      ...(options.has("--character-id") ? { characterId: options.get("--character-id") } : {}),
      ...(options.has("--version") ? { version: positiveIntegerOption(options, "--version") } : {}),
    });
  }
  if (action === "import") {
    const sceneId = options.get("--scene");
    const entry = sceneId ? scene(ledger, sceneId) : null;
    const projectId = options.get("--project") ?? entry?.projectId;
    if (!projectId) throw new Error("Provide --project <id> or --scene <id> with an initialized project.");
    const rights = need(options, "--rights");
    if (ledger.rights?.version && ledger.rights.version !== rights) {
      throw new Error(`--rights ${rights} does not match the presented version ${ledger.rights.version}. Re-run rights and obtain fresh assent.`);
    }
    const imported = await mcpCall(ledger, "slopcannon_import_character", {
      projectId,
      ...(options.has("--slug") ? { slug: options.get("--slug") } : {}),
      ...(options.has("--character-id") ? { characterId: options.get("--character-id") } : {}),
      ...(options.has("--version") ? { version: positiveIntegerOption(options, "--version") } : {}),
      ...(options.has("--reference-id") ? { referenceId: options.get("--reference-id") } : {}),
      ...(options.has("--name") ? { name: options.get("--name") } : {}),
      rightsAttestationVersion: rights,
      ...(options.has("--revision") ? { expectedRevision: positiveIntegerOption(options, "--revision", { minimum: 0 }) } : {}),
    });
    if (entry) {
      const label = options.get("--label") ?? imported.character?.slug ?? "character";
      entry.assets[label] = {
        id: imported.asset.id,
        kind: "character_reference",
        sha256: imported.asset.sha256,
        filename: imported.asset.filename,
        sizeBytes: imported.asset.sizeBytes,
        characterId: imported.character.id,
        characterSlug: imported.character.slug,
        characterVersion: imported.character.version,
        characterReferenceId: imported.receipt.referenceId,
      };
      note(entry, "character-import", `${label} ${imported.character.slug}@v${imported.character.version} -> ${imported.asset.id}`);
      saveLedger(ledgerFile, ledger, sceneId);
    }
    return { ok: true, ...imported };
  }
  if (action === "create") {
    const spec = options.has("--spec") ? JSON.parse(readFileSync(path.resolve(options.get("--spec")), "utf8")) : {};
    return mcpCall(ledger, "slopcannon_create_character", {
      ...spec,
      ...(options.has("--name") ? { name: options.get("--name") } : {}),
    });
  }
  if (action === "update") {
    const spec = options.has("--spec") ? JSON.parse(readFileSync(path.resolve(options.get("--spec")), "utf8")) : {};
    return mcpCall(ledger, "slopcannon_update_character", {
      ...spec,
      characterId: need(options, "--character-id"),
      revision: positiveIntegerOption(options, "--revision"),
      ...(options.has("--name") ? { name: options.get("--name") } : {}),
    });
  }
  if (action === "add-reference") {
    return mcpCall(ledger, "slopcannon_add_character_reference", {
      characterId: need(options, "--character-id"),
      assetId: need(options, "--asset-id"),
      revision: positiveIntegerOption(options, "--revision"),
      rightsVersion: need(options, "--rights"),
    });
  }
  if (action === "publish") {
    return mcpCall(ledger, "slopcannon_publish_character", {
      characterId: need(options, "--character-id"),
      revision: positiveIntegerOption(options, "--revision"),
      rightsVersion: need(options, "--rights"),
    });
  }
  if (action === "unpublish") {
    return mcpCall(ledger, "slopcannon_unpublish_character", {
      characterId: need(options, "--character-id"),
      revision: positiveIntegerOption(options, "--revision"),
    });
  }
  throw new Error("--action must be list, get, import, create, update, add-reference, publish or unpublish.");
}

async function verbPublishLink(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const action = options.get("--action") ?? "create";
  if (action === "create") {
    return mcpCall(ledger, "slopcannon_create_publish_link", {
      projectId: need(options, "--project"),
      assetId: need(options, "--asset-id"),
      ...(options.has("--title") ? { title: options.get("--title") } : {}),
      ...(options.has("--description") ? { description: options.get("--description") } : {}),
    });
  }
  if (action === "get") {
    return mcpCall(ledger, "slopcannon_get_publish_link", {
      linkId: need(options, "--link-id"),
    });
  }
  if (action === "films") {
    return mcpCall(ledger, "slopcannon_list_publishable_films", {
      ...(options.has("--project") ? { projectId: options.get("--project") } : {}),
      ...(options.has("--limit") ? { limit: positiveIntegerOption(options, "--limit", { maximum: 50 }) } : {}),
    });
  }
  throw new Error("--action must be create, get or films.");
}

// ---------------------------------------------------------------- verbs: Ad Cannon pitches

function pitchId(options) {
  const id = need(options, "--pitch");
  if (!/^adpitch_[a-f0-9]{32}$/.test(id)) throw new Error("--pitch must be an ad pitch id (adpitch_ and 32 hex characters).");
  return id;
}

function pitchSummary(pitch) {
  return {
    id: pitch.id, projectId: pitch.projectId, status: pitch.status, stage: pitch.stage, percent: pitch.percent, label: pitch.label,
    credits: pitch.credits, creditsState: pitch.creditsState, error: pitch.error ?? null,
  };
}

/**
 * Ad pitches: research a business from its website, name or address and pitch 4 ad directions, each with a made key
 * picture. `create` spends credits: its idempotency key is written to the ledger before the call, so a repeat of the
 * same request returns the original pitch. Fire a direction with `spot --action create ... --pitch <id> --direction <n>`.
 */
const PITCH_ACTION_FLAGS = {
  create: ["--ledger", "--action", "--project", "--website", "--name", "--address", "--notes", "--max-credits", "--rights", "--key"],
  get: ["--ledger", "--action", "--pitch"],
  wait: ["--ledger", "--action", "--pitch", "--timeout", "--interval"],
};

async function verbPitch(options, ledgerFile) {
  const action = need(options, "--action");
  const allowed = PITCH_ACTION_FLAGS[action];
  if (!allowed) throw new Error("--action must be create, get or wait.");
  // a flag another action takes is refused, not silently ignored
  for (const flag of options.keys()) {
    if (!allowed.includes(flag)) throw new Error(`pitch --action ${action} does not take ${flag}.`);
  }
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  if (action === "create") {
    const request = Object.fromEntries(["--project", "--website", "--name", "--address", "--notes"]
      .filter((flag) => options.has(flag))
      .map((flag) => [flag === "--project" ? "projectId" : flag.slice(2), options.get(flag)]));
    if (!request.website && !request.name && !request.address) throw new Error("Give the business's --website, --name or --address.");
    const maxCredits = positiveIntegerOption(options, "--max-credits", { minimum: 0 });
    // the site's photos become the person's references, so a website needs their rights assent
    const rights = request.website ? spotRights(ledger, options) : options.has("--rights") ? spotRights(ledger, options) : null;
    const fingerprint = sha256(stableJson(request));
    ledger.adPitches ??= {};
    const record = ledger.adPitches[fingerprint] ?? { createdAt: new Date().toISOString(), request };
    const key = options.get("--key") ?? record.key ?? newKey("pitch");
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new Error("--key must be 8-200 letters, digits or . _ : - characters.");
    record.key = key;
    ledger.adPitches[fingerprint] = record;
    saveLedger(ledgerFile, ledger);
    const created = await mcpCall(ledger, "slopcannon_create_ad_pitch", {
      ...request, maxCredits, ...(rights ? { rightsAttestationVersion: rights } : {}), idempotencyKey: key,
    });
    record.pitchId = created.pitch.id;
    record.credits = created.pitch.credits;
    ledger.adPitches[fingerprint] = record;
    saveLedger(ledgerFile, ledger);
    return { ok: true, replayed: created.replayed === true, key, pitch: pitchSummary(created.pitch), next: `pitch --action wait --pitch ${created.pitch.id}` };
  }
  if (action === "get") {
    const { pitch } = await mcpCall(ledger, "slopcannon_get_ad_pitch", { pitchId: pitchId(options) });
    return { ok: true, pitch };
  }
  if (action === "wait") {
    const id = pitchId(options);
    const timeoutS = options.has("--timeout") ? positiveIntegerOption(options, "--timeout", { minimum: 30, maximum: 86_400 }) : 1800;
    const deadline = Date.now() + timeoutS * 1000;
    const interval = spotPollMs(options);
    for (;;) {
      let pitch = null;
      try {
        ({ pitch } = await mcpCall(ledger, "slopcannon_get_ad_pitch", { pitchId: id }));
      } catch (error) {
        // a read that ran a long stage can outlive the request; the pitch keeps going, so read it again
        if (error?.name !== "TimeoutError" && error?.retryable !== true) throw error;
      }
      if (pitch && (pitch.status === "done" || pitch.status === "failed")) {
        return { ok: pitch.status === "done", pitch, ...(pitch.status === "failed" ? { advice: "The pitch failed and its credits were returned. Read pitch.error before making another." } : {}) };
      }
      if (Date.now() > deadline) throw new Error(`Timed out with ad pitch ${id} at ${pitch?.stage ?? "an unknown stage"}; wait again later with the same id.`);
      await sleep(interval);
    }
  }
  throw new Error("--action must be create, get or wait.");
}

// ---------------------------------------------------------------- verbs: Ad Cannon audio spots

const SPOT_FILES = ["master.wav", "dialogue.wav", "music.wav", "effects.wav", "captions.srt", "cutlist.json"];
const SPOT_FILE_MAX_BYTES = 256 * 1024 * 1024;

function spotId(options) {
  const id = need(options, "--spot");
  if (!/^audiospot_[a-f0-9]{32}$/.test(id)) throw new Error("--spot must be an audio spot id (audiospot_ and 32 hex characters).");
  return id;
}

/** The rights version comes from the command line; it must be the one `rights` presented, when it presented one. */
function spotRights(ledger, options) {
  const rights = need(options, "--rights");
  if (ledger.rights?.version && ledger.rights.version !== rights) {
    throw new Error(`--rights ${rights} does not match the presented version ${ledger.rights.version}. Re-run rights and obtain fresh assent.`);
  }
  return rights;
}

function spotSummary(spot) {
  return {
    id: spot.id, projectId: spot.projectId, status: spot.status, stage: spot.stage, percent: spot.percent,
    lengthS: spot.lengthS, energy: spot.energy ?? null, credits: spot.credits, creditsState: spot.creditsState, title: spot.title ?? null,
    error: spot.error ?? null, cannonUrl: spot.cannonUrl ?? null,
  };
}

/** Seconds between reads; tests set SLOPCANNON_AGENT_SPOT_POLL_MS so a wait never sleeps. */
function spotPollMs(options) {
  const seconds = options.has("--interval") ? positiveIntegerOption(options, "--interval", { minimum: 5, maximum: 3600 }) : 15;
  const forced = process.env.SLOPCANNON_AGENT_SPOT_POLL_MS;
  if (forced !== undefined && Number.isFinite(Number(forced)) && Number(forced) >= 0) return Number(forced);
  return seconds * 1000;
}

/**
 * Stream one spot file to a private temporary file beside `destination` and verify it against the server's length
 * and SHA-256. The file is not moved into place here: the caller moves every file once all of them have verified.
 * A response without a digest is refused, so nothing unverified is ever kept.
 */
async function stageSpotFile(response, destination) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SPOT_FILE_MAX_BYTES)) throw new Error("The file's Content-Length is invalid or too large.");
  const expectedSha = response.headers.get("x-content-sha256");
  if (expectedSha === null) throw new Error("The server sent no X-Content-SHA256 digest, so the file cannot be verified.");
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) throw new Error("The server sent an invalid file digest.");
  const temporary = `${destination}.partial-${randomBytes(8).toString("hex")}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  let open = true;
  let kept = false;
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > SPOT_FILE_MAX_BYTES || (declared !== null && bytes > Number(declared))) throw new Error("The file exceeded its declared size.");
      hash.update(chunk);
      for (let offset = 0; offset < chunk.byteLength;) {
        const written = writeSync(descriptor, chunk, offset, chunk.byteLength - offset);
        if (written === 0) throw new Error("The file write made no progress.");
        offset += written;
      }
    }
    const digest = hash.digest("hex");
    if (declared !== null && bytes !== Number(declared)) throw new Error("The file is shorter than its declared size.");
    if (expectedSha !== digest) throw new Error("The file's SHA-256 does not match the server's digest.");
    fsyncSync(descriptor);
    closeSync(descriptor);
    open = false;
    kept = true;
    return { temporary, destination, bytes, sha256: digest };
  } finally {
    if (open) closeSync(descriptor);
    if (!kept && existsSync(temporary)) unlinkSync(temporary);
  }
}

/**
 * Download every file a finished spot lists. All of them are fetched and verified first; only then are they moved into
 * `--out-dir` together, so a failure part way leaves the folder as it was (never half an old spot and half a new one).
 */
async function spotDownload(ledger, options) {
  const id = spotId(options);
  const outDir = path.resolve(need(options, "--out-dir"));
  const { spot } = await mcpCall(ledger, "slopcannon_get_audio_spot", { spotId: id });
  if (spot.status !== "done") throw new Error(`Audio spot ${id} is ${spot.status}${spot.stage ? ` (${spot.stage})` : ""}; download it once it is done.`);
  if (!spot.files?.["master.wav"]) throw new Error(`Audio spot ${id} lists no master.wav.`);
  const origin = new URL(ledger.origin).origin;
  const links = SPOT_FILES.filter((name) => spot.files[name]).map((name) => {
    const url = new URL(spot.files[name], origin);
    if (url.origin !== origin || url.username || url.password) throw new Error(`The ${name} link leaves the configured SLOPCANNON origin.`);
    return { name, url };
  });
  mkdirSync(outDir, { recursive: true });
  const staged = [];
  try {
    for (const { name, url } of links) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token(url)}` }, redirect: "manual", signal: AbortSignal.timeout(300_000) });
      if (response.status !== 200 || !response.body) {
        const body = (await response.text().catch(() => "")).slice(0, 200);
        throw new Error(`Downloading ${name} returned ${response.status}${body ? `: ${body}` : ""}`);
      }
      staged.push({ name, ...await stageSpotFile(response, path.join(outDir, name)) });
    }
    for (const file of staged) renameSync(file.temporary, file.destination);
  } finally {
    for (const file of staged) if (existsSync(file.temporary)) unlinkSync(file.temporary);
  }
  return {
    ok: true, spotId: id, title: spot.title ?? null, durationS: spot.durationS ?? null,
    files: staged.map(({ name, destination, bytes, sha256: digest }) => ({ name, path: destination, bytes, sha256: digest, verifiedAgainstServer: true })),
  };
}

/**
 * The facts a spot must say, one per line of a text file (blank lines and "- " or "1. " list markers are ignored): at
 * most 8, each 1-160 characters, no repeats, as the server checks them.
 */
export function readMustSayFile(file) {
  const facts = readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  if (facts.length > 8) throw new Error("--must-say-file lists more than 8 facts; the Ad Cannon takes at most 8.");
  const seen = new Set();
  for (const fact of facts) {
    if (fact.length > 160) throw new Error(`Must-say fact "${fact.slice(0, 40)}…" is longer than 160 characters.`);
    const folded = fact.normalize("NFKD").toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!folded) throw new Error(`Must-say fact "${fact}" has no words in it.`);
    if (seen.has(folded)) throw new Error(`Must-say fact "${fact}" is listed twice.`);
    seen.add(folded);
  }
  return facts;
}

/**
 * The products a product ad shows off, from a JSON file: an array of at most 4 {name, photoAssetId, description?}, each
 * name UPPER_SNAKE and unique, as the server checks them (it also checks each photo is a reference image in the project).
 */
export function readProductsFile(file) {
  const products = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(products)) throw new Error("--products must be a JSON array of {name, photoAssetId, description}.");
  if (products.length > 4) throw new Error("--products lists more than 4 products; the Ad Cannon takes at most 4.");
  const seen = new Set();
  return products.map((product, index) => {
    if (!product || typeof product !== "object" || Array.isArray(product)) throw new Error(`--products entry ${index + 1} must be an object.`);
    const extra = Object.keys(product).filter((key) => !["name", "photoAssetId", "description"].includes(key));
    if (extra.length) throw new Error(`--products entry ${index + 1} has unknown field ${extra[0]}; use name, photoAssetId and description.`);
    const name = typeof product.name === "string" ? product.name.trim() : "";
    if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(name) || name.length < 2 || name.length > 32) {
      throw new Error(`--products entry ${index + 1} needs an UPPER_SNAKE name like MARGHERITA or WHITE_PIE.`);
    }
    if (/^S\d+$/.test(name)) throw new Error(`--products name ${name} is how shot prompts name a speaker (S1, S2, ...); rename the product.`);
    if (seen.has(name)) throw new Error(`--products names ${name} twice.`);
    seen.add(name);
    if (typeof product.photoAssetId !== "string" || !product.photoAssetId.trim()) throw new Error(`--products ${name} needs a photoAssetId.`);
    return { name, photoAssetId: product.photoAssetId.trim(), ...(typeof product.description === "string" && product.description.trim() ? { description: product.description.trim() } : {}) };
  });
}

/** An end card's facts from a JSON file: {name, street?, phone?, website?}; the server checks the values. */
export function readEndCardFile(file) {
  const card = JSON.parse(readFileSync(file, "utf8"));
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error("--end-card must be a JSON object {name, street?, phone?, website?}.");
  const extra = Object.keys(card).filter((key) => !["name", "street", "phone", "website"].includes(key));
  if (extra.length) throw new Error(`--end-card has unknown field ${extra[0]}; use name, street, phone and website.`);
  if (typeof card.name !== "string" || !card.name.trim()) throw new Error("--end-card needs the business or product name.");
  const out = {};
  for (const key of ["name", "street", "phone", "website"]) {
    if (card[key] === undefined || card[key] === null) continue;
    if (typeof card[key] !== "string") throw new Error(`--end-card ${key} must be text.`);
    if (card[key].trim()) out[key] = card[key].trim();
  }
  return out;
}

/**
 * The Ad Cannon: an exact-length mastered audio spot with stems, captions and a
 * shot list, which `load` turns into a Cannon project to film. `create` spends
 * credits: its idempotency key is written to the ledger before the call, so a
 * repeat of the same request returns the original spot instead of buying one.
 */
async function verbSpot(options, ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  requireOrigin(ledger, options);
  const action = options.get("--action") ?? "options";
  if (options.has("--pitch") && action !== "create") throw new Error("--pitch is taken only by spot --action create.");
  if (action === "options") return { ok: true, ...await mcpCall(ledger, "slopcannon_audio_spot_options", {}) };
  if (action === "list") {
    const listed = await mcpCall(ledger, "slopcannon_list_audio_spots", options.has("--project") ? { projectId: options.get("--project") } : {});
    return { ok: true, spots: listed.spots ?? [] };
  }
  if (action === "create") {
    const castFile = path.resolve(need(options, "--cast"));
    const cast = JSON.parse(readFileSync(castFile, "utf8"));
    if (!Array.isArray(cast)) throw new Error("--cast must be a JSON array of {name, description, voiceId, photoAssetId?, onCamera?}.");
    const energy = options.get("--energy");
    if (energy !== undefined && !["calm", "lively", "hype"].includes(energy)) throw new Error("--energy must be calm, lively or hype.");
    const mustSay = options.has("--must-say-file") ? readMustSayFile(path.resolve(options.get("--must-say-file"))) : [];
    const products = options.has("--products") ? readProductsFile(path.resolve(options.get("--products"))) : [];
    const endCard = options.has("--end-card") ? readEndCardFile(path.resolve(options.get("--end-card"))) : null;
    const request = {
      projectId: need(options, "--project"),
      brief: need(options, "--brief"),
      lengthS: positiveIntegerOption(options, "--length"),
      cast,
      // lively is the server's default and the server fingerprints it as no energy, so the ledger does too: a re-run
      // with --energy lively added (or a ledger written before --energy existed) finds the same key again
      ...(energy !== undefined && energy !== "lively" ? { energy } : {}),
      // only a request with facts carries the field, so an earlier ledger's spots keep their fingerprints
      ...(mustSay.length ? { mustSay } : {}),
      // products and an end card likewise join the request (and its fingerprint) only when given
      ...(products.length ? { products } : {}),
      ...(endCard ? { endCard } : {}),
    };
    const maxCredits = positiveIntegerOption(options, "--max-credits", { minimum: 0 });
    const rights = spotRights(ledger, options);
    // a spot that fires an ad pitch's direction names it; the pitch is part of the request (the server fingerprints it
    // too), so the same spot fired from another pitch is a new request with its own key
    let pitch = null;
    if (options.has("--pitch")) {
      pitch = { id: pitchId(options), direction: positiveIntegerOption(options, "--direction", { minimum: 0, maximum: 3 }) };
    } else if (options.has("--direction")) {
      throw new Error("--direction needs --pitch when creating a spot.");
    }
    const fingerprint = sha256(stableJson(pitch ? { ...request, pitch } : request));
    ledger.audioSpots ??= {};
    const record = ledger.audioSpots[fingerprint] ?? { createdAt: new Date().toISOString(), projectId: request.projectId, lengthS: request.lengthS };
    const key = options.get("--key") ?? record.key ?? newKey("spot");
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new Error("--key must be 8-200 letters, digits or . _ : - characters.");
    record.key = key;
    ledger.audioSpots[fingerprint] = record;
    saveLedger(ledgerFile, ledger);
    const created = await mcpCall(ledger, "slopcannon_create_audio_spot", {
      ...request, ...(energy !== undefined ? { energy } : {}), maxCredits, rightsAttestationVersion: rights, idempotencyKey: key, ...(pitch ? { pitch } : {}),
    });
    record.spotId = created.spot.id;
    record.credits = created.spot.credits;
    ledger.audioSpots[fingerprint] = record;
    saveLedger(ledgerFile, ledger);
    return {
      ok: true, replayed: created.replayed === true, key, spot: spotSummary(created.spot),
      ...(created.pitchCredit ? { pitchCredit: created.pitchCredit } : {}),
      next: `spot --action wait --spot ${created.spot.id}`,
    };
  }
  if (action === "get") {
    const { spot } = await mcpCall(ledger, "slopcannon_get_audio_spot", { spotId: spotId(options) });
    return { ok: true, spot };
  }
  if (action === "wait") {
    const id = spotId(options);
    const timeoutS = options.has("--timeout") ? positiveIntegerOption(options, "--timeout", { minimum: 30, maximum: 86_400 }) : 1800;
    const deadline = Date.now() + timeoutS * 1000;
    const interval = spotPollMs(options);
    for (;;) {
      let spot = null;
      try {
        ({ spot } = await mcpCall(ledger, "slopcannon_get_audio_spot", { spotId: id }));
      } catch (error) {
        // a read that ran a long stage can outlive the request; the spot keeps going, so read it again
        if (error?.name !== "TimeoutError" && error?.retryable !== true) throw error;
      }
      if (spot && (spot.status === "done" || spot.status === "failed")) {
        return { ok: spot.status === "done", spot, ...(spot.status === "failed" ? { advice: "The spot failed and its credits were returned. Read spot.error before making another." } : {}) };
      }
      if (Date.now() > deadline) throw new Error(`Timed out with audio spot ${id} at ${spot?.stage ?? "an unknown stage"}; wait again later with the same id.`);
      await sleep(interval);
    }
  }
  if (action === "edit") {
    const { spot } = await mcpCall(ledger, "slopcannon_edit_audio_spot_line", {
      spotId: spotId(options),
      beatId: need(options, "--beat"),
      text: need(options, "--text"),
      ...(options.has("--direction") ? { direction: options.get("--direction") } : {}),
    });
    return { ok: true, spot: spotSummary(spot), edits: spot.edits ?? null, next: `spot --action wait --spot ${spot.id}` };
  }
  if (action === "edit-sound") {
    const kind = need(options, "--kind");
    if (kind !== "sfx" && kind !== "music") throw new Error("--kind must be sfx or music.");
    // --remove yes takes an effect out instead of making it again
    const remove = options.get("--remove");
    if (remove !== undefined && remove !== "yes") throw new Error("--remove takes yes.");
    if (remove && kind !== "sfx") throw new Error("--remove takes out a sound effect (--kind sfx); change the music with --prompt.");
    if (remove && options.has("--prompt")) throw new Error("Give --prompt to change the effect, or --remove yes to take it out, not both.");
    const { spot } = await mcpCall(ledger, "slopcannon_edit_audio_spot_sound", {
      spotId: spotId(options),
      kind,
      ...(kind === "sfx" ? { beatId: need(options, "--beat") } : { cueIndex: positiveIntegerOption(options, "--cue", { minimum: 0, maximum: 99 }) }),
      ...(remove ? { remove: true } : { prompt: need(options, "--prompt") }),
    });
    return { ok: true, spot: spotSummary(spot), edits: spot.edits ?? null, soundSeconds: spot.soundSeconds ?? null, next: `spot --action wait --spot ${spot.id}` };
  }
  if (action === "load") {
    const loaded = await mcpCall(ledger, "slopcannon_load_audio_spot", { spotId: spotId(options), rightsAttestationVersion: spotRights(ledger, options) });
    return { ok: true, projectId: loaded.projectId, songAssetId: loaded.songAssetId, workspaceRevision: loaded.workspaceRevision, cannonUrl: loaded.cannonUrl };
  }
  if (action === "download") return spotDownload(ledger, options);
  throw new Error("--action must be options, list, create, get, wait, edit, edit-sound, load or download.");
}

function verbStatus(ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  const entries = Object.values(ledger.scenes);
  const counts = { total: entries.length, downloaded: 0, succeeded: 0, failed: 0, pending: 0, unsubmitted: 0, uncertain: 0 };
  for (const entry of entries) {
    if (entry.downloaded) counts.downloaded++;
    const status = entry.generation?.status;
    if (!status) counts.unsubmitted++;
    else if (status === "succeeded") counts.succeeded++;
    else if (status === "failed") counts.failed++;
    else if (["submission_unknown", "billing_unknown", "submitting"].includes(status)) counts.uncertain++;
    else counts.pending++;
  }
  return {
    ok: true,
    origin: ledger.origin,
    ready: Boolean(ledger.generation?.submissionReady && ledger.generation?.contentReady),
    productionFingerprint: ledger.productionFingerprint ?? null,
    renderRequest: ledger.renderRequest?{id:ledger.renderRequest.id,acceptedAt:ledger.renderRequest.acceptedAt,memberCount:ledger.renderRequest.request.members.length}:null,
    progress: counts,
    budget: ledger.spendCapCredits !== undefined ? productionSpend(ledger, [], ledger.spendCapCredits) : null,
    rights: ledger.rights,
    scenes: Object.entries(ledger.scenes).map(([id, entry]) => ({
      scene: id,
      projectId: entry.projectId ?? null,
      assets: Object.keys(entry.assets),
      quote: entry.quote ? { id: entry.quote.id, amountUnits: entry.quote.amountUnits, expiresAt: entry.quote.expiresAt } : null,
      generation: entry.generation ? { id: entry.generation.id, status: entry.generation.status, errorCode: entry.generation.errorCode ?? null } : null,
      downloaded: entry.downloaded?.path ?? null,
      previousAttempts: (entry.attempts ?? []).map((attempt) => ({ id: attempt.id, status: attempt.status, approvedCredits: attempt.submission?.approval?.amountUnits ?? null })),
    })),
  };
}

// ---------------------------------------------------------------- verbs: run

/**
 * The ordered drive from one production file. Stops with exit 2 and a
 * machine-readable `needs` at each human gate (rights, approval) and resumes
 * from the ledger on the next invocation.
 *
 * production.json:
 * {
 *   "origin": "https://api.slop.cc",
 *   "title": "…",
 *   "song": "master.wav",
 *   "references": [{ "name": "LEAD", "label": "lead", "path": "lead.jpg" }],
 *   "singer": { "name": "LEAD", "speakerId": "S1" },
 *   "transcript": "words.json",            // optional; omit for a non-singing plan
 *   "directions": { ... },                 // see buildTimedPlan
 *   "cuts": [9720, 19960],                 // optional pinned boundaries
 *   "aspectRatio": "16:9",
 *   "bible": "bible.txt",                  // optional
 *   "workDir": "./production"
 * }
 */
async function verbRun(options, ledgerFile) {
  const productionFile = path.resolve(need(options, "--production"));
  const production = JSON.parse(readFileSync(productionFile, "utf8"));
  // read (and its reference kinds checked) before anything is uploaded
  const cast = productionCast(production);
  const base = path.dirname(productionFile);
  const resolveInput = (value) => path.resolve(base, value);
  const workDir = resolveInput(production.workDir ?? "./production");
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  const song = resolveInput(production.song);
  const assemblyMode = options.get("--assembly") ?? "server";
  if (!["server", "local"].includes(assemblyMode)) throw new Error("--assembly must be server (default) or local (requires FFmpeg/FFprobe).");
  const concurrency = Number(options.get("--concurrency") ?? 4);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency must be a whole number from 1 through 16.");
  }
  const steps = [];

  // 1. Contract. A readiness read is re-taken before the run stops: one slow
  // upstream answer must not halt a production that the origin can serve.
  const originReady = (c) => c.ready && c.serverSideSlicing && c.sourceAudioAssetIdAccepted &&
    (assemblyMode !== "server" || (c.serverAssemblyReady && (c.renderRequests?.mode !== "queue" || c.trackedFilmAssemblyReady)));
  const readCaps = () => verbCaps(new Map([["--origin", production.origin ?? allowedOrigin()]]), ledgerFile);
  let caps = await readCaps();
  for (const delayMs of capsRetryDelays()) {
    if (originReady(caps)) break;
    await sleep(delayMs);
    caps = await readCaps();
  }
  steps.push({ step: "caps", ready: caps.ready, maximumScenesPerQuote: caps.maximumScenesPerQuote });
  if (!caps.ready) return { ok: false, needs: "origin", steps, message: caps.advice };

  // The resumable state is bound to the bytes that determine the production.
  // Never reuse projects, uploads, quotes, or generations after an edit merely
  // because a file from the prior revision still exists.
  const productionFingerprint = fingerprintProduction(productionFile, production);
  const revisionLedger = loadLedger(ledgerFile);
  const hasLegacyState = !revisionLedger.productionFingerprint && Object.keys(revisionLedger.scenes).length > 0;
  const priorProjects = new Set(Object.entries(revisionLedger.scenes).filter(([id]) => id !== "production").map(([, entry]) => entry.projectId).filter(Boolean));
  if (priorProjects.size && (!revisionLedger.scenes.production?.projectId || [...priorProjects].some((id) => id !== revisionLedger.scenes.production.projectId))) {
    return { ok: false, needs: "recovery", message: "This ledger contains work from the retired per-scene project workflow. Recover its existing jobs with poll/content; start new work with a fresh ledger. No existing job was replaced." };
  }
  if (hasLegacyState) {
    return {
      ok: false,
      needs: "new_revision",
      steps,
      productionFingerprint,
      message: "This ledger predates production revision binding. Use a new --ledger and workDir so old paid state cannot be mistaken for this production.",
    };
  }
  if (revisionLedger.productionFingerprint && revisionLedger.productionFingerprint !== productionFingerprint) {
    return {
      ok: false,
      needs: "new_revision",
      steps,
      productionFingerprint,
      previousProductionFingerprint: revisionLedger.productionFingerprint,
      message: "Production inputs changed. Use a new --ledger and workDir; the prior revision remains recoverable and will not be overwritten.",
    };
  }
  if (!revisionLedger.productionFingerprint) {
    revisionLedger.productionFingerprint = productionFingerprint;
    saveLedger(ledgerFile, revisionLedger);
  }

  // 2. Plan (whole song), then per-scene audio and plans.
  if (!caps.serverSideSlicing || !caps.sourceAudioAssetIdAccepted || (assemblyMode === "server" && !caps.serverAssemblyReady)) {
    return { ok: false, needs: "origin", steps, message: "This workflow requires server scene audio and included server assembly. The origin is not ready; no local fallback or paid submission was attempted." };
  }
  const beforeAssembly=loadLedger(ledgerFile);
  if(assemblyMode==="server" && !beforeAssembly.serverAssembly &&
      (beforeAssembly.renderRequest || caps.renderRequests?.mode==="queue") && !caps.trackedFilmAssemblyReady)
    return {ok:false,needs:"origin",steps,message:"The serving app has not confirmed tracked film assembly readiness. No paid scene or assembly was submitted."};
  if(assemblyMode==="local"&&!beforeAssembly.localAssemblyReport&&(beforeAssembly.renderRequest||caps.renderRequests?.mode==="queue")&&
    caps.renderRequests?.localAssemblyReceiptReady!==true)
    return {ok:false,needs:"origin",steps,message:"The origin has not confirmed local film receipt support. No new paid scene was submitted."};
  // Rights precede the first server upload. The initial five-second preview is
  // also the server's duration probe; it does not create a generation or quote.
  // Human gates come only from this command line. The agent writes the
  // production file and ledger, so neither may carry a rights assent, a spend
  // approval or a credit ceiling.
  const rightsVersion = options.get("--rights-accepted") ?? null;
  const ignoredGates = ["rightsAccepted", "approve", "maxCredits"].filter((key) => Object.hasOwn(production, key));
  const gateNote = ignoredGates.length ? ` The production file's ${ignoredGates.join(", ")} ${ignoredGates.length === 1 ? "is" : "are"} ignored; only the command-line flags count.` : "";
  const rights = await verbRights(new Map(), ledgerFile);
  const files = fileInventory([
    { file: song, role: "master", uploaded: true },
    ...(production.references ?? []).filter((reference) => Boolean(reference?.path)).map((reference) => ({ file: resolveInput(reference.path), role: reference.kind === "product" ? "product-reference" : "character-reference", uploaded: true })),
  ]);
  if (rightsVersion !== rights.requiredVersion) {
    return { ok: false, needs: "rights", steps, requiredVersion: rights.requiredVersion, statement: rights.statement, termsUrl: rights.termsUrl, acceptableUseUrl: rights.acceptableUseUrl, files, message: `Confirm the disclosed rights statement for these files before upload.${gateNote}` };
  }
  const shared = loadLedger(ledgerFile);
  if (!scene(shared, "production").projectId) {
    await verbProject(new Map([["--scene", "production"], ["--name", production.title], ["--concept", production.concept ?? ""], ["--aspect", production.aspectRatio ?? "16:9"]]), ledgerFile);
  }
  await verbUpload(new Map([["--scene", "production"], ["--kind", "song"], ["--file", song], ["--label", "song"], ["--rights", rightsVersion]]), ledgerFile);
  const projectId = loadLedger(ledgerFile).scenes.production.projectId;
  const durationPlan = path.join(workDir, "server-duration-preview.json");
  writeFileSync(durationPlan, JSON.stringify({ schemaVersion: 1, durationMs: 5000, scenes: [{ startMs: 0, endMs: 5000, cast: [], beat: "Duration preview; no generation." }] }));
  const preview = await verbPrepareServer(new Map([["--server", projectId], ["--plan", durationPlan]]), ledgerFile);
  const durationMs = preview.songDurationMs;
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_SCENE_MS) throw new Error("The server did not return a verified master duration.");
  const planFile = path.join(workDir, "timed-plan.json");
  if (!existsSync(planFile)) {
    if (production.transcript) {
      const planned = await verbPlan(new Map([["--transcript", resolveInput(production.transcript)], ["--directions", productionFile], ["--duration-ms", String(durationMs)], ["--cuts", (production.cuts ?? []).join(",")], ["--out", planFile]]), ledgerFile);
      steps.push({ step: "plan", sceneCount: planned.sceneCount, ...(planned.warnings.length > 0 ? { warnings: planned.warnings } : {}) });
    } else {
      throw new Error("A production without a transcript needs a hand-authored timed-plan.json in workDir.");
    }
  }
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const prepDir = path.join(workDir, "scene-audio");
  if (!Array.isArray(plan.scenes) || plan.scenes.length > caps.maximumProjectScenes) throw new Error(`The shared project supports at most ${caps.maximumProjectScenes} scenes. No quotes or paid submissions were made.`);
  await validatePlan(planFile, durationMs, (production.references ?? []).map((reference) => reference.name));
  const serverSlicing = true;
  const sceneIds = plan.scenes.map((_, index) => sceneFileStem(index + 1));
  const preparedFingerprint = preparedRevision(plan, files);
  const preparedLedger = loadLedger(ledgerFile);
  if (preparedLedger.preparedFingerprint && preparedLedger.preparedFingerprint !== preparedFingerprint) {
    return { ok: false, needs: "new_revision", message: "The timed plan or prepared upload bytes changed. Keep this ledger for paid-job recovery; do not reuse its approval or uploads for edited media." };
  }
  if (!preparedLedger.preparedFingerprint && Object.values(preparedLedger.scenes).some((entry) => entry.generation?.key || entry.generation?.id)) {
    return { ok: false, needs: "recovery", message: "This paid ledger predates prepared-media binding. Recover its existing generations with poll/content before starting another revision." };
  }
  preparedLedger.preparedFingerprint = preparedFingerprint;
  saveLedger(ledgerFile, preparedLedger);
  if (rightsVersion !== rights.requiredVersion) {
    return { ok: false, needs: "rights", steps, requiredVersion: rights.requiredVersion, statement: rights.statement, termsUrl: rights.termsUrl, acceptableUseUrl: rights.acceptableUseUrl, files, message: "If the human already signed off on this requiredVersion earlier in this session, re-run with --rights-accepted <requiredVersion> and name these files to them as information; do not ask again. Otherwise present the statement, links and files, and re-run only after explicit affirmative sign-off; `I agree` is sufficient, and an unambiguous post-disclosure directive to proceed with the upload also counts." };
  }

  // 4. Projects, uploads, quotes.
  const castFile = path.join(workDir, "cast.json");
  writeFileSync(castFile, `${JSON.stringify(cast, null, 2)}\n`, "utf8");
  const bibleFile = production.bible ? resolveInput(production.bible) : null;

  // One project holds the whole film where the origin cuts the master: the
  // master and the references are uploaded once, and every scene quotes the
  // chunk that was cut for it.
  if (serverSlicing) {
    const shared = loadLedger(ledgerFile);
    if (!scene(shared, "production").projectId) {
      await verbProject(new Map([["--scene", "production"], ["--name", production.title], ["--concept", production.concept ?? ""], ["--aspect", production.aspectRatio ?? "16:9"]]), ledgerFile);
    }
    await verbUpload(new Map([["--scene", "production"], ["--kind", "song"], ["--file", song], ["--label", "song"], ["--rights", rightsVersion]]), ledgerFile);
    for (const [index, reference] of (production.references ?? []).entries()) {
      const label = reference.label ?? `ref-${index + 1}`;
      if (reference.character || reference.characterId) {
        const importOpts = new Map([
          ["--action", "import"],
          ["--scene", "production"],
          ["--label", label],
          ["--rights", rightsVersion],
        ]);
        if (reference.character) importOpts.set("--slug", String(reference.character));
        if (reference.characterId) importOpts.set("--character-id", String(reference.characterId));
        if (reference.version !== undefined) importOpts.set("--version", String(reference.version));
        if (reference.referenceId) importOpts.set("--reference-id", String(reference.referenceId));
        if (reference.name) importOpts.set("--name", String(reference.name));
        await verbCharacter(importOpts, ledgerFile);
      } else {
        await verbUpload(new Map([["--scene", "production"], ["--kind", referenceAssetKind(reference)], ["--file", resolveInput(reference.path)], ["--label", label], ["--rights", rightsVersion]]), ledgerFile);
      }
    }
    const production_ = loadLedger(ledgerFile).scenes.production;
    const prepared = await verbPrepareServer(
      new Map([["--server", production_.projectId], ["--plan", planFile], ["--out-dir", prepDir]]),
      ledgerFile,
    );
    steps.push({ step: "prepare", server: true, sceneCount: prepared.sceneCount, ticketId: prepared.ticketId });
    for (const [index, id] of sceneIds.entries()) {
      const seeded = loadLedger(ledgerFile);
      const entry = scene(seeded, id);
      entry.projectId = production_.projectId;
      entry.assets = { ...production_.assets };
      entry.sceneAudioAssetId = prepared.scenes[index].assetId;
      saveLedger(ledgerFile, seeded, id);
    }
  }

  const quotes = await mapWithConcurrency(sceneIds, concurrency, async (id) => {
    const current = loadLedger(ledgerFile).scenes[id];
    if (current.generation?.id) return { scene: id, amountUnits: current.quote?.amountUnits ?? null, submitted: true };
    if (current.generation?.key) {
      throw new Error(`Scene ${id} has an unresolved submission. Run recover --scene ${id} to find its original job without spending; never obtain a replacement quote.`);
    }
    const quoteOptions = new Map([["--scene", id], ["--plan", path.join(prepDir, "scene-plans", `${id}.json`)], ["--cast", castFile], ["--aspect", production.aspectRatio ?? "16:9"]]);
    if (bibleFile) quoteOptions.set("--bible", bibleFile);
    const quoteIsCurrent = current.quote?.currency === "CANNON_CREDIT"
      && current.quote?.creditUnit === "cannon-credit"
      && new Date(current.quote.expiresAt) > new Date(Date.now() + 60_000);
    const quoted = quoteIsCurrent ? { amountUnits: current.quote.amountUnits, quoteId: current.quote.id } : await verbQuote(quoteOptions, ledgerFile);
    return { scene: id, quoteId: quoted.quoteId, amountUnits: quoted.amountUnits, cannonCredits: quoted.amountUnits, submitted: false };
  });
  steps.push({ step: "quote", concurrency, quotes });

  // 5. Approval gate.
  const approve = options.get("--approve") ?? null;
  const pending = quotes.filter((quote) => !quote.submitted);
  const total = pending.reduce((sum, quote) => sum + quote.amountUnits, 0);
  const runLedger = loadLedger(ledgerFile);
  if (runLedger.scenes[sceneIds[0]]?.downloaded && !await verifiedLocalArtifact(runLedger.scenes[sceneIds[0]].downloaded)) {
    delete runLedger.scenes[sceneIds[0]].downloaded;
    delete runLedger.firstSceneReview;
  }
  const maxCredits = options.get("--max-credits");
  const review = firstSceneReview(runLedger, sceneIds, options.get("--review-first"));
  if (review.accepted && review.required) {
    runLedger.firstSceneReview = { sha256: review.sha256, scene: review.scene, reviewedAt: new Date().toISOString() };
  }
  if (options.has("--max-credits")) {
    productionSpend(runLedger, [], maxCredits);
    runLedger.spendCapCredits = Number(maxCredits);
  }
  saveLedger(ledgerFile, runLedger);
  if (pending.length > 0) {
    const cap = approve === "all" ? Infinity : Number(approve);
    const over = pending.filter((quote) => !(quote.amountUnits <= cap));
    if (!approve || over.length > 0 || maxCredits === undefined) {
      return { ok: false, needs: "approval", steps, quotes: pending, totalCannonCredits: total, creditUnit: "cannon-credit", message: `Present all quotes and the production total. Set --max-credits to the approved total ceiling and --approve all (or a per-scene credit cap). The first scene is reviewed before the rest can submit.${gateNote}` };
    }
    const spending = productionSpend(runLedger, pending, maxCredits);
    if (!spending.withinLimit) return { ok: false, needs: "budget", ...spending, message: "This production would exceed the approved ceiling, including previous and uncertain attempts. No new submissions were made." };
    const renderRequest=await ensureProductionRenderRequest({ledgerFile,projectId,members:productionRequestMembers(sceneIds,prepDir,cast)});
    if(renderRequest) steps.push({step:"render-request",...renderRequest});
    const permitted = review.accepted ? pending : pending.filter((quote) => quote.scene === sceneIds[0]);
    await mapWithConcurrency(permitted, concurrency, (quote) => verbSubmit(new Map([["--scene", quote.scene], ["--approve-units", String(quote.amountUnits)], ["--reference", `${production.title} ${quote.scene}`]]), ledgerFile));
    steps.push({ step: "submit", count: permitted.length, concurrency, spending });
  } else if (runLedger.renderRequest || sceneIds.some(id => runLedger.scenes[id].customerRequest || runLedger.scenes[id].generation?.submission?.customerRequest)) {
    // Already-owned scenes still form one requested film. Recover/compose its
    // scope even when this invocation needs no new generation purchases.
    const renderRequest=await ensureProductionRenderRequest({ledgerFile,projectId,members:productionRequestMembers(sceneIds,prepDir,cast)});
    if(renderRequest) steps.push({step:"render-request",...renderRequest});
  }

  // 6. Poll every scene, then fetch content.
  const permittedSceneIds = review.accepted ? sceneIds : sceneIds.slice(0, 1);
  const outcomes = await mapWithConcurrency(permittedSceneIds, concurrency, async (id) => {
    try {
      const current = loadLedger(ledgerFile).scenes[id];
      if (await verifiedLocalArtifact(current.downloaded)) return { scene: id, status: "downloaded", path: current.downloaded.path, replayed: true };
      const polled = TERMINAL.has(current.generation?.status) ? { status: current.generation.status, errorCode: current.generation.errorCode ?? null } : await verbPoll(new Map([["--scene", id]]), ledgerFile);
      if (polled.status !== "succeeded") return { scene: id, status: polled.status, errorCode: polled.errorCode };
      const fetched = await verbContent(new Map([["--scene", id], ["--out", path.join(workDir, "clips")], ["--name", `slopcannon-scene-${id.slice(2)}-take-01.mp4`]]), ledgerFile);
      return { scene: id, status: "downloaded", path: fetched.path };
    } catch (error) {
      return { scene: id, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  });
  steps.push({ step: "content", concurrency, outcomes });
  const failed = outcomes.filter((outcome) => outcome.status !== "downloaded");
  if (failed.length > 0) return { ok: false, needs: "review", steps, failed, message: "Some scenes did not deliver. Keep this ledger for recovery. Put revised inputs in a new workDir and use a new --ledger so the prior paid revision remains intact." };
  // 6b. The character check of each delivered take, where the server offers it (no credits; a stored answer is reused).
  const checkable = (loadLedger(ledgerFile).generation?.mcpTools ?? []).includes("slopcannon_check_take");
  const scenePlan = (id) => JSON.parse(readFileSync(path.join(prepDir, "scene-plans", `${id}.json`), "utf8"));
  const runChecks = async (ids) => mapWithConcurrency(ids, concurrency, async (id) => {
    try {
      return await checkScene(ledgerFile, id, { plan: scenePlan(id), cast });
    } catch (error) {
      return uncheckedResult(id, error);
    }
  });
  if (!review.accepted) {
    const firstCheck = checkable ? (await runChecks([sceneIds[0]]))[0] : null;
    if (firstCheck) steps.push({ step: "check", checks: [firstCheck] });
    const checkpoint = firstSceneReview(loadLedger(ledgerFile), sceneIds);
    const warnings = production.transcript
      ? directionWarnings({ transcript: JSON.parse(readFileSync(resolveInput(production.transcript), "utf8")), directions: production, plan })
      : [];
    return {
      ok: false, needs: "first_scene_review", steps, ...checkpoint, ...(warnings.length > 0 ? { directionWarnings: warnings } : {}),
      ...(firstCheck ? { shotCheck: firstCheck } : {}),
      message: "Review this first downloaded scene for references, ratio and performance: look at frames across the vocal window and confirm the singer is on screen with the mouth moving on the words. Only after approval, resume with --review-first <the exact sha256 shown here>; the remaining scenes have not been submitted." + (warnings.length > 0 ? " The direction warnings name scenes likely to lose lip-sync; fix them in a new revision before approving." : ""),
    };
  }

  if (checkable) {
    const checks = await runChecks(sceneIds);
    steps.push({ step: "check", checks });
    const accepted = acceptedChecks(options.get("--accept-checks"), sceneIds);
    const flagged = checks.filter((check) => check.verdict === "fail" && !accepted.has(check.scene));
    const unchecked = checks.filter((check) => check.verdict === "unchecked")
      .map(({ scene: id, reason, code, retryable }) => ({ scene: id, reason, code: code ?? null, retryable: retryable === true }));
    if (flagged.length > 0) {
      return {
        ok: false, needs: "shot_review", steps, flagged, ...(unchecked.length > 0 ? { unchecked } : {}),
        message: "The character check flagged these takes. Show the person each issue at its second; nothing has been assembled. Resume with --accept-checks naming the scenes they accept, or reroll a scene with their approval (reroll --scene <id>, a new paid generation) and finish with cut." + uncheckedMessage(unchecked),
      };
    }
  }
  const uncheckedAtAssembly = checkable ? uncheckedTakes(loadLedger(ledgerFile), sceneIds) : [];

  // 7. Assemble the already-owned selected takes on the server.
  const output = path.join(workDir, `${production.title.replace(/[^A-Za-z0-9._-]+/g, "-")}.mp4`);
  if (assemblyMode === "local") {
    const manifest = manifestFromPlan(plan, song, (await fileDigest(song)).sha256);
    const finished = loadLedger(ledgerFile);
    for (const [index, clip] of manifest.scenes.entries()) {
      const downloaded = finished.scenes[sceneIds[index]].downloaded;
      clip.clip.sha256 = downloaded.sha256;
      clip.clip.bytes = downloaded.bytes;
    }
    const report = await finishLocalProduction({ ledgerFile, manifest, manifestFile: path.join(workDir, "assembly-manifest.json"), song, clipsDir: path.join(workDir, "clips"), output,
      plan,title:production.title,rights:rightsVersion });
    steps.push({ step: "assemble", server: false, ok: report.ok });
    return { ok: report.ok === true, steps, output: report.output, report, ...(uncheckedAtAssembly.length > 0 ? { unchecked: uncheckedAtAssembly, message: uncheckedMessage(uncheckedAtAssembly).trim() } : {}) };
  }
  const report = await finishServerProduction({ ledgerFile, plan, title: production.title, output });
  steps.push({ step: "assemble", server: true, ok: report.ok });
  return { ok: report.ok === true, steps, output: report.output, report, ...(uncheckedAtAssembly.length > 0 ? { unchecked: uncheckedAtAssembly } : {}),
    message: "Review the master for identity, mouth timing and take quality; sync verification does not judge those." + uncheckedMessage(uncheckedAtAssembly) };
}

// ---------------------------------------------------------------- main

export async function main(argv) {
  const { verb, options } = parseArgs(argv);
  const ledgerFile = path.resolve(options.get("--ledger") ?? "slopcannon-agent.json");
  const local = ["status", "plan", "manifest", "assemble"].includes(verb) || (verb === "prepare" && !options.has("--server"));
  if (local) return dispatch(verb, options, ledgerFile);
  const lockPath = `${ledgerFile}.lock`;
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  let lock;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`This ledger is locked by another command: ${lockPath}. Do not run concurrent spend commands. If a process crashed, verify it stopped and recover its original jobs before removing this lock.`);
    throw error;
  }
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await dispatch(verb, options, ledgerFile);
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

async function dispatch(verb, options, ledgerFile) {
  switch (verb) {
    case "caps": return verbCaps(options, ledgerFile);
    case "rights": return verbRights(options, ledgerFile);
    case "project": return verbProject(options, ledgerFile);
    case "upload": return verbUpload(options, ledgerFile);
    case "plan": return verbPlan(options, ledgerFile);
    case "prepare": return verbPrepare(options, ledgerFile);
    case "quote": return verbQuote(options, ledgerFile);
    case "submit": return verbSubmit(options, ledgerFile);
    case "recover": return verbRecover(options, ledgerFile);
    case "retry-failed": return verbRetryFailed(options, ledgerFile);
    case "poll": return verbPoll(options, ledgerFile);
    case "content": return verbContent(options, ledgerFile);
    case "manifest": return verbManifest(options);
    case "assemble": return verbAssemble(options);
    case "workspace": return verbWorkspace(options, ledgerFile);
    case "cuts": return verbCuts(options, ledgerFile);
    case "direct": return verbDirect(options, ledgerFile);
    case "select": return verbSelect(options, ledgerFile);
    case "check": return verbCheck(options, ledgerFile);
    case "reroll": return verbReroll(options, ledgerFile);
    case "cut": return verbCut(options, ledgerFile);
    case "usage": return verbUsage(options, ledgerFile);
    case "status": return verbStatus(ledgerFile);
    case "run": return verbRun(options, ledgerFile);
    case "character": return verbCharacter(options, ledgerFile);
    case "publish-link": return verbPublishLink(options, ledgerFile);
    case "spot": return verbSpot(options, ledgerFile);
    case "pitch": return verbPitch(options, ledgerFile);
    default: throw new Error(usage());
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result && result.ok === false) process.exitCode = result.needs ? 2 : 1;
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message.slice(0, MAX_ERROR_TEXT), code: error?.code ?? null })}\n`);
    process.exitCode = 1;
  });
}
