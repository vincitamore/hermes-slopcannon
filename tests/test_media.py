"""Media module: cache keys, path confinement, the ffmpeg-missing fallback, the poster heuristic and the
chosen-poster record.

The ffmpeg cases build tiny fixtures with lavfi (testsrc / colour / sine) and skip when ffmpeg is absent.
Run with the other tests: python -m unittest discover -s tests
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import test_plugin as tp  # installs the Hermes stubs and loads the plugin package

from slopcannon_plugin import media, production  # noqa: E402

HAVE_FFMPEG = media.available()


def _lavfi(out: Path, graph: str, *extra: str) -> Path:
    ffmpeg = media.tools()[0]
    subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", graph, *extra, str(out)], check=True,
                   capture_output=True, timeout=60)
    return out


class MediaTestBase(unittest.TestCase):
    def setUp(self):
        tp.bind()
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.root = self.base / "productions"
        self.root.mkdir()
        self.patch = mock.patch.object(production, "root", lambda: self.root)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        deadline = time.time() + 20
        while media._inflight and time.time() < deadline:  # let background jobs release their files
            time.sleep(0.1)
        self.tmp.cleanup()

    def make_production(self, pid: str, *, master=None, clips=None, song=None) -> Path:
        folder = self.root / pid
        (folder / "work").mkdir(parents=True)
        state = {"id": pid, "title": pid, "state": "done" if master else "idle", "updatedAt": 1}
        if master:
            state["master"] = {"path": str(master), "name": Path(master).name}
        (folder / "state.json").write_text(json.dumps(state), encoding="utf-8")
        scenes = {sid: {"downloaded": {"path": str(p)}} for sid, p in (clips or {}).items()}
        (folder / "ledger.json").write_text(json.dumps({"scenes": scenes}), encoding="utf-8")
        (folder / "production.json").write_text(json.dumps({"title": pid, "song": str(song) if song else None}),
                                                encoding="utf-8")
        return folder

    def settle(self, pid: str, timeout: float = 60) -> dict:
        deadline = time.time() + timeout
        while True:
            out = media.production_media(pid)
            if not out["pending"] or time.time() > deadline:
                return out
            time.sleep(0.2)


class CacheKeyTest(MediaTestBase):
    def test_key_follows_size_and_mtime(self):
        clip = self.base / "a.mp4"
        clip.write_bytes(b"x" * 10)
        os.utime(clip, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        first = media.source_key(clip, "clip")
        self.assertRegex(first, r"^[a-f0-9]{24}$")
        clip.write_bytes(b"y" * 10)  # same size, same mtime: same key
        os.utime(clip, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        self.assertEqual(media.source_key(clip, "clip"), first)
        os.utime(clip, ns=(1_700_000_001_000_000_000, 1_700_000_001_000_000_000))
        self.assertNotEqual(media.source_key(clip, "clip"), first)
        clip.write_bytes(b"y" * 11)
        self.assertNotEqual(media.source_key(clip, "clip"), first)
        self.assertNotEqual(media.source_key(clip, "film"), media.source_key(clip, "clip"))

    def test_cache_lives_beside_the_productions(self):
        self.assertEqual(media.cache_dir(), self.root.parent / "media-cache")


class ConfinementTest(MediaTestBase):
    def test_frame_names_are_opaque_and_stay_in_the_cache(self):
        secret = self.base / "secret.jpg"
        secret.write_bytes(b"\xff\xd8not yours")
        for name in ("../secret.jpg", "..\\secret.jpg", str(secret), "secret.jpg", "a" * 24 + "-poster.png",
                     "A" * 24 + "-poster.jpg", "a" * 24 + "-poster.jpg/../../secret.jpg", ""):
            with self.assertRaises(media.MediaError, msg=name):
                media.frame_data_url(name)
        good = "a" * 24 + "-poster.jpg"
        with self.assertRaises(media.MediaError):
            media.frame_data_url(good)  # well formed but not made
        (media.cache_dir() / good).write_bytes(b"\xff\xd8\xff")
        self.assertTrue(media.frame_data_url(good).startswith("data:image/jpeg;base64,"))

    def test_production_ids_are_validated(self):
        for pid in ("../productions", "..", "a/b", "C:\\x"):
            with self.assertRaises(production.ProductionError):
                media.production_media(pid)

    def test_only_recorded_media_files_are_sources(self):
        notes = self.base / "notes.txt"
        notes.write_text("not a video", encoding="utf-8")
        self.make_production("p1", master=notes, clips={"sc01": self.base / "gone.mp4", "../x": notes})
        out = media.production_media("p1")
        self.assertEqual(out["film"]["state"], "missing")
        self.assertEqual(out["scenes"], {})

    def test_locate_compares_paths_without_opening_them(self):
        clip = self.base / "work" / "clip.mp4"
        self.make_production("p1", clips={"sc02": clip})
        self.assertEqual(media.locate(path=str(clip)), {"productionId": "p1", "sceneId": "sc02"})
        self.assertIsNone(media.locate(path=str(self.base / "other.mp4")))


class NoFfmpegTest(MediaTestBase):
    def test_everything_reads_unavailable_and_nothing_is_scheduled(self):
        clip = self.base / "c.mp4"
        clip.write_bytes(b"0")
        self.make_production("p1", master=clip, clips={"sc01": clip}, song=clip)
        with mock.patch.object(media, "tools", lambda: (None, None)), \
                mock.patch.object(media, "_schedule", side_effect=AssertionError("scheduled")):
            out = media.production_media("p1")
            thumbs = media.thumbs(["p1"])
        self.assertFalse(out["ffmpeg"])
        self.assertFalse(out["pending"])
        self.assertEqual(out["film"]["state"], "unavailable")
        self.assertEqual(out["wave"]["state"], "unavailable")
        self.assertEqual(out["scenes"]["sc01"]["state"], "unavailable")
        self.assertEqual(thumbs["thumbs"], {"p1": None})

    def test_a_failed_job_is_not_retried_at_once(self):
        clip = self.base / "c.mp4"
        clip.write_bytes(b"not really a video")
        with mock.patch.object(media, "available", lambda: True):
            key = media.source_key(clip.resolve(), "clip")
            (media.cache_dir() / f"{key}.err").write_text("boom", encoding="utf-8")
            self.assertEqual(media.artefact(clip.resolve(), "clip")["state"], "error")


W, H = media.SCORE_W, media.SCORE_H


def _image(pixel) -> bytes:
    return bytes(v for y in range(H) for x in range(W) for v in pixel(x, y))


def _interface(x, y):
    """A screen recording: flat orange cards with straight borders on a dark panel, rows of 1-px text."""
    cx, cy = x % 52, y % 42
    if cx < 4 or cy < 4:
        return (24, 24, 30)
    if 10 <= cy <= 30 and cy % 4 == 2 and 8 <= cx <= 46 and x % 3 != 0:
        return (250, 250, 250)
    return (236, 92, 60)


def _picture(x, y):
    """A subject: a bright warm shape on a smooth dark-to-light gradient, with the fine grain any footage
    has (no lines, no text)."""
    import math
    glow = math.exp(-((x - 100) ** 2 + (y - 40) ** 2) / 260.0)
    grain = (x * 73856093 ^ y * 19349663) % 17 - 8
    return tuple(max(0, min(255, int(v + grain))) for v in (30 + x / 2 + 215 * glow, 28 + y + 150 * glow, 70 + 40 * glow))


# The lavfi fixture: two seconds of testsrc (saturated bars, a counter: an interface-like card), then two
# of a smooth gradient with a bright subject.
UI_THEN_PICTURE = (
    "testsrc=s=320x180:d=2:r=10[a];"
    "nullsrc=s=320x180:d=2:r=10,geq="
    "r='clip(30+X/4+225*exp(-((X-200)*(X-200)+(Y-80)*(Y-80))/1200),0,255)':"
    "g='clip(25+Y/3+170*exp(-((X-200)*(X-200)+(Y-80)*(Y-80))/1200),0,255)':"
    "b='clip(70+X/8+40*exp(-((X-200)*(X-200)+(Y-80)*(Y-80))/1200),0,255)'[b];"
    "[a][b]concat=n=2:v=1"
)


class ScoreTest(unittest.TestCase):
    def test_dark_and_blank_frames_score_nothing(self):
        self.assertEqual(media.frame_score(bytes(W * H * 3)), 0.0)
        self.assertLess(media.frame_score(bytes([250]) * (W * H * 3)), 0.05)
        self.assertEqual(media.frame_score(b""), 0.0)

    def test_an_interface_loses_to_a_picture_although_it_is_more_colourful(self):
        ui, pic = _image(_interface), _image(_picture)
        f_ui, f_pic = media.frame_features(ui), media.frame_features(pic)
        self.assertGreater(f_ui["appeal"], f_pic["appeal"])  # raw contrast and colour would pick the cards
        self.assertGreater(f_ui["straight"], 0.3)
        self.assertGreater(f_ui["flat"], 0.2)
        self.assertGreater(f_ui["thin"], f_pic["thin"])
        self.assertLess(f_pic["ui"], 0.2)
        self.assertGreater(media.frame_score(pic), 2 * media.frame_score(ui))

    def test_candidates_leave_out_the_first_and_last_five_percent(self):
        times = media.candidate_times(60.0)
        self.assertEqual(len(times), media.FILM_CANDIDATES)
        self.assertGreaterEqual(min(times), 3.0)
        self.assertLessEqual(max(times), 57.0)
        self.assertEqual(times, sorted(times))


class PosterChoiceRecordTest(MediaTestBase):
    """The chosen poster is the plugin's own record; inputs are checked before anything is written."""

    def test_bad_times_and_productions_without_a_film_are_refused(self):
        film = self.base / "film.mp4"
        film.write_bytes(b"0")
        self.make_production("p1", master=film)
        self.make_production("p2")
        with mock.patch.object(media, "duration_s", lambda _p: 10.0):
            for bad in (True, "1500", -1, float("nan"), float("inf"), media.MAX_POSTER_MS + 1, [1]):
                with self.assertRaises(media.MediaError, msg=repr(bad)):
                    media.set_poster("p1", bad)
            with self.assertRaises(media.MediaError):
                media.set_poster("p2", 1000)
        with self.assertRaises(production.ProductionError):
            media.set_poster("../p1", 1000)
        self.assertFalse((self.root.parent / media.POSTERS_FILE).exists())

    def test_a_garbled_record_reads_as_no_choice(self):
        (self.root.parent / media.POSTERS_FILE).write_text('{"p1": "soon", "p2": 1200, "p3": true}', encoding="utf-8")
        self.assertEqual(media.poster_choices(), {"p2": 1200})
        (self.root.parent / media.POSTERS_FILE).write_text("[1, 2", encoding="utf-8")
        self.assertEqual(media.poster_choices(), {})


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class FfmpegTest(MediaTestBase):
    def test_poster_skips_the_dark_opening(self):
        film = _lavfi(self.base / "film.mp4",
                      "color=c=black:s=160x90:d=3:r=10[a];testsrc=s=160x90:d=1.5:r=10[b];[a][b]concat=n=2:v=1",
                      "-pix_fmt", "yuv420p")
        film = film.resolve()
        self.assertGreater(media.best_frame_time(film, media.duration_s(film)), 3.0)

    def test_poster_prefers_a_picture_to_an_interface(self):
        film = _lavfi(self.base / "film.mp4", UI_THEN_PICTURE, "-pix_fmt", "yuv420p").resolve()
        self.assertGreater(media.best_frame_time(film, media.duration_s(film)), 2.0)

    def test_a_chosen_poster_persists_and_automatic_comes_back(self):
        film = _lavfi(self.base / "film.mp4", UI_THEN_PICTURE, "-pix_fmt", "yuv420p").resolve()
        folder = self.make_production("p1", master=film)
        auto = self.settle("p1")["film"]
        self.assertEqual(auto["state"], "ready", auto)
        self.assertFalse(auto["posterChosen"])
        self.assertGreater(auto["posterAtMs"], 2000)
        before = {f.name: f.read_bytes() for f in folder.rglob("*") if f.is_file()}

        out = media.set_poster("p1", 1000)
        self.assertTrue(out["film"]["posterChosen"])
        chosen = self.settle("p1")["film"]
        self.assertEqual(chosen["state"], "ready", chosen)
        self.assertEqual((chosen["posterChosen"], chosen["posterAtMs"]), (True, 1000))
        self.assertNotEqual(chosen["poster"], auto["poster"])
        self.assertEqual(media.thumbs(["p1"])["thumbs"]["p1"], chosen["thumb"])
        # Kept in the plugin's own data beside the cache, never in the production's files.
        record = json.loads((self.root.parent / media.POSTERS_FILE).read_text(encoding="utf-8"))
        self.assertEqual(record, {"p1": 1000})
        self.assertEqual({f.name: f.read_bytes() for f in folder.rglob("*") if f.is_file()}, before)
        # A fresh read (another process, a restart) sees the same choice; a time past the end is clamped.
        self.assertEqual(media.poster_choice("p1"), 1000)
        media.set_poster("p1", 99_000)
        self.assertLessEqual(media.poster_choice("p1"), 4000)
        self.settle("p1")

        back = media.set_poster("p1", None)["film"]
        self.assertEqual(back["state"], "ready")  # the automatic frames are still cached
        self.assertEqual((back["posterChosen"], back["poster"]), (False, auto["poster"]))
        self.assertEqual(media.poster_choices(), {})

    def test_production_media_end_to_end(self):
        clip = _lavfi(self.base / "clip.mp4", "testsrc=s=320x180:d=2:r=10", "-pix_fmt", "yuv420p")
        song = _lavfi(self.base / "song.wav", "sine=f=220:d=2")
        self.make_production("p1", master=clip, clips={"sc01": clip}, song=song)
        first = media.production_media("p1")
        self.assertTrue(first["pending"])
        out = self.settle("p1")
        scene = out["scenes"]["sc01"]
        self.assertEqual(scene["state"], "ready", out)
        self.assertEqual(scene["frames"], media.STRIP_FRAMES)
        self.assertEqual(out["film"]["state"], "ready")
        self.assertEqual(out["wave"]["source"], "song")
        self.assertEqual(len(out["wave"]["peaks"]), media.WAVE_BUCKETS)
        self.assertTrue(all(0 <= p <= 1 for p in out["wave"]["peaks"]))
        probe = subprocess.run([media.tools()[1], "-v", "error", "-show_entries", "stream=width,height", "-of", "json",
                                str(media.cache_dir() / scene["strip"])], capture_output=True, text=True, check=True)
        dims = json.loads(probe.stdout)["streams"][0]
        self.assertEqual(dims["height"], media.STRIP_H)
        self.assertEqual(dims["width"], media.STRIP_FRAMES * 240)
        self.assertTrue(media.frame_data_url(out["film"]["poster"]).startswith("data:image/jpeg;base64,"))
        self.assertEqual(media.thumbs(["p1"])["thumbs"]["p1"], out["film"]["thumb"])
        # An unchanged file is never decoded again; a new take is.
        with mock.patch.object(media, "_schedule", side_effect=AssertionError("re-decoded")):
            self.assertEqual(media.production_media("p1")["scenes"]["sc01"]["state"], "ready")
        os.utime(clip, (time.time() + 5, time.time() + 5))
        self.assertEqual(media.production_media("p1")["scenes"]["sc01"]["state"], "pending")
        self.settle("p1")


if __name__ == "__main__":
    unittest.main()
