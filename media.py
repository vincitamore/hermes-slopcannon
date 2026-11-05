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
"""
from __future__ import annotations

import base64
import hashlib
import json
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
STRIP_FRAMES = 6
POSTER_W = 640
FILM_W = 1280
THUMB_W = 192
STRIP_H = 135
WAVE_BUCKETS = 480
FILM_CANDIDATES = 9
WORKERS = 2
RETRY_S = 600
_TIMEOUT_S = 90
_VIDEO = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
_NAME = re.compile(r"^[a-f0-9]{24}-(poster|strip|thumb)\.jpg$")
_SCENE = re.compile(r"^sc\d{1,3}$")
_KINDS = {"clip": ("poster", "strip", "thumb"), "film": ("poster", "thumb"), "wave": ()}

_lock = threading.Lock()
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


def frame_score(rgb: bytes) -> float:
    """How much a small RGB frame shows: contrast and colour, with dark fades and blown-out cards losing."""
    n = len(rgb) // 3
    if n == 0:
        return 0.0
    luma, rg, yb = [], [], []
    for i in range(n):
        r, g, b = rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]
        luma.append(0.299 * r + 0.587 * g + 0.114 * b)
        rg.append(r - g)
        yb.append((r + g) / 2 - b)
    mean = sum(luma) / n
    if mean < 18:
        return 0.0
    std = (sum((v - mean) ** 2 for v in luma) / n) ** 0.5

    def spread(xs: list[float]) -> tuple[float, float]:
        m = sum(xs) / n
        return m, (sum((x - m) ** 2 for x in xs) / n) ** 0.5

    (m_rg, s_rg), (m_yb, s_yb) = spread(rg), spread(yb)
    colour = (s_rg ** 2 + s_yb ** 2) ** 0.5 + 0.3 * (m_rg ** 2 + m_yb ** 2) ** 0.5
    exposure = 1.0 - abs(mean - 120) / 160  # best mid-grey; a white card or a near-black frame loses
    return max(0.0, exposure) * (std / 64.0 + colour / 48.0)


def best_frame_time(path: Path, dur: float) -> float:
    """The candidate timestamp whose frame scores highest; the middle of the film if none decodes."""
    ffmpeg = _ffmpeg()
    best_t, best = dur / 2, -1.0
    for i in range(FILM_CANDIDATES):
        t = dur * (i + 0.5) / FILM_CANDIDATES
        try:
            raw = _run([ffmpeg, "-v", "error", "-nostdin", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
                        "-vf", "scale=64:36,format=rgb24", "-f", "rawvideo", "-"], binary=True).stdout
        except (subprocess.SubprocessError, OSError):
            continue
        score = frame_score(raw)
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


def _make(kind: str, src: Path, key: str) -> None:
    root = cache_dir()
    dur = duration_s(src)
    if kind == "clip":
        _atomic(root / f"{key}-poster.jpg", lambda t: _frame(src, dur / 2, t, POSTER_W))
        _atomic(root / f"{key}-thumb.jpg", lambda t: _frame(src, dur / 2, t, THUMB_W, 5))
        _atomic(root / f"{key}-strip.jpg", lambda t: _strip(src, dur, t))
        _write_json(root / f"{key}.json", {"durationMs": int(dur * 1000), "frames": STRIP_FRAMES})
    elif kind == "film":
        at = best_frame_time(src, dur)
        _atomic(root / f"{key}-poster.jpg", lambda t: _frame(src, at, t, FILM_W, 5))
        _atomic(root / f"{key}-thumb.jpg", lambda t: _frame(src, at, t, THUMB_W, 5))
        _write_json(root / f"{key}.json", {"durationMs": int(dur * 1000), "posterAtMs": int(at * 1000)})
    elif kind == "wave":
        _write_json(root / f"{key}.json", envelope(src))


def _job(kind: str, src: Path, key: str) -> None:
    err = cache_dir() / f"{key}.err"
    try:
        _make(kind, src, key)
        err.unlink(missing_ok=True)
    except Exception as exc:  # recorded, retried after RETRY_S; the UI shows a neutral slot meanwhile
        try:
            err.write_text(f"{type(exc).__name__}: {str(exc)[:300]}", encoding="utf-8")
        except OSError:
            pass
    finally:
        with _lock:
            _inflight.discard(key)


def _schedule(kind: str, src: Path, key: str) -> None:
    global _pool
    with _lock:
        if key in _inflight:
            return
        _inflight.add(key)
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="slopcannon-media")
        pool = _pool
    pool.submit(_job, kind, src, key)


def artefact(src: Optional[Path], kind: str, *, schedule: bool = True) -> dict[str, Any]:
    """One source's artefacts: ``ready`` with cache names, ``pending``, ``unavailable`` (no ffmpeg),
    ``missing`` (no file) or ``error`` (ffmpeg failed; retried later)."""
    if src is None:
        return {"state": "missing"}
    if not available():
        return {"state": "unavailable"}
    try:
        key = source_key(src, kind)
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
        _schedule(kind, src, key)
    return {"state": "pending"}


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
    film = artefact(master, "film") if master else {"state": "missing"}
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
    for pid in production_ids:
        try:
            state, ledger, _ = _records(pid)
        except Exception:
            continue
        master = _media_file((state.get("master") or {}).get("path"), _VIDEO)
        clips = _clips(ledger)
        src, kind = (master, "film") if master else ((clips[max(clips)], "clip") if clips else (None, "clip"))
        art = artefact(src, kind)
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
