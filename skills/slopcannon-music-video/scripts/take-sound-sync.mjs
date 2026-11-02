/**
 * Take sound sync: line a delivered take's picture up with the song.
 *
 * A song scene is rendered from a slice of the song, and the take comes back with that sound
 * and a picture whose mouths follow it. Occasionally the returned sound jumps inside the take
 * (it repeats about a second, or skips about half a second) while the picture stays continuous
 * and follows the jump. Assembly replaces the take's sound with the song, so from the jump on
 * the mouths run early or late by the jump.
 *
 * This module measures the take's own sound against the song window by window, and when the
 * offset is not constant at zero, plans a picture retiming: each film moment shows the take
 * frame whose sound is that moment of the song. A repeat drops the repeated frames, a skip
 * holds a frame. Pure functions over mono PCM; no I/O. Shared by native assembly (Node) and
 * browser assembly.
 */

/** Retained verbatim for already-accepted native v2 assembly requests. */
export const TAKE_SOUND_SYNC_V1_VERSION = "take-sound-retime-v1";
/** Current planner: detects a repair that would become a visible hold or jump. */
export const TAKE_SOUND_SYNC_VERSION = "take-sound-retime-v2";
/** Analysis sample rate. Both lanes resample to this before measuring. */
export const TAKE_SOUND_SAMPLE_RATE = 8000;
/** Two 24 fps frames. A larger discontinuity is visible and must not be silently rendered. */
export const TAKE_SOUND_MAX_VISUAL_DISCONTINUITY_MS = 80;
/** A take that sits further off the song than the planner repairs (`offset-too-large`) counts as damaged when that lag covers at least this share of its scene. */
export const TAKE_SOUND_UNSUPPORTED_COVERAGE = 0.8;

const WINDOW_SECONDS = 1.0;
const HOP_SECONDS = 0.25;
const SEARCH_SECONDS = 1.6;
/** A window counts when its normalized correlation reaches this. Some delivered takes carry
 * the song louder or mixed and sit at 0.3-0.5 while aligned to the millisecond. */
const MIN_CORRELATION = 0.35;
/** Windows whose lag agrees within this belong to one run. */
const RUN_TOLERANCE_MS = 60;
/** A run needs this many windows (about 1.5 s of take) to be trusted. */
const MIN_RUN_WINDOWS = 3;
/** Offsets within this are left alone: a healthy take reads 0 or about +21 ms, and under two
 * frames is below what a viewer resolves. Retiming smaller offsets only risks a wrong edit. */
const IN_SYNC_MS = 80;
/** A window's best match must beat its best match elsewhere (outside PEAK_EXCLUSION_MS) by this
 * much. Repetitive music matches itself a bar away; such a window says nothing about the lag. */
const MIN_PEAK_MARGIN = 0.08;
const PEAK_EXCLUSION_MS = 80;
/** Never retime by more than this; a larger offset is not a jump this module understands. */
const MAX_LAG_MS = 1500;
/** Trusted runs must cover this share of the scene before anything is changed. */
const MIN_COVERAGE = 0.4;

/** @param {number} n */
function nextPow2(n) {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/** In-place iterative radix-2 FFT. @param {Float64Array} re @param {Float64Array} im @param {boolean} inverse */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
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
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i += 1) { re[i] /= n; im[i] /= n; }
}

/**
 * Mix channels to mono and resample to TAKE_SOUND_SAMPLE_RATE (box filter, then linear
 * interpolation). Good enough for correlation; not for listening.
 * @param {ArrayLike<number>[]} channels
 * @param {number} sampleRate
 * @returns {Float32Array}
 */
