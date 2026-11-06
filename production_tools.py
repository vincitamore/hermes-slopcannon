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
import re
import time
from pathlib import Path
from typing import Any, Optional

from . import production
from .client import Client, SlopcannonError
from .tools import _CONTENT_TYPES, MAX_BLOCK_S, ToolSpec, _guard, media_line

_DEFAULT_WAIT_S = 90  # well inside Hermes's 420 s tool deadline, approvals included

# What the agent should do next at each gate. Kept beside the tool so the skill and
# the result never disagree.
# On Hermes desktop the film card is where the person answers a gate: its buttons record the answer and resume
# the film, so the agent shows the card and stops. Through chat (or a surface with no card) the agent passes the
# person's answer to slopcannon_produce and Hermes asks again in an approval prompt.
_ON_CARD = ("The film card in `show` carries this decision on Hermes desktop: its buttons are the person's answer "
            "and resume the film by themselves, and the card then shows each next step. Write the `show` lines and "
            "one short sentence on what the card asks, then END YOUR TURN: do not answer the gate yourself, and do "
            "not ask the person to reply in chat. Only if the person answers you in chat instead, or this surface "
            "shows no card, ")

NEXT: dict[str, str] = {
    "rights": _ON_CARD + ("call slopcannon_produce with this production_id and rights_version = "
                          "needsDetail.requiredVersion: Hermes shows them the statement in an approval prompt."),
    "approval": _ON_CARD + ("call slopcannon_produce with approve_credits = needsDetail.totalCannonCredits: Hermes "
                            "asks them in an approval prompt."),
    "budget": _ON_CARD + ("call slopcannon_produce with approve_credits = needsDetail.exposureCredits: Hermes asks "
                          "them in an approval prompt."),
    "first_scene_review": ("The first scene is ready and the character check has already watched it: do not inspect "
                           "the file yourself. " + _ON_CARD + "call slopcannon_produce with review_first = "
                           "needsDetail.sha256 (Hermes asks them in an approval prompt); if they want a different "
                           "direction, start a new production_id with it."),
    "scene_review": ("A chained scene is delivered (needsDetail.scene, take needsDetail.take; the character check has "
                     "already watched it: do not inspect the file yourself). The next scene is bought only after the "
                     "person keeps this take, and starts from its last frame. " + _ON_CARD + "call slopcannon_produce "
                     "with keep_scene = needsDetail.sha256 to keep it, or reroll = [{scene, direction}] to replace it."),
    "shot_review": ("The character check flagged takes (needsDetail.flagged); each flagged clip is in `show`. If "
                    "needsDetail.unchecked lists takes the check could not reach, first call slopcannon_produce with "
                    "the production_id: it checks them again (never check, quote or look up a scene by hand). "
                    + _ON_CARD + "make ONE slopcannon_produce call with accept_checks (the scenes kept) and reroll "
                    "(a list of every scene to replace, each {scene, direction}); never quote, upload or submit a "
                    "production's scenes with the per-scene tools."),
    "reroll_approval": _ON_CARD + ("call slopcannon_produce with approve_reroll = needsDetail.amountUnits: Hermes "
                                   "asks them in an approval prompt."),
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
    if state == "needs" and needs in ("first_scene_review", "scene_review") and out["media"]:
        show.append(out["media"][0])
    elif state == "needs" and needs == "shot_review":
        # The person decides keep-or-reroll per flagged take, so each one is shown, not only described.
        flagged = {f.get("scene") for f in (info.get("needsDetail") or {}).get("flagged") or [] if isinstance(f, dict)}
        for row in info.get("scenes") or []:
            clip = row.get("clip") if isinstance(row, dict) else None
            if row.get("id") in flagged and clip and clip.get("path"):
                show.append(media_line(clip["path"]))
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
        "reviewed": args.get("keep_scene"),
        "accept_checks": args.get("accept_checks"),
        "reroll": args.get("reroll"),
        "approve_reroll": args.get("approve_reroll"),
    }
    for asked in production._reroll_list(args.get("reroll")):
        problem = production.reroll_problem(pid, asked["scene"])
        if problem:
            raise production.ProductionError(f"cannot reroll now: {problem}", "reroll_unavailable")
    if any(v not in (None, "", [], {}) for v in decisions.values()):
        production.record_decisions(pid, decisions)
    if session_id:
        production.remember_session(pid, session_id)
    production.start(pid, concurrency=int(args.get("concurrency") or production.CONCURRENCY))
    raw_wait = args.get("wait_s")
    wait_s = min(max(_DEFAULT_WAIT_S if raw_wait is None else int(raw_wait), 0), MAX_BLOCK_S)
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
    wait_s = min(max(int(args.get("wait_s") or 0), 0), MAX_BLOCK_S)
    if wait_s:
        production.wait(pid, wait_s)
    return _owe(session_id, _result(production.summary(pid, detail=True)))


