/**
 * Three-layer invisible provenance watermarking for SLOPCANNON assembled masters:
 *   1. Layer 1 (Container metadata): `SLOPCANNON:v1:<16-hex>` in MP4 `moov.udta` comment metadata (instant zero-decode check on untouched files).
 *   2. Layer 2 (Visual luma spread-spectrum): 64-bit payload spread across 32x32 (1,024) zero-mean 2x2 Hadamard saddle quads in the Y plane via orthogonal Walsh-Hadamard carriers, fused into the existing scene encode pass (`blend=c0_mode=grainmerge`). Survives social transcoding (X/TikTok/YouTube CRF 28), 2K->480p rescaling, FPS conversion, and audio replacement while keeping exact zero DC mean on every 2x2 quad.
 *   3. Layer 3 (Inaudible audio spread-spectrum): 64-bit BPSK direct-sequence spread-spectrum carrier at 2,000 Hz (8,000 Hz base rate, 4,096-sample period = 0.512 s) mixed at -42 dB into the master audio during muxing. Survives screen recording, arbitrary time trimming, and AAC/Opus re-encoding.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const PROVENANCE_WATERMARK_VERSION = "slopcannon-3layer-v1";
export const PROVENANCE_WATERMARK_MAGIC = 0x5343; // "SC"
export const PROVENANCE_METADATA_PREFIX = "SLOPCANNON:v1:";

const NUM_BITS = 64;
const NUM_QUADS = 1024; // 32x32 2x2 saddle quads = 64x64 canonical luma grid
const QUAD_SIDE = 32;
const GRAY_SIDE = 64;
export const AUDIO_WATERMARK_SAMPLE_RATE = 8000;
const SAMPLES_PER_CHIP = 4; // 2,000 Hz carrier (+1, -1, +1, -1) at 8,000 Hz
export const AUDIO_WATERMARK_BLOCK_SAMPLES = NUM_QUADS * SAMPLES_PER_CHIP; // 4,096 samples (0.512 s)

/** CRC-16-CCITT (poly 0x1021, init 0xFFFF) over a byte buffer. */
export function crc16Ccitt(bytes) {
  let crc = 0xffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc >>> 0;
}

function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * 64 mutually orthogonal Walsh-Hadamard carriers of length 1,024, permuted and sign-whitened
 * by a fixed deterministic PRNG seed so each carrier is zero-mean and spatially flat.
 */