export function analysisSamples(channels, sampleRate) {
  if (!channels.length) return new Float32Array(0);
  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i += 1) mono[i] += channel[i] / channels.length;
  if (sampleRate === TAKE_SOUND_SAMPLE_RATE) return mono;
  const ratio = sampleRate / TAKE_SOUND_SAMPLE_RATE;
  const width = Math.max(1, Math.round(ratio));
  const smoothed = new Float32Array(length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += mono[i];
    if (i >= width) sum -= mono[i - width];
    smoothed[i] = sum / Math.min(i + 1, width);
  }
  const outLength = Math.floor(length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio + (width - 1) / 2;
    const index = Math.min(length - 1, Math.floor(position));
    const fraction = Math.min(1, position - index);
    out[i] = smoothed[index] * (1 - fraction) + smoothed[Math.min(length - 1, index + 1)] * fraction;
  }
  return out;
}

/**
 * The take's lag against the song in 1 s windows every 0.25 s.
 * lagMs = where the take's sound at take time t really is in the song, minus where it should be.
 * @param {Float32Array} take analysis samples of the delivered take
 * @param {Float32Array} song analysis samples of the whole song
 * @param {number} sceneStartSeconds where the take's window starts in the song
 * @returns {{ t: number, lagMs: number, r: number, margin: number }[]}
 */
export function takeSoundLagTrack(take, song, sceneStartSeconds) {
  const rate = TAKE_SOUND_SAMPLE_RATE;
  const window = Math.round(WINDOW_SECONDS * rate);
  const takeSeconds = take.length / rate;
  const lo = Math.max(0, Math.floor((sceneStartSeconds - SEARCH_SECONDS) * rate));
  const hi = Math.min(song.length, Math.ceil((sceneStartSeconds + takeSeconds + SEARCH_SECONDS) * rate));
  if (hi - lo <= window || take.length < window) return [];
  const ref = song.subarray(lo, hi);
  const size = nextPow2(ref.length + window);
  const refRe = new Float64Array(size);
  const refIm = new Float64Array(size);
  refRe.set(ref);
  fft(refRe, refIm, false);
  const sums = new Float64Array(ref.length + 1);
  const squares = new Float64Array(ref.length + 1);
  for (let i = 0; i < ref.length; i += 1) {
    sums[i + 1] = sums[i] + ref[i];
    squares[i + 1] = squares[i] + ref[i] * ref[i];
  }
  const segRe = new Float64Array(size);
  const segIm = new Float64Array(size);
  const out = [];
  for (let t = 0; t + WINDOW_SECONDS <= takeSeconds + 1e-9; t += HOP_SECONDS) {
    const start = Math.round(t * rate);
    let mean = 0;
    for (let j = 0; j < window; j += 1) mean += take[start + j] ?? 0;
    mean /= window;
    let energy = 0;
    segRe.fill(0); segIm.fill(0);
    for (let j = 0; j < window; j += 1) {
      const value = (take[start + j] ?? 0) - mean;
      segRe[j] = value;
      energy += value * value;
    }
    if (energy < 1e-6) continue;
    fft(segRe, segIm, false);
    // Cross-correlation: REF * conj(SEG).
    for (let k = 0; k < size; k += 1) {
      const ar = refRe[k]; const ai = refIm[k]; const br = segRe[k]; const bi = -segIm[k];
      segRe[k] = ar * br - ai * bi;
      segIm[k] = ar * bi + ai * br;
    }
    fft(segRe, segIm, true);
    const expected = (sceneStartSeconds + t) * rate - lo;
    const from = Math.max(0, Math.floor(expected - SEARCH_SECONDS * rate));
    const to = Math.min(ref.length - window, Math.ceil(expected + SEARCH_SECONDS * rate));
    const norm = Math.sqrt(energy);
    let best = -2; let bestK = -1;
    const scores = new Float64Array(Math.max(0, to - from + 1));
    for (let k = from; k <= to; k += 1) {
      const s = sums[k + window] - sums[k];
      const s2 = squares[k + window] - squares[k];
      const denominator = Math.sqrt(Math.max(s2 - s * s / window, 1e-12)) * norm;
      const r = segRe[k] / denominator;
      scores[k - from] = r;
      if (r > best) { best = r; bestK = k; }
    }
    if (bestK < 0) continue;
    const exclusion = Math.round(PEAK_EXCLUSION_MS / 1000 * rate);
    let runnerUp = -2;
    for (let k = from; k <= to; k += 1) if (Math.abs(k - bestK) > exclusion && scores[k - from] > runnerUp) runnerUp = scores[k - from];
    let offset = 0;
    const i = bestK - from;
    if (i > 0 && i < scores.length - 1) {
      const a = scores[i - 1]; const b = scores[i]; const c = scores[i + 1];
      const d = a - 2 * b + c;
      if (d !== 0) offset = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d));
    }
    const lagMs = ((lo + bestK + offset) / rate - (sceneStartSeconds + t)) * 1000;
    out.push({ t: Math.round(t * 1000) / 1000, lagMs: Math.round(lagMs * 10) / 10, r: Math.round(best * 1000) / 1000, margin: Math.round((best - runnerUp) * 1000) / 1000 });
  }
  return out;
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Runs of near-constant lag among trusted windows.
 * @param {{ t: number, lagMs: number, r: number, margin: number }[]} track
 */
