"""Poster frames, filmstrips and a song envelope for the desktop studio.

The studio shows each production with its own frames: a poster for the finished film, a mid-clip
poster and a six-frame strip for every scene's current take, and the song's loudness envelope (numbers,
so the UI draws it in the theme's own colour). Everything is made lazily with ffmpeg/ffprobe and cached
under the plugin's data folder, keyed by the source file's path, size and mtime: a new take or a
re-assembled film gets new frames, an unchanged file is never decoded twice.

Nothing here blocks a request. A missing artefact is scheduled on a small worker pool and reported as
``pending``; the UI polls. Without ffmpeg every artefact reads ``unavailable`` and the UI shows neutral
slots.

Safety: a request never names a file. Sources are only the paths a production's own records hold
(``state.json`` master, ``ledger.json`` downloads, ``production.json`` song), checked to be existing
media files; the UI then reads finished images by an opaque cache name that must match ``_NAME`` and
is resolved inside the cache folder only.

The film's poster is the best of FILM_CANDIDATES frames (``frame_score``: a picture with colour and tonal
range, not a dark fade, a white card or a frame of an interface), unless the person chose one in the
studio; that choice is the plugin's own record (``posters.json`` beside the cache), never the production's.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from array import array
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Optional

from . import production

VERSION = 1
POSTER_VERSION = 2  # the automatic poster's heuristic: a new one re-picks every film's poster
STRIP_FRAMES = 6
POSTER_W = 640
FILM_W = 1280
THUMB_W = 192
STRIP_H = 135
WAVE_BUCKETS = 480
FILM_CANDIDATES = 15
EDGE_MARGIN = 0.05
SCORE_W, SCORE_H = 160, 90
WORKERS = 2
RETRY_S = 600
_TIMEOUT_S = 90
_VIDEO = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
_NAME = re.compile(r"^[a-f0-9]{24}-(poster|strip|thumb)\.jpg$")
_SCENE = re.compile(r"^sc\d{1,3}$")
_KINDS = {"clip": ("poster", "strip", "thumb"), "film": ("poster", "thumb"), "wave": ()}

POSTERS_FILE = "posters.json"
MAX_POSTER_MS = 6 * 3600 * 1000

_lock = threading.Lock()
_posters_lock = threading.Lock()
_inflight: set[str] = set()
_pool: Optional[ThreadPoolExecutor] = None


class MediaError(RuntimeError):
    pass


# --------------------------------------------------------------------------- environment


def tools() -> tuple[Optional[str], Optional[str]]:
    """ffmpeg and ffprobe, from SLOPCANNON_FFMPEG's folder when set, else PATH."""
    folder = os.environ.get("SLOPCANNON_FFMPEG_DIR")
    if folder:
        found = [shutil.which(name, path=folder) for name in ("ffmpeg", "ffprobe")]
        if all(found):
            return found[0], found[1]
    return shutil.which("ffmpeg"), shutil.which("ffprobe")


def available() -> bool:
    ffmpeg, ffprobe = tools()
    return bool(ffmpeg and ffprobe)


def cache_dir() -> Path:
    path = production.root().parent / "media-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def source_key(path: Path, kind: str) -> str:
    """Stable for an unchanged file; a new size or mtime (a new take, a re-assembled film) is a new key."""
    st = path.stat()
    ident = f"{VERSION}|{kind}|{os.path.normcase(str(path.resolve()))}|{st.st_size}|{st.st_mtime_ns}"
    return hashlib.sha1(ident.encode("utf-8")).hexdigest()[:24]


def _media_file(value: Any, exts: set[str]) -> Optional[Path]:
    if not isinstance(value, str) or not value.strip():
        return None
    path = Path(value).expanduser()
    if not path.is_absolute() or path.suffix.lower() not in exts:
        return None
    try:
        return path.resolve(strict=True) if path.is_file() else None
    except (OSError, RuntimeError):
        return None


# --------------------------------------------------------------------------- ffmpeg work


def _run(args: list[str], *, binary: bool = False) -> subprocess.CompletedProcess:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    return subprocess.run(args, capture_output=True, timeout=_TIMEOUT_S, check=True, creationflags=flags,
                          stdin=subprocess.DEVNULL, **({} if binary else {"text": True, "errors": "replace"}))


def _ffmpeg() -> str:
    ffmpeg = tools()[0]
    if not ffmpeg:
        raise MediaError("ffmpeg is not installed")
    return ffmpeg


