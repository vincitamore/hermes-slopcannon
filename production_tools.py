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
from typing import Any, Optional

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

_DEFAULT_WAIT_S = 90  # well inside Hermes's 420 s tool deadline, approvals included
_MAX_WAIT_S = 300

# What the agent should do next at each gate. Kept beside the tool so the skill and
# the result never disagree.
NEXT: dict[str, str] = {
    "rights": ("Call slopcannon_produce again now, in this same turn, with this production_id and rights_version = "
               "needsDetail.requiredVersion. Do not ask the person to type their agreement: Hermes shows them the "
               "statement and the files in an approval prompt, and their Approve is the sign-off. Say one line "
               "first (what the files are and that the prompt carries the statement)."),
    "approval": ("Show every scene's quote and needsDetail.totalCannonCredits in a short table, then call "
                 "slopcannon_produce again now, in this same turn, with approve_credits = "
                 "needsDetail.totalCannonCredits. Do not ask the person to reply in chat: Hermes shows them the "
                 "figure in an approval prompt, and Approve or Deny is their answer."),
    "budget": ("The approved ceiling is too low for the work still to buy (needsDetail). Ask the person for a "
               "higher ceiling and pass it as approve_credits, or stop."),
    "first_scene_review": ("The first scene is ready and the character check has already watched it: do not "
                           "inspect the file yourself. After showing it, in this same turn, call slopcannon_produce with review_first = needsDetail.sha256: "
                           "Hermes asks the person in an approval prompt to watch the scene and approve rendering "
                           "the rest. Do not ask them to reply in chat. If they deny, ask what to change and start "
                           "a new production_id with the revised direction."),
    "shot_review": ("The character check flagged takes (needsDetail.flagged: issue and second). If "
                    "needsDetail.unchecked lists takes the check could not reach, call slopcannon_produce with the "
                    "production_id first: it checks them again (never check, quote or look up a scene by hand). "
                    "Show each flagged one and "
                    "ask the person, per scene, to keep it or replace it. Keep: call slopcannon_produce with "
                    "accept_checks naming those scenes. Replace: call slopcannon_produce with reroll = {scene, "
                    "direction (optional, what to change)}; it quotes the new take and stops for their approval, then "
                    "cuts it into the film. Never quote, upload or submit a production's scenes with the per-scene "
                    "tools."),
    "reroll_approval": ("The new take of needsDetail.scene is quoted at needsDetail.amountUnits Cannon Credits. Say "
                        "so in one line, then call slopcannon_produce again now with approve_reroll = "
                        "needsDetail.amountUnits: Hermes asks the person in an approval prompt. Do not ask in chat."),
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
        out["next"] = ("Tell the person the error in plain words. To try again, call slopcannon_produce with the same "
                       "production_id: it recovers jobs already sent and never buys them twice. Do not open, edit or "
                       "run the production's files or the plugin's driver yourself.")
    out["card"] = f'::slopcannon-film{{id="{info["id"]}"}}'
    # The cards are how the person sees the film in chat, and the agent only shows them by writing these lines in
    # its reply; stated once in the skill they were skipped, so every result leads with them.
    show = [out["card"]]
    if state == "needs" and needs == "first_scene_review" and out["media"]:
        show.append(out["media"][0])
    elif state == "done" and out["media"]:
        show.append(out["media"][-1])
    out["show"] = show
    out["next"] = ("Write each line in `show` alone on its own line in your message text now, in the same message "
                   "as your next tool call if you make one (on Hermes desktop they render the film card and the "
                   "clip the person is about to judge; on other surfaces keep only MEDIA lines). Then: "
                   + out.get("next", "tell the person where the production stands."))
    return json.dumps(out, default=str)


# The lines each chat's current turn has been handed, so its final reply always carries them (show_in_reply): an
# agent that answers every gate in one turn otherwise writes no reply in which the card could render.
_PENDING_SHOW: dict[str, list[str]] = {}


def _owe(session_id: str, text: str) -> str:
    if session_id:
        try:
            lines = json.loads(text).get("show") or []
        except (ValueError, AttributeError):
            lines = []
        owed = _PENDING_SHOW.setdefault(session_id, [])
        owed.extend(line for line in lines if line not in owed)
    return text


def show_in_reply(response_text: str = "", session_id: str = "", **_: Any) -> Optional[str]:
    """transform_llm_output: lead the turn's final reply with any card or clip line it left out."""
    owed = _PENDING_SHOW.pop(str(session_id or ""), None)
    if not owed or not isinstance(response_text, str):
        return None
    missing = [line for line in owed if line not in response_text]
    return "\n\n".join(missing + [response_text]) if missing else None


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
        "reroll": args.get("reroll"),
        "approve_reroll": args.get("approve_reroll"),
    }
    if isinstance(args.get("reroll"), dict):
        problem = production.reroll_problem(pid, args["reroll"].get("scene"))
        if problem:
            raise production.ProductionError(f"cannot reroll now: {problem}", "reroll_unavailable")
    if any(v not in (None, "", [], {}) for v in decisions.values()):
        production.record_decisions(pid, decisions)
    if session_id:
        production.remember_session(pid, session_id)
    production.start(pid, concurrency=int(args.get("concurrency") or 4))
    raw_wait = args.get("wait_s")
    wait_s = min(max(_DEFAULT_WAIT_S if raw_wait is None else int(raw_wait), 0), _MAX_WAIT_S)
    production.wait(pid, wait_s)
    return _owe(session_id, _result(production.summary(pid, detail=True)))