function lagRuns(track) {
  /** @type {{ t0: number, t1: number, lags: number[], lagMs: number }[]} */
  const runs = [];
  for (const point of track) {
    if (point.r < MIN_CORRELATION || point.margin < MIN_PEAK_MARGIN) continue;
    const last = runs[runs.length - 1];
    if (last && Math.abs(point.lagMs - last.lagMs) <= RUN_TOLERANCE_MS && point.t - last.t1 <= WINDOW_SECONDS + 0.01) {
      last.t1 = point.t;
      last.lags.push(point.lagMs);
      last.lagMs = median(last.lags);
    } else {
      runs.push({ t0: point.t, t1: point.t, lags: [point.lagMs], lagMs: point.lagMs });
    }
  }
  return runs.filter((run) => run.lags.length >= MIN_RUN_WINDOWS);
}

/**
 * Score of the take's short window at time t against the song at a fixed lag.
 * @param {Float32Array} take @param {Float32Array} song @param {number} sceneStartSeconds
 * @param {number} t @param {number} lagMs @param {number} length samples
 */
function fixedLagScore(take, song, sceneStartSeconds, t, lagMs, length) {
  const rate = TAKE_SOUND_SAMPLE_RATE;
  const a = Math.round(t * rate);
  const b = Math.round((sceneStartSeconds + t + lagMs / 1000) * rate);
  if (a < 0 || b < 0 || a + length > take.length || b + length > song.length) return 0;
  let ma = 0; let mb = 0;
  for (let j = 0; j < length; j += 1) { ma += take[a + j]; mb += song[b + j]; }
  ma /= length; mb /= length;
  let num = 0; let ea = 0; let eb = 0;
  for (let j = 0; j < length; j += 1) {
    const x = take[a + j] - ma; const y = song[b + j] - mb;
    num += x * y; ea += x * x; eb += y * y;
  }
  return ea > 0 && eb > 0 ? num / Math.sqrt(ea * eb) : 0;
}

/**
 * Where, between two runs, the sound switches from one lag to the other: the change point that
 * best separates short windows preferring each lag.
 */
function refineBoundary(take, song, sceneStartSeconds, from, to, lagA, lagB) {
  // 20 ms blocks: how well the take matches the song at each lag, block by block. The switch is
  // the split that best separates blocks agreeing with A (before) from blocks agreeing with B.
  const block = Math.round(0.02 * TAKE_SOUND_SAMPLE_RATE);
  const points = [];
  for (let t = from; t + 0.02 <= to; t += 0.02) {
    points.push({ t, d: fixedLagScore(take, song, sceneStartSeconds, t, lagA, block) - fixedLagScore(take, song, sceneStartSeconds, t, lagB, block) });
  }
  if (!points.length) return (from + to) / 2;
  const total = points.reduce((sum, point) => sum + point.d, 0);
  let before = 0; let best = -Infinity; let split = 0;
  for (let i = 0; i <= points.length; i += 1) {
    const score = before - (total - before);
    if (score > best) { best = score; split = i; }
    if (i < points.length) before += points[i].d;
  }
  return split >= points.length ? points[points.length - 1].t + 0.02 : points[split].t;
}

