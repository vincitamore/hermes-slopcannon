"""Agent tools for whole productions (``production.py`` drives them).

``slopcannon_produce`` is the one call that takes a song to a finished film. It
writes the production, starts the driver in the background, waits a while, and
reports where the film stands: running, done (with the master as MEDIA), or
stopped at a human gate with exactly what the person must decide. Answers to a
gate come back through the same tool and pass Hermes's approval prompt first.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from . import production
from .client import Client, SlopcannonError
from .tools import _CONTENT_TYPES, ToolSpec, _fail


def _guard(fn):
    """Like tools._guard, but hands the chat's session_id on so the studio can answer in that chat."""
    def handler(args: dict[str, Any], session_id: str = "", **_: Any) -> str:
        try:
            return fn(args or {}, session_id=str(session_id or ""))
        except Exception as exc:  # every failure is a structured result, never a crash
            return _fail(exc)
    return handler

_DEFAULT_WAIT_S = 240
_MAX_WAIT_S = 840

# What the agent should do next at each gate. Kept beside the tool so the skill and
# the result never disagree.
NEXT: dict[str, str] = {
    "rights": ("Show the person needsDetail.statement and the files, then call slopcannon_produce with this "
               "production_id and rights_version = needsDetail.requiredVersion. Hermes asks them to approve."),
    "approval": ("Show every scene's quote and needsDetail.totalCannonCredits, then call slopcannon_produce with "
                 "approve_credits = the ceiling they agree to (at least the total). Hermes asks them to approve."),
    "budget": ("The approved ceiling is too low for the work still to buy (needsDetail). Ask the person for a "
               "higher ceiling and pass it as approve_credits, or stop."),
    "first_scene_review": ("The first scene is ready (its MEDIA line is in `media`; put it alone on its own line). "
                           "Ask the person to watch it. Only after they say it is good, call slopcannon_produce with "
                           "review_first = needsDetail.sha256. If it is wrong, change the direction and start a new "
                           "production_id."),
    "shot_review": ("The character check flagged takes (needsDetail.flagged: issue and second). Show each one. Pass "
                    "the scenes the person accepts as accept_checks, or reroll a scene with their approval."),
    "review": "Some scenes did not deliver. Show needsDetail.failed; run slopcannon_production_status later, or "
              "revise the direction in a new production_id.",
    "new_revision": "The inputs changed after paid work began. Use a new production_id for the revision.",
    "origin": "SLOPCANNON is not accepting this workflow right now; try again later.",
    "recovery": "This production needs recovery of earlier jobs; nothing new was bought. Tell the person.",
}


def _result(info: dict[str, Any]) -> str:
    out: dict[str, Any] = {"ok": True, "production": info, "media": production.media_lines(info)}
    state, needs = info.get("state"), info.get("needs")
    if state == "needs" and needs:
        out["next"] = NEXT.get(str(needs), "Tell the person what the production needs.")
    elif state == "running":
        out["next"] = ("Still rendering. Tell the person it is running and that the SLOPCANNON studio shows live "
                       "progress; call slopcannon_production_status with wait_s to keep watching.")
    elif state == "done":
        out["next"] = ("Finished. Put the MEDIA line for the master alone on its own line. Ask the person to judge "
                       "identity, mouth timing and take quality; the sync check does not judge those.")
    elif state == "error":
        out["next"] = "Tell the person the error in plain words. Paid work already accepted is never bought again."
    out["card"] = f'::slopcannon-film{{id="{info["id"]}"}}'
    return json.dumps(out, default=str)


