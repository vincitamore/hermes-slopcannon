/**
 * The end card: a picture drawn outside the video model (whose lettering cannot be trusted), laid over the last scene of a
 * film from a chosen frame to the end. It arrives as a PNG at exactly the film's frame size and is never scaled. The PNG is
 * read here, with Node's own zlib, rather than by FFmpeg's PNG decoder, which needs a library the renderer image is not
 * proven to carry; FFmpeg receives raw RGBA frames, a format every build reads.
 */
import { inflateSync } from "node:zlib";
import { open } from "node:fs/promises";

/** How long the card takes to fade in: about 300 ms, rounded to whole frames (7 at 24 fps, 9 at 30). */
export const END_CARD_FADE_IN_MS = 300;
/** The largest card accepted, the hosted image asset limit. */
export const END_CARD_MAX_BYTES = 50 * 1024 * 1024;
const MAX_SIDE = 4096;
/**
 * The most chunks a card may hold. Encoders split the picture into IDAT chunks of 8 KiB to 1 MiB, so a 50 MiB card holds at
 * most about 6,400; this bound is ten times that.
 */
const MAX_CHUNKS = 65_536;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The renderer's refusals of a card, each one fixed sentence the private service contract recognises and the app turns into
 * customer words (`endCardRefusal` in app/hosted/native-assembly-contract.ts).
 */
export function endCardRefusal(reason, details = {}) {
  const sentence = reason === "size"
    ? `End card refused: it is ${details.width}x${details.height} pixels and this film is ${details.filmWidth}x${details.filmHeight}.`
    : reason === "unreadable"
      ? "End card refused: the PNG could not be read (interlaced or damaged)."
      : "End card refused: the file is not a PNG image.";
  return Object.assign(new Error(sentence), { endCardRefusal: reason });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The PNG header fields, read from the signature and the first (IHDR) chunk; null when the bytes are not a PNG. */
export function pngHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    compression: bytes[26],
    filter: bytes[27],
    interlace: bytes[28],
  };
}

/** The first 33 bytes of a file are enough to say whether it is a PNG and how large. */
export async function readPngHeader(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(33);
    const { bytesRead } = await handle.read(buffer, 0, 33, 0);
    return pngHeader(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG to 8-bit RGBA, refusing anything but a well-formed, non-interlaced PNG of exactly `width` x `height`. The size
 * is checked from the header before anything is inflated, so a wrong or hostile file costs nothing. Colour is taken as sRGB;
 * gamma and colour-profile chunks are ignored, as browsers write none that would change the drawn pixels.
 */
export function decodeEndCardPng(bytes, { width: filmWidth, height: filmHeight }) {
  const header = pngHeader(bytes);
  if (!header) throw endCardRefusal("not-png");
  const { width, height, bitDepth, colorType } = header;
  if (width !== filmWidth || height !== filmHeight) throw endCardRefusal("size", { width, height, filmWidth, filmHeight });
  if (!(width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE) || !DEPTHS[colorType]?.includes(bitDepth) ||
      header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) throw endCardRefusal("unreadable");
  // The compressed picture is copied into one buffer sized by the file, never one object per chunk, and the walk is bounded:
  // a file of millions of empty chunks is refused rather than held in memory.
  let palette = null; let transparency = null; const data = Buffer.allocUnsafe(bytes.length); let dataLength = 0;
  let offset = 8; let sawEnd = false;
  for (let chunks = 0; offset + 12 <= bytes.length; chunks += 1) {
    if (chunks >= MAX_CHUNKS) throw endCardRefusal("unreadable");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) throw endCardRefusal("unreadable");
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw endCardRefusal("unreadable");
    if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") dataLength += body.copy(data, dataLength);
    else if (type === "IEND") { sawEnd = true; break; }
    offset += 12 + length;
  }
  if (!sawEnd || dataLength === 0 || (colorType === 3 && (!palette || palette.length % 3 !== 0))) throw endCardRefusal("unreadable");
  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil(width * bitsPerPixel / 8);
  const pixelBytes = Math.max(1, bitsPerPixel >> 3);
  const expected = height * (rowBytes + 1);
  let raw;
  try { raw = inflateSync(data.subarray(0, dataLength), { maxOutputLength: expected + 1 }); } catch { throw endCardRefusal("unreadable"); }
  if (raw.length !== expected) throw endCardRefusal("unreadable");
  // Undo each row's filter in place: the previous row is already unfiltered.
  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1); const filter = raw[start]; const row = start + 1; const above = row - rowBytes - 1;
    if (filter > 4) throw endCardRefusal("unreadable");
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= pixelBytes ? raw[row + x - pixelBytes] : 0;
      const up = y > 0 ? raw[above + x] : 0;
      const upLeft = y > 0 && x >= pixelBytes ? raw[above + x - pixelBytes] : 0;
      const value = raw[row + x];
      raw[row + x] = filter === 0 ? value : filter === 1 ? value + left : filter === 2 ? value + up
        : filter === 3 ? value + ((left + up) >> 1) : value + paeth(left, up, upLeft);
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  const maxSample = (1 << bitDepth) - 1;
  const sample = (row, index) => {
    if (bitDepth === 8) return raw[row + index];
    if (bitDepth === 16) return raw.readUInt16BE(row + index * 2);
    const bit = index * bitDepth;
    return (raw[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & maxSample;
  };
  const to8 = (value) => bitDepth === 8 ? value : bitDepth === 16 ? Math.round(value / 257) : Math.round(value * 255 / maxSample);
  const key = transparency && colorType === 0 && transparency.length >= 2 ? transparency.readUInt16BE(0)
    : transparency && colorType === 2 && transparency.length >= 6 ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)] : null;
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      if (colorType === 3) {
        const entry = sample(row, x);
        if (entry * 3 + 2 >= palette.length) throw endCardRefusal("unreadable");
        rgba[out] = palette[entry * 3]; rgba[out + 1] = palette[entry * 3 + 1]; rgba[out + 2] = palette[entry * 3 + 2];
        rgba[out + 3] = transparency && entry < transparency.length ? transparency[entry] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const gray = sample(row, x * channels);
        rgba[out] = rgba[out + 1] = rgba[out + 2] = to8(gray);
        rgba[out + 3] = colorType === 4 ? to8(sample(row, x * channels + 1)) : key !== null && gray === key ? 0 : 255;
      } else {
        const r = sample(row, x * channels); const g = sample(row, x * channels + 1); const b = sample(row, x * channels + 2);
        rgba[out] = to8(r); rgba[out + 1] = to8(g); rgba[out + 2] = to8(b);
        rgba[out + 3] = colorType === 6 ? to8(sample(row, x * channels + 3))
          : key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
      }
    }
  }
  return { width, height, rgba };
}