/**
 * @typedef {{ takeStart: number, takeEnd: number, lagMs: number }} TakeSoundSegment
 * @typedef {{
 *   version: string,
 *   verdict: "in-sync" | "retimed" | "unverified",
 *   reason?: string,
 *   segments: TakeSoundSegment[],
 *   maxAbsLagMs: number,
 *   coverage: number,
 *   visualDiscontinuity?: { maxHoldMs: number, maxSkipMs: number },
 * }} TakeSoundPlan
 */

/**
 * Measure the visible temporal discontinuities introduced by the hard v1 frame map. A gap in
 * film coverage clones one take frame; an overlap skips a run of take frames. A positive first
 * start or an early final end similarly freezes the first or last frame. Negative first starts
 * only choose a later source frame at the scene cut and do not interrupt motion inside the scene.
 * @param {TakeSoundSegment[]} segments
 * @param {number} sceneSeconds
 */
export function takeSoundVisualDiscontinuity(segments, sceneSeconds) {
  if (!segments.length || !(sceneSeconds > 0)) return { maxHoldMs: 0, maxSkipMs: 0 };
  const spans = segments.map((segment) => ({
    start: segment.takeStart + segment.lagMs / 1000,
    end: segment.takeEnd + segment.lagMs / 1000,
  }));
  let maxHoldSeconds = Math.max(0, spans[0].start);
  let maxSkipSeconds = 0;
  for (let index = 1; index < spans.length; index += 1) {
    const discontinuity = spans[index].start - spans[index - 1].end;
    if (discontinuity > 0) maxHoldSeconds = Math.max(maxHoldSeconds, discontinuity);
    else maxSkipSeconds = Math.max(maxSkipSeconds, -discontinuity);
  }
  maxHoldSeconds = Math.max(maxHoldSeconds, sceneSeconds - spans.at(-1).end);
  return {
    maxHoldMs: Math.max(0, Math.round(maxHoldSeconds * 1000)),
    maxSkipMs: Math.max(0, Math.round(maxSkipSeconds * 1000)),
  };
}

/**
 * Preserve the delivered moving picture when v1's sync repair would manufacture a visible
 * freeze or jump. The caller can fail closed with the scene id; already-accepted v2 jobs do not
 * call this guard and therefore retain their immutable rendering semantics.
 * @param {TakeSoundPlan} plan
 * @param {number} sceneSeconds
 * @returns {TakeSoundPlan}
 */
export function guardVisibleTakeSoundDiscontinuity(plan, sceneSeconds) {
  if (plan.verdict !== "retimed") return plan;
  const visualDiscontinuity = takeSoundVisualDiscontinuity(plan.segments, sceneSeconds);
  if (Math.max(visualDiscontinuity.maxHoldMs, visualDiscontinuity.maxSkipMs) <= TAKE_SOUND_MAX_VISUAL_DISCONTINUITY_MS) return plan;
  return { ...plan, verdict: "unverified", reason: "visible-discontinuity", visualDiscontinuity };
}

/**
 * Whether a scene's measured plan is one no repair can hide: the retiming would hold or skip the picture past 80 ms
 * (`visible-discontinuity`), or the take sits more than 1.5 s off the song over most of the scene (`offset-too-large`, at least
 * `TAKE_SOUND_UNSUPPORTED_COVERAGE` covered). Native policies v3 and v4 refuse the whole film for such a scene; v5 and v6 render
 * the take exactly as delivered, as the browser does, and the film's public view names the scene.
 * @param {{ verdict?: unknown, reason?: unknown, coverage?: unknown } | null | undefined} plan
 */