def duration_s(path: Path) -> float:
    _, ffprobe = tools()
    if not ffprobe:
        raise MediaError("ffprobe is not installed")
    out = _run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)]).stdout
    value = float((json.loads(out).get("format") or {}).get("duration") or 0)
    if value <= 0:
        raise MediaError("no duration")
    return value


def _frame(path: Path, at: float, out: Path, width: int, quality: int = 4) -> None:
    ffmpeg = _ffmpeg()
    _run([ffmpeg, "-v", "error", "-nostdin", "-y", "-ss", f"{at:.3f}", "-i", str(path), "-frames:v", "1",
          "-vf", f"scale={width}:-2:flags=bicubic", "-q:v", str(quality), str(out)])


def _strip(path: Path, dur: float, out: Path) -> None:
    """Six frames, evenly through the take, side by side in one image (one request instead of six)."""
    ffmpeg = _ffmpeg()
    args = [ffmpeg, "-v", "error", "-nostdin", "-y"]
    for i in range(STRIP_FRAMES):
        args += ["-ss", f"{dur * (i + 0.5) / STRIP_FRAMES:.3f}", "-i", str(path)]
    chains = [f"[{i}:v]scale=-2:{STRIP_H}:flags=bicubic,setsar=1,trim=end_frame=1[f{i}]" for i in range(STRIP_FRAMES)]
    graph = ";".join(chains) + ";" + "".join(f"[f{i}]" for i in range(STRIP_FRAMES)) + \
        f"hstack=inputs={STRIP_FRAMES}[out]"
    _run(args + ["-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "5", str(out)])


def frame_features(rgb: bytes, w: int = SCORE_W) -> dict[str, float]:
    """What a small RGB frame (``w`` wide, rows inferred) shows, as numbers in roughly 0..2.

    ``appeal``: contrast and colour, best at mid exposure (a black fade or a white card loses).
    ``tonal``: the 2nd..98th percentile luma range. Then three marks of a screen recording or a title card
    rather than a picture: ``straight`` (share of edges that lie on long horizontal or vertical lines: card
    borders, panels, rules), ``thin`` (one-pixel strokes: small text) and ``flat`` (large flat saturated
    areas: filled UI cards and buttons).
    """
    n = len(rgb) // 3
    h = n // w if w else 0
    n = w * h
    zero = {"mean": 0.0, "appeal": 0.0, "tonal": 0.0, "straight": 0.0, "thin": 0.0, "flat": 0.0, "ui": 0.0}
    if n == 0 or h < 3 or w < 3:
        return zero
    L = [0.0] * n
    sat = [0.0] * n
    s_l = s_rg = s_yb = 0.0
    for i in range(n):
        r, g, b = rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]
        y = 0.299 * r + 0.587 * g + 0.114 * b
        L[i] = y
        hi, lo = max(r, g, b), min(r, g, b)
        sat[i] = (hi - lo) / hi if hi else 0.0
        s_l += y
        s_rg += r - g
        s_yb += (r + g) / 2 - b
    mean, m_rg, m_yb = s_l / n, s_rg / n, s_yb / n
    v_l = v_rg = v_yb = 0.0
    for i in range(n):
        r, g, b = rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]
        v_l += (L[i] - mean) ** 2
        v_rg += (r - g - m_rg) ** 2
        v_yb += ((r + g) / 2 - b - m_yb) ** 2
    std = (v_l / n) ** 0.5
    colour = ((v_rg + v_yb) / n) ** 0.5 + 0.3 * (m_rg ** 2 + m_yb ** 2) ** 0.5
    exposure = max(0.0, 1.0 - abs(mean - 120) / 160)
    appeal = exposure * (std / 64.0 + colour / 48.0) if mean >= 18 else 0.0
    ranked = sorted(L)
    tonal = (ranked[int(n * 0.98)] - ranked[int(n * 0.02)]) / 255.0

    edge_t, stroke_t, flat_t = 36.0, 30.0, 6.0
    edges = 0
    for y in range(h - 1):
        row = y * w
        for x in range(w - 1):
            i = row + x
            if abs(L[i + 1] - L[i]) > edge_t or abs(L[i + w] - L[i]) > edge_t:
                edges += 1

    def lines(count: int, length: int, step: int, across: int, min_run: int) -> int:
        """Pixels on runs of at least ``min_run`` same-signed edges along ``step`` (a straight line)."""
        on = 0
        for k in range(count):
            run = sign = 0
            for j in range(length):
                i = k * across + j * step
                d = L[i + across] - L[i]
                s = 1 if d > edge_t else (-1 if d < -edge_t else 0)
                if s and s == sign:
                    run += 1
                else:
                    if run >= min_run:
                        on += run
                    run, sign = (1 if s else 0), s
            if run >= min_run:
                on += run
        return on

    horizontal = lines(h - 1, w, 1, w, max(8, int(w * 0.09)))   # along a row, edge across it
    vertical = lines(w - 1, h, w, 1, max(6, int(h * 0.11)))     # down a column, edge across it
    straight = (horizontal + vertical) / max(1, edges)
    thin = flat = 0
    for y in range(1, h - 1):
        row = y * w
        for x in range(1, w - 1):
            i = row + x
            c = L[i]
            a, b, u, d = L[i - 1] - c, L[i + 1] - c, L[i - w] - c, L[i + w] - c
            if (a > stroke_t and b > stroke_t) or (a < -stroke_t and b < -stroke_t) or \
                    (u > stroke_t and d > stroke_t) or (u < -stroke_t and d < -stroke_t):
                thin += 1
            if sat[i] > 0.5 and c > 70 and abs(a) < flat_t and abs(b) < flat_t and abs(u) < flat_t and \
                    abs(d) < flat_t and abs(L[i - w - 1] - c) < flat_t and abs(L[i + w + 1] - c) < flat_t:
                flat += 1
    thin_f, flat_f = thin / n, flat / n
    ui = 1.8 * straight + 5.0 * flat_f + 8.0 * max(0.0, thin_f - 0.015)
    return {"mean": mean, "appeal": appeal, "tonal": tonal, "straight": straight, "thin": thin_f, "flat": flat_f,
            "ui": ui}


