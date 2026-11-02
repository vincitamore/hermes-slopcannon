/**
 * A film's on-screen graphics, laid over its scenes (docs/AD_GRAPHICS.md). The words are drawn outside this file, by the
 * renderer that is handed them (`drawGraphics`: the server's app/ad-graphics/render.ts), as straight-alpha RGBA plates at
 * a position in the frame; this file only places those pictures on the film's frame grid and writes their frames. Like the
 * end card, a graphic reaches FFmpeg as raw RGBA frames, a format every build reads, and is never scaled.
 *
 * Each graphic fades in over `fadeMs` rounded to whole frames (at least one), holds fully visible, and fades out the same
 * way; a graphic that crosses a cut is split between the two scenes' encodes, frame for frame.
 */
import { open } from "node:fs/promises";

const KINDS = new Set(["hook", "callout", "lower_third"]);
const ZONES = new Set(["upper", "lower"]);
const MAX_EVENTS = 12;
const MAX_CHARS = 64;

/** The structural checks the local manifest reader makes; the service contract checks the rest before a render. */
export function validateGraphicsShape(graphics, durationMs, add) {
  const record = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!record(graphics) || graphics.version !== 1 || typeof graphics.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(graphics.accent)) {
    add("$.graphics", "Must be { version: 1, accent: #rrggbb, events }.");
    return;
  }
  if (!Array.isArray(graphics.events) || graphics.events.length < 1 || graphics.events.length > MAX_EVENTS) {
    add("$.graphics.events", `Must list 1-${MAX_EVENTS} graphics.`);
    return;
  }
  let previousEnd = -Infinity;
  graphics.events.forEach((event, index) => {
    const field = `$.graphics.events[${index}]`;
    if (!record(event) || !KINDS.has(event.kind) || !ZONES.has(event.zone) || typeof event.text !== "string" || !event.text.trim()
      || [...event.text].length > MAX_CHARS) {
      add(field, "Must have a kind, a zone and 1-64 characters of text.");
      return;
    }
    if (!Number.isSafeInteger(event.fromMs) || !Number.isSafeInteger(event.toMs) || event.fromMs < 0 || event.toMs > durationMs || event.fromMs < previousEnd) {
      add(field, "Must be inside the film, after the graphic before it.");
    }
    previousEnd = event.toMs;
  });
}

/**
 * Where a graphic lands on the film's absolute frame grid: its first frame, the frame after its last, and how many of its
 * frames fade in, hold and fade out. `graphicFrames` in app/ad-graphics/contract.ts computes the same numbers for the proof.
 */
export function graphicPlacement(event, frameRate, fadeMs) {
  const fromFrame = Math.round(event.fromMs * frameRate.rate / 1000);
  const toFrame = Math.round(event.toMs * frameRate.rate / 1000);
  const fade = Math.max(1, Math.round(fadeMs * frameRate.rate / 1000));
  const holdFrames = toFrame - fromFrame - 2 * fade;
  if (holdFrames < 1) throw new Error("A graphic is too short to fade in and out at this frame rate.");
  return { fromFrame, toFrame, fadeInFrames: fade, fadeOutFrames: fade, holdFrames };
}

/** The alpha of a drawn pixel at frame `n` of a graphic (0-based): ramped up over the fade-in, held, ramped down over the fade-out. */
export function graphicFrameAlpha(alpha, n, placement) {
  const { fadeInFrames, holdFrames, fadeOutFrames } = placement;
  if (n < fadeInFrames) return Math.round(alpha * (n + 1) / (fadeInFrames + 1));
  if (n < fadeInFrames + holdFrames) return alpha;
  return Math.round(alpha * (fadeInFrames + holdFrames + fadeOutFrames - n) / (fadeOutFrames + 1));
}

/** Write frames [from, to) of a graphic as raw RGBA to `file`, one frame in memory at a time. */
export async function writeGraphicFrames(file, rgba, placement, from, to) {
  const handle = await open(file, "wx", 0o600);
  const writeAll = async (buffer) => {
    for (let written = 0; written < buffer.length;) written += (await handle.write(buffer, written, buffer.length - written)).bytesWritten;
  };
  try {
    const drawn = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const frame = Buffer.alloc(rgba.length);
    for (let n = from; n < to; n += 1) {
      if (n >= placement.fadeInFrames && n < placement.fadeInFrames + placement.holdFrames) { await writeAll(drawn); continue; }
      drawn.copy(frame);
      for (let index = 3; index < frame.length; index += 4) frame[index] = graphicFrameAlpha(rgba[index], n, placement);
      await writeAll(frame);
    }
  } finally { await handle.close(); }
}

/**
 * The parts of each graphic that fall in a scene ([sceneStartFrame, sceneEndFrame)): which frames of the graphic, and the
 * scene frame the first of them lands on. A graphic outside the scene has no part in it.
 */
export function graphicPartsInScene(placements, sceneStartFrame, sceneEndFrame) {
  const parts = [];
  placements.forEach((placement, index) => {
    const first = Math.max(placement.fromFrame, sceneStartFrame);
    const end = Math.min(placement.toFrame, sceneEndFrame);
    if (end > first) parts.push({ index, from: first - placement.fromFrame, to: end - placement.fromFrame, atFrame: first - sceneStartFrame });
  });
  return parts;
}

/**
 * The filters that lay a scene's graphic parts over its picture (`[label]`), each part an input of raw RGBA frames at its
 * plate's size, placed at the plate's position from the scene frame it lands on: the same frame clock as the end card
 * (settb to one frame, setpts=N), so frame n of the scene meets frame n - atFrame of the part, and after the part ends
 * the scene passes through untouched. Returns the label of the result.
 */
export function graphicOverlayFilters({ label, parts, inputIndex, frameRate }) {
  const [numerator, denominator] = frameRate.expression.split("/");
  const tick = `${denominator ?? 1}/${numerator}`;
  const filters = [`[${label}]settb=${tick},setpts=N[gfx0]`];
  parts.forEach((part, k) => {
    filters.push(`[${inputIndex + k}:v:0]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,settb=${tick},setpts=N+${part.atFrame}[gfxin${k}]`);
    filters.push(`[gfx${k}][gfxin${k}]overlay=x=${part.x}:y=${part.y}:format=yuv420:eof_action=pass[gfx${k + 1}]`);
  });
  return { filters, label: `gfx${parts.length}` };
}

/** One part's raw RGBA input: a demuxer every FFmpeg build carries, read only from the local file. */
export function graphicInputArgs(part, frameRate) {
  return ["-f", "rawvideo", "-format_whitelist", "rawvideo", "-protocol_whitelist", "file",
    "-pix_fmt", "rgba", "-video_size", `${part.width}x${part.height}`, "-framerate", frameRate.expression, "-i", part.file];
}