def _status(args: dict[str, Any], session_id: str = "") -> str:
    pid = args.get("production_id")
    if not pid:
        return json.dumps({"ok": True, "productions": [production.summary(i) for i in production.list_ids()[:20]]},
                          default=str)
    pid = str(pid)
    if session_id and production.load_state(pid) is not None:
        production.remember_session(pid, session_id)  # the chat talking about a film is the one the studio answers
    wait_s = min(max(int(args.get("wait_s") or 0), 0), _MAX_WAIT_S)
    if wait_s:
        production.wait(pid, wait_s)
    return _owe(session_id, _result(production.summary(pid, detail=True)))


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
        "references": {"type": "array", "description": "One picture per cast name the scenes use.", "items": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The cast name in capitals, exactly as the scenes write it."},
                "path": {"type": "string", "description": "Absolute path of the picture."},
                "kind": {"type": "string", "enum": ["character", "product"], "description": (
                    "character (the default) for a person or creature; product for a set, place or object.")},
            },
            "required": ["name"],
        }},
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
        "Start with `production` (and `timed_plan` when the person supplied one); pass rights_version "
        "(slopcannon_account's rights.requiredVersion) on that first call and Hermes shows the person the rights "
        "statement and files in an approval prompt. It stops at each later human gate (credit approval, "
        "first-scene review, flagged takes) and says exactly what to do. Answer a gate by calling again at once "
        "with the same production_id and approve_credits / review_first / accept_checks / reroll / approve_reroll; Hermes asks the person "
        "to approve each answer in a prompt, so never ask them to type an agreement in chat. It does the uploads, "
        "hashing and quotes itself, and validates the production and timed_plan before anything is signed: do not "
        "run node or the skill's scripts yourself. Nothing is bought twice. Prefer this over driving the per-scene "
        "tools by hand."),
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
            "reroll": {"type": "object", "description": (
                "Replace one delivered scene with a new take (at the take check or after the film is done). It is "
                "quoted first and bought only on approve_reroll; the film is then cut with the new take."),
                "properties": {"scene": {"type": "string", "description": "The scene id, such as sc08."},
                               "direction": {"type": "string", "description": "What to change in the new take."}},
                "required": ["scene"], "additionalProperties": False},
            "approve_reroll": {"type": "integer", "minimum": 0,
                               "description": "The reroll's quoted Cannon Credits the person approved."},
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