def frame_score(rgb: bytes, w: int = SCORE_W) -> float:
    """How good a poster a small RGB frame makes: a picture with colour and tonal range wins; a dark fade,
    a white card and a frame that reads as an interface (panels, small text, flat filled cards) lose."""
    f = frame_features(rgb, w)
    return f["appeal"] * max(0.05, 1.0 - f["ui"]) * (0.5 + 0.5 * f["tonal"])


def candidate_times(dur: float) -> list[float]:
    """FILM_CANDIDATES evenly spaced timestamps, leaving out the first and last EDGE_MARGIN of the film
    (title cards and end slates live there)."""
    lo, span = dur * EDGE_MARGIN, dur * (1 - 2 * EDGE_MARGIN)
    return [lo + span * (i + 0.5) / FILM_CANDIDATES for i in range(FILM_CANDIDATES)]


def best_frame_time(path: Path, dur: float) -> float:
    """The candidate timestamp whose frame scores highest; the middle of the film if none decodes."""
    ffmpeg = _ffmpeg()
    best_t, best = dur / 2, -1.0
    for t in candidate_times(dur):
        try:
            raw = _run([ffmpeg, "-v", "error", "-nostdin", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
                        "-vf", f"scale={SCORE_W}:{SCORE_H}:flags=area,format=rgb24", "-f", "rawvideo", "-"],
                       binary=True).stdout
        except (subprocess.SubprocessError, OSError):
            continue
        score = frame_score(raw, SCORE_W)
        if score > best:
            best_t, best = t, score
    return best_t