/**
 * Where the card sits in its scene's frames. `fromFrame` is the first scene frame that shows it (counted on the film's absolute
 * grid, as a black tail is), `frames` how many it covers (to the scene's end) and `fadeInFrames` how many of those ramp its
 * opacity up: the first shows it at 1/fadeInFrames of its drawn alpha, the last at full.
 *
 * Every moment inside the scene places the card: one in the scene's last half-frame rounds to the scene's end frame, so it is
 * drawn on the scene's last frame instead (as drawn, with no fade). The app accepts any `fromLocalMs` below the scene's length
 * without knowing the frame rate, so no accepted cut can fail here. `nativeEndCardProofValid` in the service contract computes
 * the same placement.
 */
export function endCardPlacement({ sceneStartMs, sceneEndMs, fromLocalMs, sceneStartFrame, sceneFrames, frameRate }) {
  if (!(Number.isSafeInteger(fromLocalMs) && fromLocalMs >= 0 && sceneStartMs + fromLocalMs < sceneEndMs && sceneFrames >= 1)) {
    throw new Error("The end card must start at a moment inside the last scene.");
  }
  const fromFrame = Math.max(0, Math.min(Math.round((sceneStartMs + fromLocalMs) * frameRate.rate / 1000) - sceneStartFrame, sceneFrames - 1));
  const frames = sceneFrames - fromFrame;
  const fadeInFrames = Math.max(1, Math.min(frames, Math.round(END_CARD_FADE_IN_MS * frameRate.rate / 1000)));
  return { fromFrame, frames, fadeInFrames };
}

/** The alpha of a drawn pixel at fade step `step` of `fadeInFrames` (1-based; the last step is the drawn alpha). */
export function endCardFadeAlpha(alpha, step, fadeInFrames) {
  return step >= fadeInFrames ? alpha : Math.round(alpha * step / fadeInFrames);
}

/**
 * Write the card's fade to `file` as raw RGBA frames, one per fade step: step i keeps the drawn colour and scales the drawn
 * alpha by i / fadeInFrames, rounded. The last frame is the card exactly as drawn, and the renderer holds it to the scene's
 * end. One frame is in memory at a time.
 */
export async function writeEndCardFadeFrames(file, rgba, fadeInFrames) {
  const handle = await open(file, "wx", 0o600);
  const writeAll = async (buffer) => {
    for (let written = 0; written < buffer.length;) written += (await handle.write(buffer, written, buffer.length - written)).bytesWritten;
  };
  try {
    const frame = Buffer.alloc(rgba.length);
    for (let step = 1; step <= fadeInFrames; step += 1) {
      if (step === fadeInFrames) { await writeAll(rgba); break; }
      rgba.copy(frame);
      for (let index = 3; index < frame.length; index += 4) frame[index] = endCardFadeAlpha(rgba[index], step, fadeInFrames);
      await writeAll(frame);
    }
  } finally { await handle.close(); }
}