def _produce(args: dict[str, Any], session_id: str = "") -> str:
    spec = args.get("production")
    pid = str(args.get("production_id") or "")
    if not pid:
        if not isinstance(spec, dict):
            raise production.ProductionError("pass production_id, or a production to start", "missing_production")
        pid = production.slug(str(spec.get("title") or ""))
    if isinstance(spec, dict):
        production.write_production(pid, spec, args.get("timed_plan") if isinstance(args.get("timed_plan"), dict) else None)
    elif production.load_state(pid) is None:
        raise production.ProductionError(f"no production {pid}; pass `production` to start it", "unknown_production")
    decisions = {
        "rights_version": args.get("rights_version"),
        "approved_credits": args.get("approve_credits"),
        "review_first": args.get("review_first"),
        "accept_checks": args.get("accept_checks"),
    }
    if any(v not in (None, "", []) for v in decisions.values()):
        production.record_decisions(pid, decisions)
    if session_id:
        production.remember_session(pid, session_id)
    production.start(pid, concurrency=int(args.get("concurrency") or 4))
    raw_wait = args.get("wait_s")
    wait_s = min(max(_DEFAULT_WAIT_S if raw_wait is None else int(raw_wait), 0), _MAX_WAIT_S)
    production.wait(pid, wait_s)
    return _result(production.summary(pid, detail=True))


def _status(args: dict[str, Any], session_id: str = "") -> str:
    pid = args.get("production_id")
    if not pid:
        return json.dumps({"ok": True, "productions": [production.summary(i) for i in production.list_ids()[:20]]},
                          default=str)
    pid = str(pid)
    wait_s = min(max(int(args.get("wait_s") or 0), 0), _MAX_WAIT_S)
    if wait_s:
        production.wait(pid, wait_s)
    return _result(production.summary(pid, detail=True))


def _stop(args: dict[str, Any], session_id: str = "") -> str:
    pid = str(args.get("production_id") or "")
    stopped = production.stop(pid)
    return json.dumps({"ok": True, "stopped": stopped, "note": (
        "Scenes already accepted keep rendering on the server and are recovered, not re-bought, when the production "
        "continues.") if stopped else "It was not running."})


_PRODUCTION_SCHEMA = {
    "type": "object",
    "description": (
        "The production file (see the slopcannon-music-video skill, references/agent-cli.md, 'The production "
        "file'): title, song (local path), references [{name, path | character, kind?}], singer, language, "
        "identityLock, transcript (local word-timed JSON path), cuts, scenes [{shot, cast}], aspectRatio, bible. "
        "Do not put approvals in it; they are ignored."),
    "properties": {
        "title": {"type": "string"},
        "song": {"type": "string", "description": "Absolute path of the song the person owns or licenses."},
        "concept": {"type": "string"},
        "references": {"type": "array", "items": {"type": "object"}},
        "transcript": {"type": "string"},
        "scenes": {"type": "array", "items": {"type": "object"}},
        "aspectRatio": {"type": "string", "description": "One of the ratios slopcannon_account lists; default 16:9."},
    },
    "required": ["title", "song"],
}

PRODUCE = ToolSpec("slopcannon_produce", {
    "name": "slopcannon_produce",
    "description": (
        "Make a whole SLOPCANNON music video from a local song in one call: uploads, scene plan, quotes, a first "
        "scene for review, parallel renders, character checks and assembly, run in the background and resumable. "
        "Start with `production`; it stops at each human gate (rights, credit approval, first-scene review, "
        "flagged takes) and says exactly what to ask. Answer a gate by calling again with the same production_id "
        "and rights_version / approve_credits / review_first / accept_checks; Hermes asks the person to approve "
        "each answer. Nothing is bought twice. Prefer this over driving the per-scene tools by hand."),
    "parameters": {
        "type": "object",
        "properties": {
            "production_id": {"type": "string", "description": "Omit when starting; returned in the result."},
            "production": _PRODUCTION_SCHEMA,
            "timed_plan": {"type": "object", "description": "A hand-authored timed plan, when there is no transcript."},
            "rights_version": {"type": "string", "description": "The rights version the person signed off on."},
            "approve_credits": {"type": "integer", "minimum": 0,
                                "description": "The whole-film Cannon Credit ceiling the person approved."},
            "review_first": {"type": "string", "description": "sha256 of the first scene the person reviewed."},
            "accept_checks": {"type": "array", "items": {"type": "string"},
                              "description": "Flagged scene ids (sc03) the person accepts as they are."},
            "concurrency": {"type": "integer", "minimum": 1, "maximum": 16},
            "wait_s": {"type": "integer", "minimum": 0, "maximum": _MAX_WAIT_S,
                       "description": f"How long to wait for the next stop (default {_DEFAULT_WAIT_S})."},
        },
        "additionalProperties": False,
    },
}, _guard(_produce))