def envelope(path: Path) -> dict[str, Any]:
    """RMS loudness in WAVE_BUCKETS buckets, normalised to 0..1 (numbers: the UI draws them in theme colour)."""
    ffmpeg = _ffmpeg()
    raw = _run([ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000",
                "-f", "s16le", "-"], binary=True).stdout
    samples = array("h")
    samples.frombytes(raw[: len(raw) - len(raw) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    n = len(samples)
    if n < WAVE_BUCKETS:
        raise MediaError("no audio")
    step = n / WAVE_BUCKETS
    peaks = []
    for b in range(WAVE_BUCKETS):
        chunk = samples[int(b * step): int((b + 1) * step)] or array("h", [0])
        peaks.append((sum(v * v for v in chunk) / len(chunk)) ** 0.5)
    top = sorted(peaks)[int(len(peaks) * 0.98)] or max(peaks) or 1.0
    return {"peaks": [round(min(1.0, p / top), 3) for p in peaks], "durationMs": int(n / 8000 * 1000)}


def _atomic(out: Path, make: Callable[[Path], None]) -> None:
    tmp = out.with_name(f"tmp-{os.getpid()}-{threading.get_ident()}-{out.name}")
    try:
        make(tmp)
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)


def _write_json(out: Path, value: Any) -> None:
    def make(tmp: Path) -> None:
        tmp.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    _atomic(out, make)


def _make(kind: str, src: Path, key: str, at_ms: Optional[int] = None) -> None:
    root = cache_dir()
    dur = duration_s(src)
    if kind == "clip":
        _atomic(root / f"{key}-poster.jpg", lambda t: _frame(src, dur / 2, t, POSTER_W))
        _atomic(root / f"{key}-thumb.jpg", lambda t: _frame(src, dur / 2, t, THUMB_W, 5))
        _atomic(root / f"{key}-strip.jpg", lambda t: _strip(src, dur, t))
        _write_json(root / f"{key}.json", {"durationMs": int(dur * 1000), "frames": STRIP_FRAMES})
    elif kind == "film":
        chosen = at_ms is not None
        at = min(max(0.0, at_ms / 1000), max(0.0, dur - 0.05)) if chosen else best_frame_time(src, dur)
        _atomic(root / f"{key}-poster.jpg", lambda t: _frame(src, at, t, FILM_W, 5))
        _atomic(root / f"{key}-thumb.jpg", lambda t: _frame(src, at, t, THUMB_W, 5))
        _write_json(root / f"{key}.json", {"durationMs": int(dur * 1000), "posterAtMs": int(at * 1000),
                                           "posterChosen": chosen})
    elif kind == "wave":
        _write_json(root / f"{key}.json", envelope(src))


def _job(kind: str, src: Path, key: str, at_ms: Optional[int] = None) -> None:
    err = cache_dir() / f"{key}.err"
    try:
        _make(kind, src, key, at_ms)
        err.unlink(missing_ok=True)
    except Exception as exc:  # recorded, retried after RETRY_S; the UI shows a neutral slot meanwhile
        try:
            err.write_text(f"{type(exc).__name__}: {str(exc)[:300]}", encoding="utf-8")
        except OSError:
            pass
    finally:
        with _lock:
            _inflight.discard(key)


def _schedule(kind: str, src: Path, key: str, at_ms: Optional[int] = None) -> None:
    global _pool
    with _lock:
        if key in _inflight:
            return
        _inflight.add(key)
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="slopcannon-media")
        pool = _pool
    pool.submit(_job, kind, src, key, at_ms)


def artefact(src: Optional[Path], kind: str, *, schedule: bool = True, at_ms: Optional[int] = None) -> dict[str, Any]:
    """One source's artefacts: ``ready`` with cache names, ``pending``, ``unavailable`` (no ffmpeg),
    ``missing`` (no file) or ``error`` (ffmpeg failed; retried later). ``at_ms`` (films only) is a poster
    time the person chose; it is part of the cache key, so choosing again, or going back to the automatic
    poster, never overwrites another choice's frames."""
    if src is None:
        return {"state": "missing"}
    if not available():
        return {"state": "unavailable"}
    if kind != "film":
        at_ms = None
    try:
        key = source_key(src, kind if kind != "film" else f"film@{at_ms}" if at_ms is not None else f"film.v{POSTER_VERSION}")
    except OSError:
        return {"state": "missing"}
    root = cache_dir()
    meta = root / f"{key}.json"
    names = {part: f"{key}-{part}.jpg" for part in _KINDS[kind]}
    if meta.is_file() and all((root / n).is_file() for n in names.values()):
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            info = {}
        return {"state": "ready", **names, **info}
    err = root / f"{key}.err"
    try:
        if time.time() - err.stat().st_mtime < RETRY_S:
            return {"state": "error"}
    except OSError:
        pass
    if schedule:
        _schedule(kind, src, key, at_ms)
    return {"state": "pending"}


# --------------------------------------------------------------------------- chosen posters
#
# A poster the person picks in the studio ("Use this frame as poster") is the plugin's own record, kept
# beside the media cache in the plugin's data folder: a production's own files are never written for it.


def _posters_file() -> Path:
    return production.root().parent / POSTERS_FILE