const CARRIERS_1K = (() => {
  let seed = 0x534c4f50; // "SLOP"
  const nextRand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const perm = new Uint16Array(NUM_QUADS);
  for (let i = 0; i < NUM_QUADS; i += 1) perm[i] = i;
  for (let i = NUM_QUADS - 1; i > 0; i -= 1) {
    const j = nextRand() % (i + 1);
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  const signMask = new Int8Array(NUM_QUADS);
  for (let q = 0; q < NUM_QUADS; q += 1) signMask[q] = (nextRand() & 1) ? 1 : -1;

  const rows = new Array(NUM_BITS);
  for (let b = 0; b < NUM_BITS; b += 1) {
    const rowIdx = ((b + 1) * 13) & 0x3ff || (b + 1);
    const row = new Int8Array(NUM_QUADS);
    for (let q = 0; q < NUM_QUADS; q += 1) {
      const h = (popcount32(rowIdx & perm[q]) & 1) ? -1 : 1;
      row[q] = h * signMask[q];
    }
    rows[b] = row;
  }
  return rows;
})();

/** Pack a 32-bit unsigned watermark tag into the 64-bit `[0x5343 | tagU32 | crc16]` frame. */
export function packProvenancePayload(tagU32) {
  const tag = tagU32 >>> 0;
  const bytes = Buffer.alloc(8);
  bytes.writeUInt16BE(PROVENANCE_WATERMARK_MAGIC, 0);
  bytes.writeUInt32BE(tag, 2);
  const crc16 = crc16Ccitt(bytes.subarray(0, 6));
  bytes.writeUInt16BE(crc16, 6);
  const bits = new Int8Array(NUM_BITS);
  for (let i = 0; i < NUM_BITS; i += 1) {
    const byte = bytes[i >> 3];
    const bit = (byte >> (7 - (i & 7))) & 1;
    bits[i] = bit ? 1 : -1;
  }
  const quadGrid = new Int8Array(NUM_QUADS);
  for (let q = 0; q < NUM_QUADS; q += 1) {
    let acc = 0;
    for (let b = 0; b < NUM_BITS; b += 1) acc += bits[b] * CARRIERS_1K[b][q];
    let delta = Math.max(-2, Math.min(2, Math.round((acc * 1.4) / 8)));
    if (delta === 0) delta = acc >= 0 ? 1 : -1;
    quadGrid[q] = delta;
  }
  const hex = bytes.toString("hex");
  return Object.freeze({
    version: PROVENANCE_WATERMARK_VERSION,
    magic: PROVENANCE_WATERMARK_MAGIC,
    tag,
    crc16,
    hex,
    metadataComment: `${PROVENANCE_METADATA_PREFIX}${hex}`,
    bytes,
    bits,
    quadGrid,
  });
}

/**
 * Derive a deterministic 64-bit provenance watermark from a cut's canonical audio and scene takes.
 * Keyed on the base cut (duration, primary source SHA-256, and each scene's timing and take SHA-256)
 * so policies that share a base cut (e.g. v3/v5, v4/v6, and non-card scenes of v5/v7) carry the
 * identical watermark tag.
 */
export function deriveProvenanceWatermark(manifest) {
  const primarySha256 = String(manifest?.masterAudio?.sha256 ?? manifest?.sourceVideo?.sha256 ?? "").toLowerCase();
  const scenes = Array.isArray(manifest?.scenes)
    ? manifest.scenes.map((scene) => ({
        id: scene.id,
        start: scene.startMs ?? scene.startFrame ?? 0,
        end: scene.endMs ?? scene.endFrame ?? 0,
        clipSha256: String(scene.clip?.sha256 ?? "").toLowerCase(),
      }))
    : [];
  const digest = createHash("sha256")
    .update(`slopcannon-provenance-v1:${manifest?.durationMs ?? 0}:${primarySha256}:${JSON.stringify(scenes)}`)
    .digest();
  return packProvenancePayload(digest.readUInt32BE(0));
}

/** Parse and validate a Layer 1 `SLOPCANNON:v1:<16-hex>` metadata comment or embedded tag string. */
export function parseProvenanceMetadataComment(text) {
  if (typeof text !== "string") return null;
  const match = /SLOPCANNON:v1:([0-9a-fA-F]{16})/.exec(text);
  if (!match) return null;
  const hex = match[1].toLowerCase();
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length !== 8) return null;
  const magic = bytes.readUInt16BE(0);
  const tag = bytes.readUInt32BE(2) >>> 0;
  const crc16 = bytes.readUInt16BE(6);
  if (magic !== PROVENANCE_WATERMARK_MAGIC || crc16 !== crc16Ccitt(bytes.subarray(0, 6))) return null;
  return {
    valid: true,
    layer: "container-metadata",
    version: PROVENANCE_WATERMARK_VERSION,
    hex,
    tag,
    crc16,
  };
}

/**
 * Scan the head and tail of an MP4 file on disk for the Layer 1 `SLOPCANNON:v1:<16-hex>` box payload
 * without spawning ffprobe. Fast-start MP4s store `moov.udta` in the first 256 KiB.
 */