def _stop(args: dict[str, Any]) -> str:
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
        "continuity": {"type": "string", "enum": ["chain"], "description": (
            "Omit (the default) to render every scene at once after the first-scene review. 'chain' renders one "
            "scene at a time, each from the last frame of the scene before, and stops at scene_review for each "
            "(keep_scene or reroll) before the next is bought. For a consistent look without chain, storyboard "
            "first: one keyframe per scene with image_generate, each passed as that scene's set picture, as "
            "skill_view('slopcannon:hermes-workflow') explains.")},
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
        "Start with `production` (and `timed_plan` when the person supplied one). It stops at each human gate "
        "(rights sign-off, credit approval, first-scene review, each chained scene's review (scene_review), "
        "flagged takes, a reroll's quote) and says exactly what to do: on Hermes desktop the person answers on "
        "the film card, so show the card and end the turn. When the person answers in chat, pass it with the same "
        "production_id as rights_version / approve_credits / review_first / keep_scene / accept_checks / reroll / "
        "approve_reroll; Hermes asks them to approve it in a prompt. It does the uploads, "
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
            "keep_scene": {"type": "string", "description": (
                "Chain continuity: needsDetail.sha256 of the delivered scene the person keeps; the next scene "
                "starts from its last frame.")},
            "accept_checks": {"type": "array", "items": {"type": "string"},
                              "description": "Flagged scene ids (sc03) the person accepts as they are."},
            "reroll": {"type": "array", "description": (
                "Replace delivered scenes with new takes (at the take check or after the film is done): every scene "
                "the person wants replaced, in ONE call. They are quoted together, approved together with "
                "approve_reroll, render at the same time, and the film is then cut with the new takes."),
                "items": {"type": "object",
                          "properties": {"scene": {"type": "string", "description": "The scene id, such as sc08."},
                                         "direction": {"type": "string", "description": "What to change in the new take."}},
                          "required": ["scene"], "additionalProperties": False}},
            "approve_reroll": {"type": "integer", "minimum": 0,
                               "description": "needsDetail.amountUnits: the rerolls' quoted total the person approved."},
            "concurrency": {"type": "integer", "minimum": 1, "maximum": 16},
            "wait_s": {"type": "integer", "minimum": 0, "maximum": MAX_BLOCK_S, "description": (
                f"Seconds to wait for the next stop (default {_DEFAULT_WAIT_S}, max {MAX_BLOCK_S}); if it is "
                "still running then, the result says so and slopcannon_production_status keeps watching.")},
        },
        "additionalProperties": False,
    },
}, _guard(_produce, pass_session=True))

PRODUCTION_STATUS = ToolSpec("slopcannon_production_status", {
    "name": "slopcannon_production_status",
    "description": (
        "Where a SLOPCANNON production stands: phase, the gate it waits on, every scene's status, credits "
        "committed, and the master as MEDIA when finished. Without production_id, lists recent productions. "
        f"wait_s blocks until the next stop, at most {MAX_BLOCK_S} s; if it is still running then, call again."),
    "parameters": {
        "type": "object",
        "properties": {
            "production_id": {"type": "string"},
            "wait_s": {"type": "integer", "minimum": 0, "maximum": MAX_BLOCK_S},
        },
        "additionalProperties": False,
    },
}, _guard(_status, pass_session=True))

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
_ANALYSIS_POLL_S = 8
# A BCP-47-shaped language tag (en, pt-BR, zh-Hant-TW). It names the cached transcript file, so nothing else may
# reach the path.
_LANGUAGE_TAG = re.compile(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*")
_LANGUAGE_MAX = 35


def _language(value: Any) -> str:
    """The validated language tag, or "" when none was given."""
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or len(value) > _LANGUAGE_MAX or not _LANGUAGE_TAG.fullmatch(value):
        raise SlopcannonError(f"language must be a BCP-47 tag such as en or pt-BR (letters, digits and hyphens, at "
                              f"most {_LANGUAGE_MAX} characters), not {value!r}", code="invalid_language")
    return value


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


def _transcribe(args: dict[str, Any]) -> str:
    deadline = time.monotonic() + max(30, min(int(args.get("timeout_s") or MAX_BLOCK_S), MAX_BLOCK_S))
    language = _language(args.get("language"))
    song = Path(str(args.get("song") or "")).expanduser()
    if not song.is_file():
        raise SlopcannonError(f"no file at {song}", code="file_not_found")
    data = song.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
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
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            again = {"song": str(song), "rights_version": required, **({"language": language} if language else {})}
            return json.dumps({"ok": True, "status": "running", "analysisId": analysis_id, "call_again": again,
                               "message": ("Song analysis is still running. Call slopcannon_transcribe again with the "
                                           "arguments in call_again: it picks up the same analysis and uploads "
                                           "nothing twice.")})
        time.sleep(min(_ANALYSIS_POLL_S, remaining))
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
        "slopcannon_produce. Cached per song. Read the excerpt to write each scene's direction against the words. "
        f"Waits at most timeout_s (default and max {MAX_BLOCK_S} s); if the analysis is still running then, the "
        "result has status running and `call_again`: call again with those arguments."),
    "parameters": {
        "type": "object",
        "properties": {
            "song": {"type": "string", "description": "Absolute path of the song."},
            "rights_version": {"type": "string", "description": "requiredVersion from slopcannon_account."},
            "language": {"type": "string", "maxLength": _LANGUAGE_MAX, "pattern": f"^{_LANGUAGE_TAG.pattern}$",
                         "description": "BCP-47 code such as en or pt-BR, when known."},
            "timeout_s": {"type": "integer", "minimum": 30, "maximum": MAX_BLOCK_S},
        },
        "required": ["song"],
        "additionalProperties": False,
    },
}, _guard(_transcribe))


TOOLS: list[ToolSpec] = [TRANSCRIBE, PRODUCE, PRODUCTION_STATUS, PRODUCTION_STOP]