export function takeSoundDeliveredAsIs(plan) {
  return plan?.verdict === "unverified" && (plan.reason === "visible-discontinuity" ||
    (plan.reason === "offset-too-large" && typeof plan.coverage === "number" && plan.coverage >= TAKE_SOUND_UNSUPPORTED_COVERAGE));
}

/**
 * Measure a take against its song window and plan the retiming.
 * "retimed" carries the segments to apply; "in-sync" and "unverified" change nothing.
 * @param {{ take: Float32Array, song: Float32Array, sceneStartSeconds: number, sceneSeconds: number }} input
 * @returns {TakeSoundPlan}
 */
export function planTakeSoundRetime({ take, song, sceneStartSeconds, sceneSeconds, version = TAKE_SOUND_SYNC_VERSION }) {
  const base = { version, segments: [], maxAbsLagMs: 0, coverage: 0 };
  const rate = TAKE_SOUND_SAMPLE_RATE;
  const takeSeconds = take.length / rate;
  if (!(takeSeconds >= WINDOW_SECONDS) || !(sceneSeconds > 0)) return { ...base, verdict: "unverified", reason: "no-sound" };
  const track = takeSoundLagTrack(take, song, sceneStartSeconds);
  const runs = lagRuns(track).filter((run) => run.t0 < sceneSeconds);
  if (!runs.length) return { ...base, verdict: "unverified", reason: "not-the-song" };
  const covered = runs.reduce((sum, run) => sum + Math.min(sceneSeconds, run.t1 + WINDOW_SECONDS) - run.t0, 0);
  const coverage = Math.min(1, covered / sceneSeconds);
  const maxAbsLagMs = Math.max(...runs.map((run) => Math.abs(run.lagMs)));
  const measured = { ...base, coverage: Math.round(coverage * 100) / 100, maxAbsLagMs: Math.round(maxAbsLagMs) };
  if (maxAbsLagMs <= IN_SYNC_MS) return { ...measured, verdict: "in-sync" };
  if (coverage < MIN_COVERAGE) return { ...measured, verdict: "unverified", reason: "too-little-matched" };
  if (maxAbsLagMs > MAX_LAG_MS) return { ...measured, verdict: "unverified", reason: "offset-too-large" };
  // Merge neighbouring runs that agree; keep a list of distinct lags in take order.
  /** @type {{ t0: number, t1: number, lagMs: number }[]} */
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.lagMs - run.lagMs) <= IN_SYNC_MS) last.t1 = run.t1;
    else merged.push({ t0: run.t0, t1: run.t1, lagMs: run.lagMs });
  }
  /** @type {TakeSoundSegment[]} */
  const segments = merged.map((run) => ({ takeStart: run.t0, takeEnd: run.t1 + WINDOW_SECONDS, lagMs: Math.round(run.lagMs * 10) / 10 }));
  for (let i = 0; i < segments.length - 1; i += 1) {
    const a = segments[i]; const b = segments[i + 1];
    // The switch lies after a's last fully agreeing window began and before b's first ended.
    const from = Math.max(0, merged[i].t1);
    const to = Math.max(from, merged[i + 1].t0 + WINDOW_SECONDS);
    const boundary = refineBoundary(take, song, sceneStartSeconds, from, to, a.lagMs, b.lagMs);
    a.takeEnd = boundary;
    b.takeStart = boundary;
  }
  segments[0].takeStart = 0;
  segments[segments.length - 1].takeEnd = takeSeconds;
  for (const segment of segments) {
    segment.takeStart = Math.round(segment.takeStart * 1000) / 1000;
    segment.takeEnd = Math.round(segment.takeEnd * 1000) / 1000;
  }
  // A single constant segment within tolerance is in sync; anything else is a retiming.
  if (segments.length === 1 && Math.abs(segments[0].lagMs) <= IN_SYNC_MS) return { ...measured, verdict: "in-sync" };
  return { ...measured, verdict: "retimed", segments };
}