export async function scanFileForProvenanceMetadata(filePath, windowBytes = 512 * 1024) {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size <= 0) return null;
    const headLen = Math.min(size, windowBytes);
    const head = Buffer.allocUnsafe(headLen);
    const { bytesRead } = await handle.read(head, 0, headLen, 0);
    const fromHead = parseProvenanceMetadataComment(head.subarray(0, bytesRead).toString("latin1"));
    if (fromHead) return fromHead;
    if (size > windowBytes) {
      const tailLen = Math.min(size - windowBytes, windowBytes);
      const tail = Buffer.allocUnsafe(tailLen);
      const { bytesRead: tailRead } = await handle.read(tail, 0, tailLen, size - tailLen);
      return parseProvenanceMetadataComment(tail.subarray(0, tailRead).toString("latin1"));
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Build an exact `width x height` 1-frame `yuv420p` residual buffer for FFmpeg `blend=c1_mode=grainmerge`.
 * - Plane 0 (`Y` luma) and Plane 2 (`V` / `Cr`) are 100% untouched (`128` everywhere — zero luma change).
 * - Plane 1 (`U` / `Cb` blue-difference chroma, `width/2 x height/2`) uses Feathered-Dome Pulse-Area Modulation
 *   at strictly `{-1, 0, +1}` LSB (`127..129`), where each subcell's soft circular dome radius scales with
 *   `|quadGrid[q]|` and tapers to a neutral `128` moat before the subcell boundary (eliminating step edges).
 * - Every 2x2 saddle quad has exact zero DC sum (`(+d) + (-d) + (-d) + (+d) = 0`).
 */
const BAYER_4X4 = [
  [0.0625, 0.5625, 0.1875, 0.6875],
  [0.8125, 0.3125, 0.9375, 0.4375],
  [0.2500, 0.7500, 0.1250, 0.6250],
  [1.0000, 0.5000, 0.8750, 0.3750],
];

export function buildVideoWatermarkYuv420p(width, height, watermarkOrGrid) {
  const quadGrid = watermarkOrGrid?.quadGrid ?? watermarkOrGrid;
  if (!(quadGrid instanceof Int8Array) || quadGrid.length !== NUM_QUADS) {
    throw new Error("Video watermark requires a 1,024-element quadGrid.");
  }
  const ySize = width * height;
  const uWidth = width >> 1;
  const uHeight = height >> 1;
  const uSize = uWidth * uHeight;
  const buffer = Buffer.allocUnsafe(ySize + uSize * 2);
  buffer.fill(128);

  const uPlane = buffer.subarray(ySize, ySize + uSize);
  for (let qy = 0; qy < QUAD_SIDE; qy += 1) {
    const yStart = Math.round((qy * 2 * uHeight) / GRAY_SIDE);
    const yMid = Math.round(((qy * 2 + 1) * uHeight) / GRAY_SIDE);
    const yEnd = Math.round(((qy * 2 + 2) * uHeight) / GRAY_SIDE);
    const halfH = Math.min(yMid - yStart, yEnd - yMid);
    if (halfH <= 0) continue;

    for (let qx = 0; qx < QUAD_SIDE; qx += 1) {
      const xStart = Math.round((qx * 2 * uWidth) / GRAY_SIDE);
      const xMid = Math.round(((qx * 2 + 1) * uWidth) / GRAY_SIDE);
      const xEnd = Math.round(((qx * 2 + 2) * uWidth) / GRAY_SIDE);
      const halfW = Math.min(xMid - xStart, xEnd - xMid);
      if (halfW <= 0) continue;

      const qVal = quadGrid[qy * QUAD_SIDE + qx];
      const baseSign = qVal >= 0 ? 1 : -1;
      const mag = Math.abs(qVal);
      const compactSubcell = halfW <= 8 || halfH <= 8;
      const r2Max = compactSubcell
        ? (mag === 1 ? 0.24 : (mag === 2 ? 0.36 : 0.48))
        : (mag === 1 ? 0.12 : (mag === 2 ? 0.21 : 0.28));
      const feather = compactSubcell ? 0.12 : 0.09;

      for (let ly = 0; ly < halfH; ly += 1) {
        const dy = halfH === 1 ? 0 : (ly + 0.5) / halfH - 0.5;
        const by = ly & 3;
        const rowTop = (yMid - halfH + ly) * uWidth;
        const rowBot = (yMid + ly) * uWidth;
        for (let lx = 0; lx < halfW; lx += 1) {
          const dx = halfW === 1 ? 0 : (lx + 0.5) / halfW - 0.5;
          const bx = lx & 3;
          const r2 = dx * dx + dy * dy;
          let prob = 0;
          if (r2 <= r2Max - feather * 0.5) prob = 1.0;
          else if (r2 < r2Max + feather * 0.5) prob = 1.0 - (r2 - (r2Max - feather * 0.5)) / feather;
          if (prob >= BAYER_4X4[by][bx]) {
            const colLeft = xMid - halfW + lx;
            const colRight = xMid + lx;
            uPlane[rowTop + colLeft] = 128 + baseSign;
            uPlane[rowTop + colRight] = 128 - baseSign;
            uPlane[rowBot + colLeft] = 128 - baseSign;
            uPlane[rowBot + colRight] = 128 + baseSign;
          }
        }
      }
    }
  }
  return buffer;
}

/**
 * Build a 4,096-sample (0.512 s at 8,000 Hz, 8,236 bytes) 16-bit mono WAV containing the
 * 64-bit BPSK direct-sequence spread-spectrum audio carrier at 2,000 Hz.
 */
export function buildAudioWatermarkWav8k(watermarkOrBits) {
  const bits = watermarkOrBits?.bits ?? watermarkOrBits;
  if (!(bits instanceof Int8Array) || bits.length !== NUM_BITS) {
    throw new Error("Audio watermark requires a 64-element bit array.");
  }
  const wav = Buffer.alloc(44 + AUDIO_WATERMARK_BLOCK_SAMPLES * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(AUDIO_WATERMARK_SAMPLE_RATE, 24);
  wav.writeUInt32LE(AUDIO_WATERMARK_SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(AUDIO_WATERMARK_BLOCK_SAMPLES * 2, 40);

  for (let q = 0; q < NUM_QUADS; q += 1) {
    let acc = 0;
    for (let b = 0; b < NUM_BITS; b += 1) acc += bits[b] * CARRIERS_1K[b][q];
    const sample = Math.max(-32767, Math.min(32767, Math.round((acc / 8) * 12000)));
    const offset = 44 + q * SAMPLES_PER_CHIP * 2;
    wav.writeInt16LE(sample, offset);
    wav.writeInt16LE(-sample, offset + 2);
    wav.writeInt16LE(sample, offset + 4);
    wav.writeInt16LE(-sample, offset + 6);
  }
  return wav;
}

function decodeBitsFromChips(chips, normScale = 32, minMeanZ = 1.25) {
  let variance = 0;
  for (let q = 0; q < NUM_QUADS; q += 1) variance += chips[q] * chips[q];
  const std = Math.sqrt(variance / NUM_QUADS) || 1;

  const scores = new Float64Array(NUM_BITS);
  const recoveredBits = new Int8Array(NUM_BITS);
  for (let b = 0; b < NUM_BITS; b += 1) {
    let dot = 0;
    const carrier = CARRIERS_1K[b];
    for (let q = 0; q < NUM_QUADS; q += 1) dot += (chips[q] / std) * carrier[q];
    scores[b] = dot / normScale;
    recoveredBits[b] = scores[b] >= 0 ? 1 : -1;
  }

  const packBitsToBytes = (bitArr) => {
    const b = Buffer.alloc(8);
    for (let i = 0; i < NUM_BITS; i += 1) {
      if (bitArr[i] > 0) b[i >> 3] |= 1 << (7 - (i & 7));
    }
    return b;
  };

  let outBytes = packBitsToBytes(recoveredBits);
  let magic = outBytes.readUInt16BE(0);
  let crc16 = outBytes.readUInt16BE(6);
  let expectedCrc = crc16Ccitt(outBytes.subarray(0, 6));
  let sumAbsZ = 0;
  let minAbsZ = Infinity;
  for (let b = 0; b < NUM_BITS; b += 1) {
    const z = Math.abs(scores[b]);
    sumAbsZ += z;
    if (z < minAbsZ) minAbsZ = z;
  }
  const meanAbsZ = sumAbsZ / NUM_BITS;

  // Minimum-distance Chase-8 soft-decision CRC recovery: when the 16-bit magic (0x5343) and
  // meanAbsZ >= minMeanZ confirm the carrier is present, test flipping subsets of the 8 lowest-|z|
  // bits in [16..63] ordered by minimum Euclidean distance (sum of flipped |z| scores).
  if (magic === PROVENANCE_WATERMARK_MAGIC && crc16 !== expectedCrc && meanAbsZ >= minMeanZ) {
    const weakIndices = Array.from({ length: 48 }, (_, k) => k + 16)
      .sort((a, b) => Math.abs(scores[a]) - Math.abs(scores[b]))
      .slice(0, 8);
    const masks = Array.from({ length: 255 }, (_, i) => i + 1).sort((m1, m2) => {
      let w1 = 0;
      let w2 = 0;
      for (let j = 0; j < 8; j += 1) {
        if (m1 & (1 << j)) w1 += Math.abs(scores[weakIndices[j]]);
        if (m2 & (1 << j)) w2 += Math.abs(scores[weakIndices[j]]);
      }
      return w1 - w2;
    });
    for (const mask of masks) {
      const candidateBits = Int8Array.from(recoveredBits);
      for (let j = 0; j < 8; j += 1) {
        if (mask & (1 << j)) candidateBits[weakIndices[j]] = -candidateBits[weakIndices[j]];
      }
      const candBytes = packBitsToBytes(candidateBits);
      const candCrc = candBytes.readUInt16BE(6);
      if (candCrc === crc16Ccitt(candBytes.subarray(0, 6))) {
        outBytes = candBytes;
        crc16 = candCrc;
        expectedCrc = candCrc;
        break;
      }
    }
  }

  const tag = outBytes.readUInt32BE(2) >>> 0;
  const crcOk = crc16 === expectedCrc;
  const valid = magic === PROVENANCE_WATERMARK_MAGIC && crcOk && meanAbsZ >= minMeanZ;
  return {
    valid,
    version: PROVENANCE_WATERMARK_VERSION,
    hex: outBytes.toString("hex"),
    magic,
    tag,
    crc16,
    crcOk,
    meanAbsZ: Math.round(meanAbsZ * 100) / 100,
    minAbsZ: Math.round(minAbsZ * 100) / 100,
  };
}

/**
 * Blind Layer 2 decoder: takes 64x64 area-averaged grayscale frames (`scale=64:64:flags=area,format=gray`)
 * and extracts the 64-bit provenance payload from the 32x32 2x2 saddle quads.
 */
export function decodeVideoWatermarkFromGray64(grayFramesBuffer) {
  const frameBytes = GRAY_SIDE * GRAY_SIDE;
  const frameCount = Math.floor((grayFramesBuffer?.byteLength ?? 0) / frameBytes);
  if (frameCount <= 0) {
    return { valid: false, layer: "video-luma-dsss", reason: "no-frames", meanAbsZ: 0, minAbsZ: 0 };
  }
  const avgY = new Float64Array(frameBytes);
  for (let f = 0; f < frameCount; f += 1) {
    const base = f * frameBytes;
    for (let i = 0; i < frameBytes; i += 1) avgY[i] += grayFramesBuffer[base + i];
  }
  for (let i = 0; i < frameBytes; i += 1) avgY[i] /= frameCount;

  const quads = new Float64Array(NUM_QUADS);
  for (let qy = 0; qy < QUAD_SIDE; qy += 1) {
    for (let qx = 0; qx < QUAD_SIDE; qx += 1) {
      const x0 = qx * 2;
      const y0 = qy * 2;
      const tl = avgY[y0 * GRAY_SIDE + x0];
      const tr = avgY[y0 * GRAY_SIDE + x0 + 1];
      const bl = avgY[(y0 + 1) * GRAY_SIDE + x0];
      const br = avgY[(y0 + 1) * GRAY_SIDE + x0 + 1];
      const q = (tl - tr - bl + br) / 4;
      // Embedded Feathered-Dome Chroma-Cb deltas have subcell mean <= 0.65 LSB.
      // Quads with |q| > 1.25 are static saturated color-bar corners (e.g. testsrc2 or logos);
      // zeroing those outliers and Huber-clipping to [-0.65, +0.65] prevents static color edges from swamping the carrier.
      quads[qy * QUAD_SIDE + qx] = frameCount > 1
        ? (Math.abs(q) > 1.25 ? 0 : Math.max(-0.65, Math.min(0.65, q)))
        : q;
    }
  }
  return {
    layer: "video-luma-dsss",
    framesAnalyzed: frameCount,
    ...decodeBitsFromChips(quads, 32, 1.35),
  };
}

/** In-place iterative radix-2 FFT for O(N log N) circular shift search in audio watermark recovery. */
function fftRadix2(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const a = start + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

const MAGIC_TEMPLATE_FFT = (() => {
  const magicBits = [0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1].map((b) => (b ? 1 : -1));
  const re = new Float64Array(AUDIO_WATERMARK_BLOCK_SAMPLES);
  const im = new Float64Array(AUDIO_WATERMARK_BLOCK_SAMPLES);
  for (let q = 0; q < NUM_QUADS; q += 1) {
    let m = 0;
    for (let b = 0; b < 16; b += 1) m += magicBits[b] * CARRIERS_1K[b][q];
    const base = q * SAMPLES_PER_CHIP;
    re[base] = m;
    re[base + 1] = -m;
    re[base + 2] = m;
    re[base + 3] = -m;
  }
  fftRadix2(re, im, false);
  return { re, im };
})();

/**
 * Blind Layer 3 decoder: takes 8,000 Hz mono Float32 PCM samples, folds modulo 4,096 samples,
 * finds the unknown trim/priming phase offset via FFT cross-correlation against the 16-bit
 * `0x5343` magic preamble, and extracts all 64 bits.
 */
export function decodeAudioWatermarkFromPcm8k(pcm8kFloat32) {
  if (!pcm8kFloat32 || pcm8kFloat32.length < AUDIO_WATERMARK_BLOCK_SAMPLES) {
    return { valid: false, layer: "audio-dsss", reason: "too-short", meanAbsZ: 0, minAbsZ: 0 };
  }
  const folded = new Float64Array(AUDIO_WATERMARK_BLOCK_SAMPLES);
  const counts = new Uint32Array(AUDIO_WATERMARK_BLOCK_SAMPLES);
  for (let i = 1; i < pcm8kFloat32.length - 1; i += 1) {
    const hp = (-pcm8kFloat32[i - 1] + 2 * pcm8kFloat32[i] - pcm8kFloat32[i + 1]) / 4;
    const idx = i % AUDIO_WATERMARK_BLOCK_SAMPLES;
    folded[idx] += hp;
    counts[idx] += 1;
  }
  for (let k = 0; k < AUDIO_WATERMARK_BLOCK_SAMPLES; k += 1) {
    if (counts[k] > 0) folded[k] /= counts[k];
  }

  // Circular cross-correlation via FFT: IFFT(FFT(folded) * conj(FFT(magicTemplate)))
  const re = Float64Array.from(folded);
  const im = new Float64Array(AUDIO_WATERMARK_BLOCK_SAMPLES);
  fftRadix2(re, im, false);
  for (let k = 0; k < AUDIO_WATERMARK_BLOCK_SAMPLES; k += 1) {
    const ar = re[k];
    const ai = im[k];
    const br = MAGIC_TEMPLATE_FFT.re[k];
    const bi = -MAGIC_TEMPLATE_FFT.im[k];
    re[k] = ar * br - ai * bi;
    im[k] = ar * bi + ai * br;
  }
  fftRadix2(re, im, true);

  let bestShift = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < AUDIO_WATERMARK_BLOCK_SAMPLES; s += 1) {
    if (re[s] > bestScore) {
      bestScore = re[s];
      bestShift = s;
    }
  }

  const chips = new Float64Array(NUM_QUADS);
  for (let q = 0; q < NUM_QUADS; q += 1) {
    const base = q * SAMPLES_PER_CHIP;
    chips[q] = (
      folded[(base + bestShift) % AUDIO_WATERMARK_BLOCK_SAMPLES]
      - folded[(base + 1 + bestShift) % AUDIO_WATERMARK_BLOCK_SAMPLES]
      + folded[(base + 2 + bestShift) % AUDIO_WATERMARK_BLOCK_SAMPLES]
      - folded[(base + 3 + bestShift) % AUDIO_WATERMARK_BLOCK_SAMPLES]
    ) / 4;
  }

  return {
    layer: "audio-dsss",
    bestShift,
    ...decodeBitsFromChips(chips, 32, 2.0),
  };
}

/**
 * Inspect a media file across all three provenance watermark layers:
 *   1. Container metadata (`SLOPCANNON:v1:<16-hex>` box scan),
 *   2. Visual luma spread-spectrum (`decodeVideoWatermarkFromGray64`),
 *   3. Audio spread-spectrum (`decodeAudioWatermarkFromPcm8k`).
 */
export async function detectMediaProvenanceWatermark(filePath, { runMediaTool, execution = {}, maxAnalyzeSeconds = 30 } = {}) {
  const metadata = await scanFileForProvenanceMetadata(filePath).catch(() => null);
  let video = null;
  let audio = null;
  if (typeof runMediaTool === "function") {
    const timeArgs = maxAnalyzeSeconds > 0 ? ["-t", String(maxAnalyzeSeconds)] : [];
    const [videoResult, audioResult] = await Promise.all([
      runMediaTool("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        ...timeArgs, "-i", filePath,
        "-map", "0:v:0", "-vf", "extractplanes=u,scale=64:64:flags=area,format=gray", "-f", "rawvideo", "pipe:1",
      ], { ...execution, maxStdoutBytes: 32 * 1024 * 1024 }).then(
        ({ stdout }) => decodeVideoWatermarkFromGray64(stdout),
        () => ({ valid: false, layer: "video-luma-dsss", reason: "no-video", meanAbsZ: 0, minAbsZ: 0 }),
      ),
      runMediaTool("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        ...timeArgs, "-i", filePath,
        "-vn", "-ac", "1", "-ar", String(AUDIO_WATERMARK_SAMPLE_RATE), "-f", "f32le", "pipe:1",
      ], { ...execution, maxStdoutBytes: 16 * 1024 * 1024 }).then(
        ({ stdout }) => {
          const samples = new Float32Array(Math.floor(stdout.byteLength / 4));
          for (let i = 0; i < samples.length; i += 1) samples[i] = stdout.readFloatLE(i * 4);
          return decodeAudioWatermarkFromPcm8k(samples);
        },
        () => ({ valid: false, layer: "audio-dsss", reason: "no-audio", meanAbsZ: 0, minAbsZ: 0 }),
      ),
    ]);
    video = videoResult;
    audio = audioResult;
  }
  const winner = (video?.valid ? video : null) ?? (audio?.valid ? audio : null) ?? (metadata?.valid ? metadata : null);
  return {
    detected: Boolean(winner),
    version: PROVENANCE_WATERMARK_VERSION,
    hex: winner?.hex ?? null,
    tag: winner?.tag ?? null,
    layers: { metadata, video, audio },
  };
}