def poster_choices() -> dict[str, int]:
    try:
        raw = json.loads(_posters_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {pid: int(v) for pid, v in raw.items()
            if isinstance(pid, str) and isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= MAX_POSTER_MS}


def poster_choice(production_id: str) -> Optional[int]:
    return poster_choices().get(production_id)


def set_poster(production_id: str, at_ms: Any) -> dict[str, Any]:
    """Use the film's frame at ``at_ms`` as its poster, or (``None``) go back to the automatic choice.
    Returns the production's media, with the new poster ``pending`` until it is made."""
    state, _, _ = _records(production_id)  # validates the id and that the production exists
    master = _media_file((state.get("master") or {}).get("path"), _VIDEO)
    if master is None:
        raise MediaError("this production has no finished film")
    if at_ms is not None:
        if isinstance(at_ms, bool) or not isinstance(at_ms, (int, float)) or not math.isfinite(at_ms):
            raise MediaError("the poster time must be a number of milliseconds")
        at_ms = int(at_ms)
        if not 0 <= at_ms <= MAX_POSTER_MS:
            raise MediaError("the poster time is outside the film")
        try:
            at_ms = min(at_ms, max(0, int(duration_s(master) * 1000) - 50))
        except (MediaError, subprocess.SubprocessError, OSError, ValueError):
            pass  # no ffprobe: the frame is clamped when it is made
    with _posters_lock:
        choices = poster_choices()
        if at_ms is None:
            choices.pop(production_id, None)
        else:
            choices[production_id] = at_ms
        _posters_file().parent.mkdir(parents=True, exist_ok=True)
        _write_json(_posters_file(), choices)
    return production_media(production_id)


# --------------------------------------------------------------------------- per production


def _records(production_id: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    folder = production._dir(production_id)  # validates the id
    state = production.load_state(production_id)
    if state is None:
        raise production.ProductionError(f"no production {production_id}", "unknown_production")
    ledger = production._read_json(folder / "ledger.json") or {}
    spec = production._read_json(folder / "production.json") or {}
    return state, ledger, spec


def _clips(ledger: dict[str, Any]) -> dict[str, Path]:
    out = {}
    for sid, entry in sorted((ledger.get("scenes") or {}).items()):
        if _SCENE.match(sid) and isinstance(entry, dict):
            clip = _media_file((entry.get("downloaded") or {}).get("path"), _VIDEO)
            if clip:
                out[sid] = clip
    return out


def production_media(production_id: str) -> dict[str, Any]:
    state, ledger, spec = _records(production_id)
    master = _media_file((state.get("master") or {}).get("path"), _VIDEO)
    scenes = {sid: artefact(path, "clip") for sid, path in _clips(ledger).items()}
    chosen = poster_choice(production_id)
    film = artefact(master, "film", at_ms=chosen) if master else {"state": "missing"}
    film["posterChosen"] = chosen is not None
    if chosen is not None:
        film.setdefault("posterAtMs", chosen)
    song = _media_file(spec.get("song"), _AUDIO | _VIDEO)
    wave_src, wave_from = (song, "song") if song else (master, "film")
    wave = artefact(wave_src, "wave")
    if wave.get("state") == "ready":
        wave["source"] = wave_from
    states = [film["state"], wave["state"], *(s["state"] for s in scenes.values())]
    return {"ffmpeg": available(), "pending": "pending" in states, "film": film, "wave": wave, "scenes": scenes}


def thumbs(production_ids: list[str]) -> dict[str, Any]:
    """A small picture per production for the studio list: the film's, else its latest rendered scene's."""
    out: dict[str, Optional[str]] = {}
    pending = False
    choices = poster_choices()
    for pid in production_ids:
        try:
            state, ledger, _ = _records(pid)
        except Exception:
            continue
        master = _media_file((state.get("master") or {}).get("path"), _VIDEO)
        clips = _clips(ledger)
        src, kind = (master, "film") if master else ((clips[max(clips)], "clip") if clips else (None, "clip"))
        art = artefact(src, kind, at_ms=choices.get(pid) if master else None)
        pending = pending or art["state"] == "pending"
        out[pid] = art.get("thumb") if art["state"] == "ready" else None
    return {"ffmpeg": available(), "pending": pending, "thumbs": out}


def frame_data_url(name: str) -> str:
    """A finished image by cache name. The name is opaque and checked; nothing outside the cache is read."""
    if not isinstance(name, str) or not _NAME.match(name):
        raise MediaError("bad name")
    root = cache_dir().resolve()
    path = (root / name).resolve()
    if path.parent != root or not path.is_file():
        raise MediaError("not found")
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def locate(*, path: Optional[str] = None, generation_id: Optional[str] = None) -> Optional[dict[str, str]]:
    """Which production and scene a clip belongs to, by comparing against recorded paths and generation ids
    (the given path is only compared as text, never opened)."""
    want = os.path.normcase(os.path.normpath(path)) if isinstance(path, str) and path else None
    for pid in production.list_ids()[:50]:
        try:
            _, ledger, _ = _records(pid)
        except Exception:
            continue
        for sid, entry in (ledger.get("scenes") or {}).items():
            if not (_SCENE.match(sid) and isinstance(entry, dict)):
                continue
            recorded = (entry.get("downloaded") or {}).get("path")
            gid = (entry.get("generation") or {}).get("id")
            if (want and isinstance(recorded, str) and os.path.normcase(os.path.normpath(recorded)) == want) or \
                    (generation_id and gid == generation_id):
                return {"productionId": pid, "sceneId": sid}
    return None