/**
 * The take time to show at scene-local film time T. The latest segment whose film span covers T
 * wins (drops a repeat); a gap holds the last time shown (covers a skip).
 * @param {TakeSoundSegment[]} segments
 * @param {number} local seconds into the scene
 * @param {number} takeSeconds
 */
export function retimedTakeTime(segments, local, takeSeconds) {
  if (!segments.length) return local;
  let pick = null;
  let held = segments[0].takeStart;
  for (const segment of segments) {
    const lag = segment.lagMs / 1000;
    const filmStart = segment.takeStart + lag;
    const filmEnd = segment.takeEnd + lag;
    if (filmStart <= local && local < filmEnd) pick = local - lag;
    else if (filmEnd <= local) held = Math.max(held, segment.takeEnd - 0.001);
  }
  const time = pick ?? held;
  return Math.max(0, Math.min(Math.max(0, takeSeconds - 0.001), time));
}

/**
 * Take frame index for every output frame of a scene's visible part.
 * @param {TakeSoundSegment[]} segments
 * @param {{ frames: number, frameRate: number, takeFrames: number }} grid
 * @returns {number[]}
 */
export function retimedFrameIndexes(segments, { frames, frameRate, takeFrames }) {
  const takeSeconds = takeFrames / frameRate;
  return Array.from({ length: frames }, (_, n) =>
    Math.max(0, Math.min(takeFrames - 1, Math.round(retimedTakeTime(segments, n / frameRate, takeSeconds) * frameRate))));
}

/**
 * Collapse a per-frame index list into runs: consecutive frames (`count` frames from `from`)
 * or a held frame (`hold`).
 * @param {number[]} indexes
 * @returns {{ from: number, count: number, hold: boolean }[]}
 */
export function frameRuns(indexes) {
  /** @type {{ from: number, count: number, hold: boolean }[]} */
  const runs = [];
  for (const index of indexes) {
    const last = runs[runs.length - 1];
    if (last && !last.hold && index === last.from + last.count) last.count += 1;
    else if (last && last.count === 1 && !last.hold && index === last.from) { last.hold = true; last.count += 1; }
    else if (last && last.hold && index === last.from) last.count += 1;
    else runs.push({ from: index, count: 1, hold: false });
  }
  return runs;
}

/**
 * The take frame a scene starts on when its take starts `inPointMs` in: the nearest frame, the rule the film's own frame
 * grid uses. Native assembly (the output frame rate) and browser assembly (the take's own frame rate) both call this, so
 * both lanes show the same first frame of a take that starts partway in.
 * @param {number} inPointMs
 * @param {number} framesPerSecond
 */
export function takeInPointFrameIndex(inPointMs, framesPerSecond) {
  return Math.round(inPointMs * framesPerSecond / 1000);
}

/**
 * Why a take measured at an in-point is refused: the sound measured there says it is NOT the song where the scene starts (or
 * its picture would jump). A take with nothing to measure (silent, periodic, too quiet, or no window reaching the correlation
 * bar: planner reason not-the-song) is not contradicted by that: the recorded window that made the in-point is the evidence,
 * and the same take renders as delivered without one. One table for both lanes: the renderer refuses on it and the browser
 * falls back to the whole take on it, so neither can accept what the other refuses.
 */
const IN_POINT_SOUND_CONTRADICTIONS = Object.freeze({ "too-little-matched": true, "offset-too-large": true, "visible-discontinuity": true });

/**
 * Whether a take plan measured at a scene's in-point contradicts that in-point.
 * @param {{ verdict?: string, reason?: string } | null | undefined} plan
 */
export function takeSoundContradictsInPoint(plan) {
  return plan?.verdict === "unverified" && typeof plan.reason === "string" && Object.hasOwn(IN_POINT_SOUND_CONTRADICTIONS, plan.reason);
}