PRODUCTION_STATUS = ToolSpec("slopcannon_production_status", {
    "name": "slopcannon_production_status",
    "description": (
        "Where a SLOPCANNON production stands: phase, the gate it waits on, every scene's status, credits "
        "committed, and the master as MEDIA when finished. Without production_id, lists recent productions. "
        "wait_s blocks until the next stop."),
    "parameters": {
        "type": "object",
        "properties": {
            "production_id": {"type": "string"},
            "wait_s": {"type": "integer", "minimum": 0, "maximum": _MAX_WAIT_S},
        },
        "additionalProperties": False,
    },
}, _guard(_status))

PRODUCTION_STOP = ToolSpec("slopcannon_production_stop", {
    "name": "slopcannon_production_stop",
    "description": ("Stop a running SLOPCANNON production on this machine. Accepted scenes finish on the server and "
                    "are recovered without paying again when it continues."),
    "parameters": {
        "type": "object",
        "properties": {"production_id": {"type": "string"}},
        "required": ["production_id"],
        "additionalProperties": False,
    },
}, _guard(_stop))

# --------------------------------------------------------------------------- transcription


_PHRASE_GAP_S = 0.7
_ANALYSIS_TIMEOUT_S = 600


def _asset_id(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("assetId", "id"):
            if isinstance(value.get(key), str):
                return value[key]
        for nested in ("asset", "data"):
            if isinstance(value.get(nested), dict):
                found = _asset_id(value[nested])
                if found:
                    return found
    return ""


def whisper_json(words: list[dict[str, Any]]) -> dict[str, Any]:
    """Server analysis words -> Whisper-shaped JSON (``segments[].words[]``, seconds) for the driver."""
    segments: list[dict[str, Any]] = []
    for raw in words:
        text = str(raw.get("word") or raw.get("text") or "").strip()
        start = raw.get("start", raw.get("startSeconds"))
        end = raw.get("end", raw.get("endSeconds"))
        if not text or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        word = {"word": text, "start": float(start), "end": float(end)}
        if segments and start - segments[-1]["words"][-1]["end"] <= _PHRASE_GAP_S:
            segments[-1]["words"].append(word)
        else:
            segments.append({"words": [word]})
    for segment in segments:
        segment["start"], segment["end"] = segment["words"][0]["start"], segment["words"][-1]["end"]
        segment["text"] = " ".join(w["word"] for w in segment["words"])
    return {"segments": segments}


def _transcribe(args: dict[str, Any], session_id: str = "") -> str:
    song = Path(str(args.get("song") or "")).expanduser()
    if not song.is_file():
        raise SlopcannonError(f"no file at {song}", code="file_not_found")
    data = song.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    language = args.get("language")
    out = production.root().parent / "transcripts" / f"{digest[:24]}{'-' + language if language else ''}.words.json"
    if out.is_file():
        cached = json.loads(out.read_text(encoding="utf-8"))
        return json.dumps({"ok": True, "transcript": str(out), "phrases": len(cached.get("segments") or []),
                           "cached": True, "excerpt": " / ".join(s["text"] for s in cached["segments"][:4])[:400]})
    client = Client()
    policy = client.rights_policy()
    required = policy.get("requiredVersion")
    if args.get("rights_version") != required:
        return json.dumps({"ok": False, "error": "rights_required", "requiredVersion": required,
                           "statement": policy.get("statement"),
                           "message": "Show the person this statement and the song's file name, then call again "
                                      "with rights_version; Hermes asks them to approve."})
    content_type = _CONTENT_TYPES.get(song.suffix.lower())
    if not content_type:
        raise SlopcannonError("the song must be mp3, wav, m4a or ogg", code="unknown_content_type")
    project = client.call_tool("slopcannon_create_project", {
        "name": f"Song analysis: {song.stem}"[:120], "idempotencyKey": f"hermes-analysis-project-{digest[:40]}"})
    project_id = (project.get("project") or project).get("id") if isinstance(project, dict) else None
    if not project_id:
        raise SlopcannonError("SLOPCANNON did not return a project id", code="project_failed", details=project)
    asset = client.upload_asset(path=song, project_id=project_id, kind="song", content_type=content_type,
                                rights_version=required, idempotency_key=f"hermes-analysis-song-{digest[:40]}")
    asset_id = _asset_id(asset)
    if not asset_id:
        raise SlopcannonError("the upload returned no asset id", code="upload_failed", details=asset)
    started = client.call_tool("slopcannon_start_song_analysis",
                               {"assetId": asset_id, **({"language": language} if language else {})})
    analysis_id = ((started.get("analysis") or {}).get("id") if isinstance(started, dict) else None) \
        or (started.get("analysisId") if isinstance(started, dict) else None)
    if not analysis_id:
        raise SlopcannonError("song analysis did not start", code="analysis_failed", details=started)
    deadline = time.monotonic() + min(int(args.get("timeout_s") or _ANALYSIS_TIMEOUT_S), _ANALYSIS_TIMEOUT_S)
    words: list[dict[str, Any]] = []
    while True:
        page = client.call_tool("slopcannon_get_song_analysis",
                                {"analysisId": analysis_id, "wordOffset": len(words), "wordLimit": 1000})
        status = ((page or {}).get("analysis") or {}).get("status")
        if status in ("failed", "error"):
            raise SlopcannonError("song analysis failed", code="analysis_failed", details=page.get("analysis"))
        transcription = (page or {}).get("transcription")
        if status == "ready" and isinstance(transcription, dict):
            words.extend(w for w in transcription.get("words") or [] if isinstance(w, dict))
            if transcription.get("nextOffset") is None:
                break
            continue
        if time.monotonic() >= deadline:
            return json.dumps({"ok": False, "error": "analysis_running", "analysisId": analysis_id,
                               "message": "Song analysis is still running; call slopcannon_transcribe again."})
        time.sleep(8)
    doc = whisper_json(words)
    if not doc["segments"]:
        raise SlopcannonError("the analysis found no timed words (an instrumental?); write a timed_plan instead",
                              code="no_words")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8", newline="\n")
    return json.dumps({"ok": True, "transcript": str(out), "phrases": len(doc["segments"]), "words": len(words),
                       "excerpt": " / ".join(s["text"] for s in doc["segments"][:4])[:400]})


TRANSCRIBE = ToolSpec("slopcannon_transcribe", {
    "name": "slopcannon_transcribe",
    "description": (
        "Word-timed lyrics for a local song, from SLOPCANNON's song analysis (no credits): uploads the song under the "
        "person's rights sign-off and returns `transcript`, a local JSON path to pass as production.transcript to "
        "slopcannon_produce. Cached per song. Read the excerpt to write each scene's direction against the words."),
    "parameters": {
        "type": "object",
        "properties": {
            "song": {"type": "string", "description": "Absolute path of the song."},
            "rights_version": {"type": "string", "description": "requiredVersion from slopcannon_account."},
            "language": {"type": "string", "description": "BCP-47 code such as en, when known."},
            "timeout_s": {"type": "integer", "minimum": 30, "maximum": _ANALYSIS_TIMEOUT_S},
        },
        "required": ["song"],
        "additionalProperties": False,
    },
}, _guard(_transcribe))


TOOLS: list[ToolSpec] = [TRANSCRIBE, PRODUCE, PRODUCTION_STATUS, PRODUCTION_STOP]
