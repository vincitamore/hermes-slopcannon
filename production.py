"""Whole productions, driven by SLOPCANNON's own production driver.

The published CLI ships ``scripts/slopcannon-agent.mjs run``: the reviewed,
resumable pipeline (project, uploads, server scene audio, timed plan, quotes,
first-scene review, parallel renders, character checks, server assembly) with a
ledger that makes every paid step recoverable. The plugin runs that driver
rather than re-implementing it, so Hermes produces films exactly the way the
conformance suite does.

The driver stops at each human gate with ``{"ok": false, "needs": ...}``. Gate
answers (rights assent, the approved credit ceiling, first-scene review,
accepted check flags, rerolls) are taken only from its command line, so here
they come only from decisions a person made: a click on the film card
(``decide``, through the dashboard's decide route) or an answer confirmed in
Hermes's approval prompt (``gate.py``), never from the production file the
model writes.

Each production lives in ``<plugin data>/productions/<id>/``: ``production.json``
(model-authored direction), ``ledger.json`` (the driver's paid-work record),
``state.json`` (this module's view) and ``work/`` (plans, clips, the master).
Runs happen on a background thread so a render can take as long as it takes.
"""
from __future__ import annotations

import atexit
import contextlib
import contextvars
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, Optional

from . import auth, settings

# Resolved: Node runs a script only when its own real path equals argv[1], and a plugin installed as a
# link (or loaded through a differently-cased path) otherwise exits 0 having done nothing.
def _driver_path(plugin_dir: Path) -> Path:
    return (plugin_dir / "skills" / "slopcannon-music-video" / "scripts" / "slopcannon-agent.mjs").resolve()


DRIVER = _driver_path(Path(__file__).parent)
MIN_NODE = (22, 13)
_GATE_KEYS = ("rightsAccepted", "approve", "maxCredits")
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_LOG_LINES = 40
_HEARTBEAT_S = 3
_STALE_S = 20
_STOP_WAIT_S = 5
CONCURRENCY = 4  # scenes rendered at once, wherever a run is started without an explicit number
_MAX_CARRIED_QUOTES = 1  # times an approved reroll's approval may carry over to a re-quote of the same take

_runners: dict[str, "_Runner"] = {}
_runners_lock = threading.Lock()
_state_locks: dict[str, threading.RLock] = {}
_state_locks_guard = threading.Lock()


class ProductionError(RuntimeError):
    def __init__(self, message: str, code: str = "production_error"):
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------- storage


def root() -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir

        base = Path(plugin_data_dir("slopcannon"))
    except Exception:
        try:
            from hermes_constants import get_hermes_home

            base = Path(get_hermes_home()) / "plugin-data" / "slopcannon"
        except Exception:
            base = Path.home() / ".hermes" / "plugin-data" / "slopcannon"
    path = base / "productions"
    path.mkdir(parents=True, exist_ok=True)
    return path


def slug(title: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:48] or "film"
    return f"{text}-{time.strftime('%Y%m%d')}"


def _dir(production_id: str) -> Path:
    if not _ID.match(production_id or ""):
        raise ProductionError(f"invalid production id {production_id!r}", "invalid_id")
    return root() / production_id


def _read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # A temp name of its own per write: two threads saving the same file never share (or delete) one temp file.
    tmp = path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(value, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        # On Windows a replace onto a file another process has open (the studio polling it, an indexer) fails for
        # a moment with PermissionError; the driver's ledger save stopped a paid run that way once. Wait it out.
        for attempt in range(25):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 24:
                    raise
                time.sleep(0.2)
    finally:
        tmp.unlink(missing_ok=True)


def _state_lock(production_id: str) -> threading.RLock:
    """The lock every read-modify-write of one production's state holds (the runner thread, a chat's tool call
    and the film card can all change it at once)."""
    with _state_locks_guard:
        return _state_locks.setdefault(production_id, threading.RLock())


def _read_state(production_id: str) -> Optional[dict[str, Any]]:
    """The production's state, or None when it has none. A state file that exists but cannot be read raises:
    every caller that writes state starts from this, so an unreadable file is never replaced by a fresh one."""
    path = _dir(production_id) / "state.json"
    text = ""
    for attempt in range(10):
        try:
            text = path.read_text(encoding="utf-8")
            break
        except FileNotFoundError:
            return None
        except PermissionError:  # Windows: another process has it open for a moment
            if attempt == 9:
                raise ProductionError(f"{path} is held open by another program; nothing was changed. Call the "
                                      "tool again with the same id.", "state_unreadable") from None
            time.sleep(0.1)
        except OSError as exc:
            raise ProductionError(f"{path} cannot be read ({exc}); nothing was changed.", "state_unreadable") from None
    try:
        value = json.loads(text)
    except ValueError:
        value = None
    if not isinstance(value, dict):
        raise ProductionError(f"{path} is not a production record; nothing was changed or reset.", "state_unreadable")
    return value


def load_state(production_id: str) -> Optional[dict[str, Any]]:
    """The production's state for reading, or None when it has none or its file cannot be read."""
    try:
        return _read_state(production_id)
    except ProductionError as exc:
        if exc.code == "invalid_id":
            raise
        return None


@contextlib.contextmanager
def _editing(production_id: str) -> Iterator[dict[str, Any]]:
    """Change a production's state: read fresh under its lock, changed by the caller, saved on leaving."""
    with _state_lock(production_id):
        state = _read_state(production_id)
        if state is None:
            raise ProductionError(f"no production {production_id}", "unknown_production")
        yield state
        _save_state(production_id, state)


def _save_state(production_id: str, state: dict[str, Any]) -> None:
    state["updatedAt"] = int(time.time() * 1000)
    _write_json(_dir(production_id) / "state.json", state)
    _broadcast("production.updated", {"id": production_id, "state": state.get("state"), "needs": state.get("needs")})


def list_ids() -> list[str]:
    ids = [p.name for p in root().iterdir() if p.is_dir() and (p / "state.json").is_file()]
    return sorted(ids, key=lambda i: (load_state(i) or {}).get("updatedAt", 0), reverse=True)


def _broadcast(event: str, payload: dict[str, Any]) -> None:
    # Only the gateway process has live transports to deliver to, and it has tui_gateway.server loaded. Anywhere
    # else (a script driving the handlers, a CLI import) Hermes would import it just to log a dropped-event warning
    # with a full traceback on every state write; the studio polls state.json, so nothing is lost by skipping.
    if "tui_gateway.server" not in sys.modules:
        return
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event

        broadcast_plugin_event("slopcannon", event, payload)
    except Exception:
        pass  # no Desktop attached, or an older Hermes: the UI polls


# --------------------------------------------------------------------------- environment

_node_lock = threading.Lock()
_node_checked: Optional[tuple[float, dict[str, Any]]] = None
_NODE_RECHECK_S = 60


def node_status() -> dict[str, Any]:
    """Whether Node.js can run the driver. A good answer holds for the life of the process; a failed one is checked
    again at most once a minute, so installing Node is noticed without running ``node`` on every status read."""
    global _node_checked
    with _node_lock:
        if _node_checked is not None:
            checked_at, status = _node_checked
            if status["ok"] or time.monotonic() - checked_at < _NODE_RECHECK_S:
                return dict(status)
        status = _check_node()
        _node_checked = (time.monotonic(), status)
        return dict(status)


def _check_node() -> dict[str, Any]:
    node = shutil.which("node")
    if not node:
        return {"ok": False, "message": "Node.js 22.13 or newer is required for whole productions (nodejs.org)."}
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
        major, minor = (int(x) for x in out.lstrip("v").split(".")[:2])
    except Exception:
        return {"ok": False, "message": "Could not read the Node.js version."}
    if (major, minor) < MIN_NODE:
        return {"ok": False, "message": f"Node.js {out} is too old; 22.13 or newer is required."}
    return {"ok": True, "node": node, "version": out}


# What the driver child inherits from Hermes: what Node and the OS need to run, and nothing else. Hermes's own
# variables (HERMES_*) and every other provider's keys stay out of a process that only talks to SLOPCANNON.
_ENV_KEEP = {"PATH", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME",
             "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TZ"}


def _driver_env(token: str) -> dict[str, str]:
    """The driver's environment: the allowlist above, the user's own SLOPCANNON_* settings, and the session the
    plugin minted for this production (never a token inherited from Hermes's environment)."""
    env = {key: value for key, value in os.environ.items()
           if key.upper() in _ENV_KEEP
           or (key.upper().startswith("SLOPCANNON_") and key.upper() != settings.TOKEN_ENV.upper())}
    env[settings.TOKEN_ENV] = token
    env["SLOPCANNON_AGENT_ORIGIN"] = settings.api_origin()
    return env


# --------------------------------------------------------------------------- production file


# The driver knows two picture kinds. A set, place or object is a "product" (uploaded as a set picture); the
# words people and agents naturally use for either are accepted and written as the driver's own.
_KIND_ALIASES = {
    "character": "character", "person": "character", "people": "character", "cast": "character",
    "product": "product", "set": "product", "place": "product", "location": "product", "scene": "product",
    "setting": "product", "environment": "product", "background": "product", "object": "product",
    "prop": "product", "item": "product", "set_reference": "product", "character_reference": "character",
}


def _reference_kind(raw: Any) -> Optional[str]:
    return _KIND_ALIASES.get(str(raw).strip().lower().replace("-", "_").replace(" ", "_"))


def check_production(production: dict[str, Any], timed_plan: Optional[dict[str, Any]] = None) -> list[str]:
    """Every problem a production would hit, found before anything is signed, uploaded or bought."""
    problems = _check_inputs({**production, "_timedPlan": timed_plan})
    names = {str(r.get("name")).strip().upper() for r in production.get("references") or [] if isinstance(r, dict)}
    for i, scene in enumerate((timed_plan or {}).get("scenes") or []):
        for name in (scene.get("cast") or []) if isinstance(scene, dict) else []:
            if str(name).strip().upper() not in names:
                problems.append(f"timed_plan scene {i + 1} casts {name!r}, which is not one of references' names")
    return problems


def _check_inputs(production: dict[str, Any]) -> list[str]:
    problems = []
    if not isinstance(production.get("title"), str) or not production["title"].strip():
        problems.append("title is required")
    song = production.get("song")
    if not isinstance(song, str) or not Path(song).expanduser().is_file():
        problems.append(f"song must be an existing local audio file path (got {song!r})")
    for i, ref in enumerate(production.get("references") or []):
        if not isinstance(ref, dict) or not ref.get("name"):
            problems.append(f"references[{i}] needs a name")
        elif ref.get("path") and not Path(str(ref["path"])).expanduser().is_file():
            problems.append(f"references[{i}].path does not exist: {ref['path']}")
        elif not ref.get("path") and not (ref.get("character") or ref.get("characterId")):
            problems.append(f"references[{i}] needs a path or a Character Lab character")
        if isinstance(ref, dict) and ref.get("kind") not in (None, "") and _reference_kind(ref["kind"]) is None:
            problems.append(f"references[{i}].kind {ref['kind']!r} is not a picture kind: use \"character\" for a "
                            "person or creature, or \"product\" for a set, place or object")
    for key in ("transcript", "bible"):
        value = production.get(key)
        if value is not None and not Path(str(value)).expanduser().is_file():
            problems.append(f"{key} must be an existing local file path (got {value!r})")
    if not production.get("transcript") and not production.get("_timedPlan"):
        problems.append("give either transcript (word-timed JSON, e.g. from song analysis) or timed_plan")
    return problems


def write_production(production_id: str, production: dict[str, Any],
                     timed_plan: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    folder = _dir(production_id)
    ledger = _read_json(folder / "ledger.json") or {}
    clean = {k: v for k, v in production.items() if k not in _GATE_KEYS}
    for key in ("song", "transcript", "bible"):
        if isinstance(clean.get(key), str):
            clean[key] = str(Path(clean[key]).expanduser().resolve())
    refs = []
    for ref in clean.get("references") or []:
        ref = dict(ref)
        if ref.get("path"):
            ref["path"] = str(Path(str(ref["path"])).expanduser().resolve())
        if ref.get("kind") not in (None, ""):
            ref["kind"] = _reference_kind(ref["kind"]) or ref["kind"]
        refs.append(ref)
    clean["references"] = refs
    clean["origin"] = settings.api_origin()
    clean["workDir"] = "./work"
    clean.setdefault("aspectRatio", "16:9")
    problems = _check_inputs({**clean, "_timedPlan": timed_plan or _read_json(folder / "work" / "timed-plan.json")})
    if problems:
        raise ProductionError("; ".join(problems), "invalid_production")
    previous = _read_json(folder / "production.json")
    if previous is not None and previous != clean and ledger.get("productionFingerprint"):
        raise ProductionError(
            "This production already has paid state and its inputs changed. Start a new production_id for the "
            "revision; the original stays recoverable.", "new_revision")
    _write_json(folder / "production.json", clean)
    if timed_plan is not None:
        _write_json(folder / "work" / "timed-plan.json", timed_plan)
    with _state_lock(production_id):
        state = _read_state(production_id) or {  # an unreadable state file raises: its decisions are never reset
            "id": production_id, "createdAt": int(time.time() * 1000), "state": "idle", "needs": None,
            "decisions": {}, "runs": [], "log": [],
        }
        state["title"] = clean["title"]
        state["aspectRatio"] = clean.get("aspectRatio")
        _save_state(production_id, state)
    return state


# --------------------------------------------------------------------------- takes


_TAKE_ID = re.compile(r"^sc(\d+)(?:\.r(\d+))?$")


def scene_order(scene_id: str) -> tuple[int, int, int, str]:
    """Sort key for scene and take ids by their numbers: sc02 < sc11 < sc100, sc09 < sc09.r2 < sc09.r10."""
    match = _TAKE_ID.match(scene_id or "")
    if not match:
        return (1, 0, 0, str(scene_id))
    return (0, int(match.group(1)), int(match.group(2) or 0), scene_id)


def chosen_takes(decisions: dict[str, Any]) -> dict[str, str]:
    """The take the person chose for each rerolled scene ({root: take}). ``decisions['takes']`` is the record;
    a reroll's own ``take`` is read too, for productions recorded before that map existed."""
    out = {str(scene): str(ask["take"]) for scene, ask in (decisions.get("rerolls") or {}).items()
           if isinstance(ask, dict) and ask.get("take")}
    out.update({str(k): str(v) for k, v in (decisions.get("takes") or {}).items() if v})
    return out


def current_take(ledger: dict[str, Any], state: Optional[dict[str, Any]], root: str) -> str:
    """The take of scene ``root`` the film uses now (``sc09``, ``sc09.r1``, ...): the take the person chose, else
    the newest delivered reroll of it (by reroll number), else the scene's first take. Every view of a scene (the
    studio's rows, its frames, a reroll's derived direction) reads its take from here."""
    scenes = ledger.get("scenes")
    if not isinstance(scenes, dict):
        scenes = {}
    chosen = chosen_takes((state or {}).get("decisions") or {}).get(root)
    if chosen and (chosen == root or (scenes.get(chosen) or {}).get("rerollOf") == root):
        return chosen
    delivered = [take for take, entry in scenes.items()
                 if isinstance(entry, dict) and entry.get("rerollOf") == root
                 and (entry.get("generation") or {}).get("status") == "succeeded"]
    return max(delivered, key=scene_order) if delivered else root


# --------------------------------------------------------------------------- decisions (from the person only)


def record_decisions(production_id: str, decisions: dict[str, Any]) -> dict[str, Any]:
    """Record answers the person gave (the film card's click, or Hermes's approval prompt via ``gate.py``)."""
    with _editing(production_id) as state:
        current = state.setdefault("decisions", {})
        for key in ("rights_version", "approved_credits", "review_first", "accept_checks"):
            if decisions.get(key) not in (None, "", []):
                current[key] = decisions[key]
        # chain continuity: every take the person kept, by its bytes (a later reroll of a scene is a new take to keep)
        kept = decisions.get("reviewed")
        kept = [kept] if isinstance(kept, str) else kept if isinstance(kept, list) else []
        if kept:
            current["reviewed"] = sorted(set(current.get("reviewed") or []) | {str(k) for k in kept if k})
        rerolls = current.setdefault("rerolls", {})
        for asked in _reroll_list(decisions.get("reroll")):
            # A new take of a delivered scene: quoted first, bought only on the person's approve_reroll. The take the
            # film uses now stays in decisions['takes'] until the new one is delivered.
            direction = str(asked.get("direction") or "").strip() or None
            earlier = rerolls.get(str(asked["scene"])) or {}
            if earlier.get("approved"):  # a scene rerolled again: its earlier take's spend still counts
                current["reroll_credits_before"] = (int(current.get("reroll_credits_before") or 0)
                                                    + int(earlier["approved"]))
            rerolls[str(asked["scene"])] = {"direction": direction, "quote": None, "approved": None,
                                            "submitted": False, "take": None}
        approved = decisions.get("approve_reroll")
        if isinstance(approved, int) and not isinstance(approved, bool):
            waiting = {k: r for k, r in rerolls.items() if r.get("quote") and r.get("approved") is None}
            quoted = sum(int(r["quote"]["amountUnits"]) for r in waiting.values())
            if state.get("needs") != "reroll_approval" or not waiting:
                raise ProductionError("the production is not waiting on a reroll approval; nothing was approved",
                                      "stale_decision")
            if approved != quoted:
                raise ProductionError(f"the new takes' quote is {quoted} Cannon Credits, not {approved}; nothing "
                                      "was approved", "stale_decision")
            for r in waiting.values():
                r["approved"] = int(r["quote"]["amountUnits"])
                r["carried"] = 0  # a fresh approval: it may carry over to one re-quote of this take
        if not rerolls:
            current.pop("rerolls", None)
    return current


# --------------------------------------------------------------------------- decisions from the film card

# The gates a person answers. On Hermes desktop the film card answers them (decide); elsewhere the agent passes the
# answer to slopcannon_produce and Hermes asks in an approval prompt.
DECISION_GATES = ("rights", "approval", "budget", "first_scene_review", "scene_review", "shot_review", "reroll_approval")


def _derived_direction(production_id: str, scene: str) -> str:
    """A reroll's direction when the person asked from the card: fix what the character check found on the take
    the film uses now (after an earlier reroll, that take's check, not the first take's)."""
    ledger = _read_json(_dir(production_id) / "ledger.json") or {}
    take = current_take(ledger, load_state(production_id), scene)
    entry = (ledger.get("scenes") or {}).get(take) or {}
    issues = [str(i.get("description") or "").strip() for i in (entry.get("shotCheck") or {}).get("issues") or []
              if isinstance(i, dict)]
    issues = [i for i in issues if i]
    base = "Keep every character exactly as its reference picture for the whole shot."
    return base + (" Fix what the check found: " + " ".join(issues) if issues else "")


def decide(production_id: str, answer: dict[str, Any]) -> dict[str, Any]:
    """Record the person's answer from the film card and resume the production.

    The card is the person's own click, so it is the sign-off, the spend approval or the keep-or-reroll choice.
    Every answer must match the gate the production is stopped at (the exact quoted figure, the exact rights
    version, the exact first-scene file), so a stale card can never approve something else; the seat's
    max_credits_per_action ceiling still applies."""
    state = _read_state(production_id)
    if state is None:
        raise ProductionError(f"no production {production_id}", "unknown_production")
    if state.get("state") == "running" or is_running(production_id):
        raise ProductionError("the production is already running", "busy")
    gate, needs = str(answer.get("gate") or ""), state.get("needs")
    detail = state.get("needsDetail") or {}
    decisions: dict[str, Any] = {}
    said = ""

    def credits(expected: Any, what: str) -> int:
        given = answer.get("credits")
        if not isinstance(given, int) or isinstance(given, bool) or given != expected:
            raise ProductionError(f"the card is out of date: {what} is {expected} Cannon Credits", "stale_decision")
        ceiling = settings.get_int("max_credits_per_action")
        if ceiling and given > ceiling:
            raise ProductionError(f"{given} Cannon Credits exceeds this seat's ceiling of {ceiling} "
                                  "(plugins.entries.slopcannon.settings.max_credits_per_action)", "over_ceiling")
        return given

    if gate in DECISION_GATES and gate != needs:
        raise ProductionError(f"the production is no longer waiting on {gate}", "stale_decision")
    if gate == "rights":
        version = detail.get("requiredVersion")
        if not version or answer.get("version") != version:
            raise ProductionError("the rights statement changed; read the new one", "stale_decision")
        decisions["rights_version"], said = version, f"signed the rights statement {version}"
    elif gate == "approval":
        decisions["approved_credits"] = credits(detail.get("totalCannonCredits"), "the quote")
        said = f"approved {decisions['approved_credits']:,} Cannon Credits"
    elif gate == "budget":
        decisions["approved_credits"] = credits(detail.get("exposureCredits"), "the ceiling needed")
        said = f"raised the ceiling to {decisions['approved_credits']:,} Cannon Credits"
    elif gate == "first_scene_review":
        if not detail.get("sha256") or answer.get("sha256") != detail.get("sha256"):
            raise ProductionError("the first scene changed; watch the new take", "stale_decision")
        decisions["review_first"] = detail["sha256"]
        said = f"approved the first scene {detail.get('scene') or ''}".strip()
    elif gate == "scene_review":  # chain continuity: keep this take; the next scene starts from its last frame
        if not detail.get("sha256") or answer.get("sha256") != detail.get("sha256"):
            raise ProductionError("the scene changed; watch the new take", "stale_decision")
        decisions["reviewed"] = [detail["sha256"]]
        said = f"kept {detail.get('take') or detail.get('scene') or 'the scene'}"
    elif gate in ("shot_review", "reroll"):
        if gate == "reroll" and needs in DECISION_GATES and needs not in ("shot_review", "scene_review"):
            raise ProductionError(f"answer the production's current step ({needs}) first", "stale_decision")
        flagged = {str(f.get("scene")) for f in detail.get("flagged") or [] if isinstance(f, dict)}
        keep = [str(x) for x in answer.get("keep") or [] if str(x) in flagged]
        asked = [str(x.get("scene") if isinstance(x, dict) else x) for x in answer.get("reroll") or []]
        if gate == "shot_review" and not flagged <= set(keep) | set(asked):
            raise ProductionError("choose keep or reroll for every flagged scene", "incomplete_decision")
        if gate == "reroll" and not asked:
            raise ProductionError("name the scenes to reroll", "incomplete_decision")
        for scene in asked:
            problem = reroll_problem(production_id, scene)
            if problem:
                raise ProductionError(f"cannot reroll {scene}: {problem}", "reroll_unavailable")
        before = (state.get("decisions") or {}).get("accept_checks")
        kept = before if before == "all" else sorted(set(before or []) | set(keep))
        if kept:
            decisions["accept_checks"] = kept
        given = {str(x.get("scene")): str(x.get("direction") or "").strip() for x in answer.get("reroll") or []
                 if isinstance(x, dict) and x.get("direction")}
        decisions["reroll"] = [{"scene": s, "direction": given.get(s) or _derived_direction(production_id, s)}
                               for s in asked]
        said = "; ".join(x for x in (f"kept {', '.join(keep)}" if keep else "",
                                     f"asked for new takes of {', '.join(asked)}" if asked else "") if x)
    elif gate == "reroll_approval":
        if answer.get("cancel"):
            # Only the takes still waiting for approval are dropped; the takes the film uses (decisions['takes'])
            # stay as they are, so cancelling a second reroll keeps the first one in the cut.
            with _editing(production_id) as fresh:
                current = fresh.setdefault("decisions", {})
                rerolls = current.get("rerolls") or {}
                dropped = sorted(k for k, r in rerolls.items() if r.get("approved") is None and not r.get("take"))
                for k in dropped:
                    rerolls.pop(k, None)
                if current.get("accept_checks") != "all":
                    current["accept_checks"] = sorted(set(current.get("accept_checks") or []) | set(dropped))
                if not rerolls:
                    current.pop("rerolls", None)
            said = f"kept the current takes of {', '.join(dropped)}"
        else:
            decisions["approve_reroll"] = credits(detail.get("amountUnits"), "the new takes' quote")
            said = (f"approved {decisions['approve_reroll']:,} Cannon Credits for new takes of "
                    f"{', '.join(str(x) for x in detail.get('scenes') or [])}")
    elif gate == "recheck":  # takes the check could not reach: checked again, nothing decided or bought
        if needs != "shot_review":
            raise ProductionError("there are no takes waiting for a check", "stale_decision")
        said = "asked the character check to run again"
    elif gate == "resume":
        if needs in DECISION_GATES:
            raise ProductionError(f"the production is waiting on {needs}", "stale_decision")
        said = "resumed the production"
    else:
        raise ProductionError(f"unknown decision {gate!r}", "bad_decision")
    if any(v not in (None, "", []) for v in decisions.values()):
        record_decisions(production_id, decisions)
    with _editing(production_id) as fresh:
        fresh["log"] = (fresh.get("log") or [])[-_LOG_LINES:] + [f"on the film card the person {said}"]
    start(production_id, concurrency=CONCURRENCY)
    return summary(production_id, detail=True)


def _reroll_list(raw: Any) -> list[dict[str, Any]]:
    """reroll as one {scene, direction} or a list of them."""
    items = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
    return [i for i in items if isinstance(i, dict) and i.get("scene")]


def reroll_problem(production_id: str, scene: Any) -> Optional[str]:
    """Why a reroll of this scene cannot be asked for now, or None when it can."""
    state = load_state(production_id) or {}
    if state.get("state") == "running" or is_running(production_id):
        return "the production is still running; wait for it to stop at a gate or finish"
    if state.get("needs") in ("rights", "approval", "budget", "first_scene_review"):
        return "a scene can be rerolled once the film's takes are delivered; answer the production's current gate first"
    entry = ((_read_json(_dir(production_id) / "ledger.json") or {}).get("scenes") or {}).get(str(scene))
    if not isinstance(entry, dict) or str(scene) == "production" or entry.get("rerollOf"):
        return f"{scene} is not one of this film's scenes (use the scene id, such as sc03)"
    if (entry.get("generation") or {}).get("status") != "succeeded":
        return f"{scene} has no delivered take to replace"
    return None


def _film_title(folder: Path) -> str:
    return str((_read_json(folder / "production.json") or {}).get("title") or folder.name)


def remember_session(production_id: str, session_id: str) -> None:
    with _state_lock(production_id):
        state = _read_state(production_id)
        if state is not None and state.get("sessionId") != session_id:
            state["sessionId"] = session_id
            _save_state(production_id, state)


def _chain(folder: Path) -> bool:
    return (_read_json(folder / "production.json") or {}).get("continuity") == "chain"


def _reroll_args(folder: Path, scene: str, ask: dict[str, Any]) -> list[str]:
    # A chained scene is rerolled from what it was bought from: its plan and cast with the frame it continues from.
    plans = folder / "work" / "scene-audio" / "scene-plans"
    chained = (plans / f"{scene}.chain.json").is_file() and (plans / f"{scene}.chain-cast.json").is_file()
    args = ["reroll", "--ledger", str(folder / "ledger.json"), "--scene", scene,
            "--plan", str(plans / (f"{scene}.chain.json" if chained else f"{scene}.json")),
            "--cast", str(plans / f"{scene}.chain-cast.json") if chained else str(folder / "work" / "cast.json")]
    if ask.get("direction"):
        args += ["--direction", str(ask["direction"])]
    return args


def _driver_args(folder: Path, decisions: dict[str, Any], concurrency: int) -> list[str]:
    """The next driver call. Rerolls go in stages so several render at once: every asked scene is quoted, the
    person approves them together (an empty list here: the runner stops at that gate), every approved one is
    submitted without waiting, then each is collected; finally the film is cut with the new takes."""
    ledger = str(folder / "ledger.json")
    checks = decisions.get("accept_checks")
    rerolls = decisions.get("rerolls") or {}
    # A reroll counts toward the film's ceiling, so the approved takes raise it by exactly their quotes.
    ceiling = (int(decisions.get("approved_credits") or 0) + int(decisions.get("reroll_credits_before") or 0)
               + sum(int(r.get("approved") or 0) for r in rerolls.values()))
    for scene, ask in rerolls.items():
        if not ask.get("take") and ask.get("approved") is None and not ask.get("quote"):
            return _reroll_args(folder, scene, ask)
    if any(not r.get("take") and r.get("approved") is None for r in rerolls.values()):
        return []
    for scene, ask in rerolls.items():
        if not ask.get("take") and not ask.get("submitted"):
            return _reroll_args(folder, scene, ask) + ["--approve-units", str(ask["approved"]),
                                                       "--max-credits", str(ceiling), "--wait", "no"]
    for scene, ask in rerolls.items():
        if not ask.get("take"):
            return _reroll_args(folder, scene, ask) + ["--approve-units", str(ask["approved"]),
                                                       "--max-credits", str(ceiling)]
    # the takes the person chose, from their own record: cancelling a later reroll never drops an earlier take
    chosen = chosen_takes(decisions)
    pairs = ",".join(f"{scene}={chosen[scene]}" for scene in sorted(chosen, key=scene_order))
    chain = _chain(folder)
    if chosen and not chain:
        title = _film_title(folder)
        args = ["cut", "--ledger", ledger, "--plan", str(folder / "work" / "timed-plan.json"), "--takes", pairs,
                "--title", title, "--output", str(folder / "work" / f"{re.sub(r'[^A-Za-z0-9._-]+', '-', title)}.mp4")]
        if checks:
            args += ["--accept-checks", "all" if checks == "all" else ",".join(checks)]
        return args
    args = ["run", "--production", str(folder / "production.json"), "--ledger", str(folder / "ledger.json"),
            "--concurrency", str(max(1, min(16, concurrency)))]
    if decisions.get("rights_version"):
        args += ["--rights-accepted", str(decisions["rights_version"])]
    if isinstance(decisions.get("approved_credits"), int):
        # chained, the run itself buys the scenes after a reroll, so the ceiling carries the approved rerolls
        args += ["--approve", "all", "--max-credits", str(ceiling if chain else decisions["approved_credits"])]
    if decisions.get("review_first"):
        args += ["--review-first", str(decisions["review_first"])]
    if chain and decisions.get("reviewed"):
        args += ["--reviewed", ",".join(decisions["reviewed"])]
    if chain and chosen:
        args += ["--takes", pairs]
    checks = decisions.get("accept_checks")
    if checks:
        args += ["--accept-checks", "all" if checks == "all" else ",".join(checks)]
    return args


# --------------------------------------------------------------------------- the runner


class _Runner(threading.Thread):
    def __init__(self, production_id: str, concurrency: int):
        super().__init__(name=f"slopcannon-production-{production_id}", daemon=True)
        self.production_id = production_id
        self.concurrency = concurrency
        self.proc: Optional[subprocess.Popen] = None
        self.stopped = False
        self._proc_lock = threading.Lock()  # between starting a driver call and stop()
        self.done = threading.Event()
        # Hermes keeps the served profile (its home, secrets and the plugin's sign-in) in context
        # variables, and a new thread starts with none of them: without this copy a run started from a
        # chat in a second profile writes its state into the primary profile's folder and Hermes refuses
        # the sign-in. Taken here, on the tool call's own thread. (Not ``_context``: Python 3.14's Thread
        # keeps its own context under that name and enters it before ``run``.)
        self._caller_context = contextvars.copy_context()

    def run(self) -> None:
        self._caller_context.run(self._run)

    def _run(self) -> None:
        pid = self.production_id
        folder = _dir(pid)
        ended = False  # finished, failed or stopped: the driver's session is no longer needed
        try:
            node = node_status()
            if not node["ok"]:
                raise ProductionError(node["message"], "node_missing")
            try:
                # Its own twelve-hour session, so a long run never outlives the in-process one.
                token = auth.driver_token(pid).token
            except auth.NotSignedIn as exc:
                raise ProductionError(str(exc), "not_connected") from None
            except auth.CredentialError as exc:
                raise ProductionError(str(exc), exc.code) from None
            env = _driver_env(token)
            code, result, stdout, stderr = 0, {}, "", ""
            while not self.stopped:  # a Stop between two driver calls launches nothing new
                decisions = (_read_state(pid) or {}).get("decisions") or {}
                verb_args = _driver_args(folder, decisions, self.concurrency)
                if not verb_args:  # every asked reroll is quoted: one approval covers them all
                    quotes = [{"scene": k, **r["quote"]} for k, r in (decisions.get("rerolls") or {}).items()
                              if r.get("quote") and r.get("approved") is None and not r.get("take")]
                    code, stdout, stderr = 2, "", ""
                    result = {"ok": False, "needs": "reroll_approval", "quotes": quotes,
                              "message": "New takes quoted; waiting for the person's approval."}
                    break
                called = self._call([node["node"], str(DRIVER), *verb_args], env)
                if called is None:  # stopped just before the driver started
                    break
                code, result, stdout, stderr = called
                with _editing(pid) as state:
                    state["runs"][-1].update(endedAt=int(time.time() * 1000), exitCode=code)
                    state["log"] = (state.get("log") or [])[-_LOG_LINES:] + _log_lines(result, stderr)
                    goes_on = (verb_args[0] == "reroll" and not self.stopped
                               and _record_reroll(state, verb_args[verb_args.index("--scene") + 1], code, result))
                if not goes_on:  # the next reroll, or the cut with the new takes, comes from the loop's next call
                    break
            with _editing(pid) as state:
                if self.stopped:
                    state.update(state="idle", needs=None, message="Stopped. Paid work already accepted keeps "
                                 "running on the server; continuing the production recovers it without paying again.")
                elif code == 0 and result.get("ok"):
                    output = result.get("output") or (result.get("report") or {}).get("output")
                    state.update(state="done", needs=None, message=result.get("message"),
                                 master=({"path": output, "name": Path(output).name} if output else None),
                                 report=_compact_report(result.get("report")))
                elif code == 2 and result.get("needs"):
                    state.update(state="needs", needs=result["needs"], message=result.get("message"),
                                 needsDetail=_needs_detail(result))
                else:
                    silent = not result and not stdout.strip() and not stderr.strip()
                    state.update(state="error", needs=None,
                                 message=str(result.get("error") or result.get("advice") or stderr.strip()[-600:]
                                             or (f"the driver exited {code} without a result: {DRIVER}" if silent
                                                 else f"driver exited {code}")))
                ended = state["state"] != "needs"
        except ProductionError as exc:
            ended = True
            self._fail(str(exc), exc.code)
        except Exception as exc:  # never leave a production stuck in "running"
            ended = True
            self._fail(f"{type(exc).__name__}: {exc}", None)
        finally:
            (folder / "heartbeat").unlink(missing_ok=True)
            if ended or self.stopped:
                _forget_driver(pid)
            self.done.set()
            with _runners_lock:
                if _runners.get(pid) is self:
                    _runners.pop(pid, None)

    def _fail(self, message: str, code: Optional[str]) -> None:
        """Record a failed run. A state file that cannot be read is left exactly as it is."""
        try:
            with _editing(self.production_id) as state:
                state.update(state="error", needs=None, message=message)
                if code:
                    state["errorCode"] = code
                else:
                    state.pop("errorCode", None)
        except ProductionError:
            pass

    def _call(self, args: list[str], env: dict[str, str]) -> Optional[tuple[int, dict[str, Any], str, str]]:
        """Run one driver call to its end; None when the production was stopped before it started."""
        if self.stopped:
            return None
        with _editing(self.production_id) as state:
            state.update(state="running", needs=None, message=None)
            state.pop("errorCode", None)  # a resumed production no longer carries the last run's failure
            state.setdefault("runs", []).append({"startedAt": int(time.time() * 1000), "verb": args[2]})
        with self._proc_lock:  # stop() either sees this child and ends it, or this sees the stop and starts none
            if self.stopped:
                return None
            proc = self.proc = subprocess.Popen(
                args, cwd=str(_dir(self.production_id)), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace")
        watcher = threading.Thread(target=contextvars.copy_context().run, args=(self._watch_ledger,), daemon=True)
        watcher.start()
        stdout, stderr = proc.communicate()
        return proc.returncode, _last_json(stdout) or _last_json(stderr) or {}, stdout, stderr

    def _watch_ledger(self) -> None:
        folder = _dir(self.production_id)
        ledger, beat, stop_file = folder / "ledger.json", folder / "heartbeat", folder / "stop.request"
        seen = 0.0
        while self.proc is not None and self.proc.poll() is None:
            beat.write_text(str(int(time.time())), encoding="utf-8")
            if stop_file.exists():
                stop_file.unlink(missing_ok=True)
                self.stop()
            try:
                mtime = ledger.stat().st_mtime
            except OSError:
                mtime = 0.0
            if mtime != seen:
                seen = mtime
                _broadcast("production.updated", {"id": self.production_id, "state": "running", "needs": None})
            time.sleep(_HEARTBEAT_S)

    def stop(self) -> None:
        """Stop the run: no further driver call starts, and a driver running now is ended.

        A terminated driver never reaches the ``finally`` that removes its ledger lock (on Windows terminate is
        immediate; elsewhere Node exits on SIGTERM without unwinding), so once it has exited its lock is removed
        here, and only when the lock names that very process."""
        with self._proc_lock:
            self.stopped = True
            proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=_STOP_WAIT_S)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=_STOP_WAIT_S)
            except subprocess.TimeoutExpired:
                return  # still alive: its lock is still its own
        _release_driver_lock(_dir(self.production_id) / "ledger.json", proc.pid)


def _record_reroll(state: dict[str, Any], scene: str, code: int, result: dict[str, Any]) -> bool:
    """Fold one reroll call's answer into the production's record; True when the runner should go on."""
    decisions = state.setdefault("decisions", {})
    ask = (decisions.get("rerolls") or {}).get(scene)
    if not isinstance(ask, dict):
        return False
    if code == 2 and result.get("needs") == "approval":  # quoted (or quoted again: the quote expired)
        _record_quote(state, ask, result)
        return True
    if code == 0 and result.get("ok") and result.get("submitted"):
        ask["submitted"] = True
        state["log"].append(f"reroll {result.get('rerollOf')} submitted as {result.get('scene')}")
        return True
    if code == 0 and result.get("ok"):
        ask["take"] = result.get("scene")
        ask["check"] = (result.get("check") or {}).get("verdict")
        decisions.setdefault("takes", {})[scene] = result.get("scene")  # the film uses the new take from now on
        state["log"].append(f"reroll {result.get('rerollOf')} -> {result.get('scene')}")
        return True
    return False


def _record_quote(state: dict[str, Any], ask: dict[str, Any], result: dict[str, Any]) -> None:
    """A reroll's quote, or a new quote after the approved one expired before it was bought.

    The person's approval carries over to the new quote only when it is for the very take they approved, that take
    was never sent, the price is no higher, and the approval has not carried over before. Anything else (another
    take, which the driver opens when the approved one failed or was already sent) is asked again, so approving one
    take can never buy two."""
    decisions = state["decisions"]
    held, units, take = ask.get("approved"), result.get("amountUnits"), result.get("scene")
    carried = int(ask.get("carried") or 0)
    keep = (isinstance(held, int) and isinstance(units, int) and units <= held
            and take == (ask.get("quote") or {}).get("take") and not ask.get("submitted")
            and carried < _MAX_CARRIED_QUOTES)
    if isinstance(held, int) and ask.get("submitted") and not keep:
        # the approved take was sent and its spend stands; the new take is a separate purchase
        decisions["reroll_credits_before"] = int(decisions.get("reroll_credits_before") or 0) + held
    ask.update(quote={"take": take, "amountUnits": units, "quoteId": result.get("quoteId"),
                      "expiresAt": result.get("expiresAt")},
               approved=units if keep else None, submitted=False, carried=carried + 1 if keep else 0)
    if keep:
        state["log"].append(f"the quote for {take} expired; quoted again at {units}, within the approved {held}")


def _release_driver_lock(ledger: Path, pid: int) -> bool:
    """Remove ``<ledger>.lock`` when it names process ``pid`` (the driver writes ``{"pid", "startedAt"}`` there).
    A lock held by any other command, or one that cannot be read, is left alone."""
    lock = Path(f"{ledger}.lock")
    try:
        held = json.loads(lock.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(held, dict) or held.get("pid") != pid:
        return False
    try:
        lock.unlink()
    except OSError:
        return False
    return True


def _forget_driver(production_id: str) -> None:
    """Drop the driver session minted for this production, where the installed auth module can."""
    forget = getattr(auth, "forget_driver", None)
    if callable(forget):
        try:
            forget(production_id)
        except Exception:
            pass


def _stop_children_at_exit() -> None:
    """Hermes is exiting: end every driver this process started, so none outlives it holding its session and the
    ledger lock. The runners are daemon threads and would otherwise just vanish mid-call."""
    with _runners_lock:
        runners = list(_runners.values())
    for runner in runners:
        try:
            runner.stop()
        except Exception:
            pass
        _forget_driver(runner.production_id)


atexit.register(_stop_children_at_exit)


def _last_json(text: str) -> Optional[dict[str, Any]]:
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return None


def _log_lines(result: dict[str, Any], stderr: str) -> list[str]:
    lines = []
    for step in result.get("steps") or []:
        if isinstance(step, dict):
            label = step.get("step", "?")
            extra = {k: v for k, v in step.items() if k in ("sceneCount", "count", "ready", "ok", "server")}
            lines.append(f"{label} {json.dumps(extra, separators=(',', ':'))}" if extra else str(label))
    if result.get("needs"):
        lines.append(f"stopped at gate: {result['needs']}")
    if result.get("error"):
        lines.append(f"error: {result['error']}")
    return lines[-_LOG_LINES:]


def _compact_report(report: Any) -> Optional[dict[str, Any]]:
    if not isinstance(report, dict):
        return None
    keep = ("ok", "output", "assemblyId", "syncVerified", "bytes", "sha256", "durationMs", "engine")
    return {k: report.get(k) for k in keep if k in report}


def _needs_detail(result: dict[str, Any]) -> dict[str, Any]:
    needs = result.get("needs")
    if needs == "rights":
        return {
            "requiredVersion": result.get("requiredVersion"), "statement": result.get("statement"),
            "termsUrl": result.get("termsUrl"), "acceptableUseUrl": result.get("acceptableUseUrl"),
            "files": [{"name": Path(str(f.get("file") or f.get("path") or f.get("name") or "")).name,
                       "bytes": f.get("bytes"), "role": f.get("role")}
                      for f in result.get("files") or [] if isinstance(f, dict)],
        }
    if needs == "approval":
        return {"quotes": [{"scene": q.get("scene"), "amountUnits": q.get("amountUnits")}
                           for q in result.get("quotes") or [] if isinstance(q, dict)],
                "totalCannonCredits": result.get("totalCannonCredits")}
    if needs == "budget":
        return {k: result.get(k) for k in ("limitCredits", "committedCredits", "pendingCredits", "exposureCredits")}
    if needs == "first_scene_review":
        artifact = result.get("artifact") or {}
        path = artifact.get("path")
        return {"scene": result.get("scene"), "sha256": result.get("sha256"),
                "clip": {"path": path, "name": Path(path).name} if path else None,
                "shotCheck": result.get("shotCheck"), "directionWarnings": result.get("directionWarnings")}
    if needs == "scene_review":
        artifact = result.get("artifact") or {}
        path = artifact.get("path")
        return {"scene": result.get("scene"), "take": result.get("take"), "index": result.get("index"),
                "total": result.get("total"), "next": result.get("next"), "continuesFrom": result.get("continuesFrom"),
                "sha256": result.get("sha256"), "clip": {"path": path, "name": Path(path).name} if path else None,
                "shotCheck": result.get("shotCheck")}
    if needs == "reroll_approval":
        quotes = [q for q in result.get("quotes") or [] if isinstance(q, dict)]
        return {"scenes": [q.get("scene") for q in quotes], "quotes": quotes,
                "amountUnits": sum(int(q.get("amountUnits") or 0) for q in quotes),
                "quoteIds": [q.get("quoteId") for q in quotes]}
    if needs == "shot_review":
        return {"flagged": [{"scene": f.get("scene"), "take": f.get("take"), "verdict": f.get("verdict"),
                             "issues": f.get("issues") or []}
                            for f in result.get("flagged") or [] if isinstance(f, dict)],
                "unchecked": [{"scene": u.get("scene"), "retryable": u.get("retryable")}
                              for u in result.get("unchecked") or [] if isinstance(u, dict)]}
    if needs == "review":
        return {"failed": result.get("failed") or []}
    return {}


# --------------------------------------------------------------------------- public operations


def start(production_id: str, *, concurrency: int = CONCURRENCY) -> dict[str, Any]:
    if _read_state(production_id) is None:
        raise ProductionError(f"no production {production_id}", "unknown_production")
    with _runners_lock:
        existing = _runners.get(production_id)
        if existing is not None and existing.is_alive():
            return summary(production_id)
        if is_running(production_id):  # driven by another Hermes process on this machine
            return summary(production_id)
        (_dir(production_id) / "stop.request").unlink(missing_ok=True)
        with _editing(production_id) as state:
            state.update(state="running", needs=None, message=None)
            state.pop("errorCode", None)  # a resumed production no longer carries the last run's failure
        runner = _Runner(production_id, concurrency)
        _runners[production_id] = runner
        runner.start()
    return summary(production_id)


def wait(production_id: str, timeout_s: float) -> dict[str, Any]:
    """Block until the run reaches a gate, finishes or fails, or ``timeout_s`` passes."""
    deadline = time.monotonic() + max(0.0, timeout_s)
    time.sleep(0.2)  # let a just-started runner claim its state
    while time.monotonic() < deadline:
        runner = _runners.get(production_id)
        if runner is not None and runner.is_alive():
            runner.done.wait(min(5.0, max(0.0, deadline - time.monotonic())))
        elif not is_running(production_id):
            break
        else:
            time.sleep(min(5.0, max(0.0, deadline - time.monotonic())))
        if (load_state(production_id) or {}).get("state") != "running":
            break
    return summary(production_id)


def stop(production_id: str) -> bool:
    """Stop a run, in this process or (through a request file) in another one."""
    runner = _runners.get(production_id)
    if runner is not None and runner.is_alive():
        runner.stop()
        return True
    if is_running(production_id):
        (_dir(production_id) / "stop.request").write_text("stop", encoding="utf-8")
        return True
    return False


def is_running(production_id: str) -> bool:
    runner = _runners.get(production_id)
    if runner is not None and runner.is_alive():
        return True
    try:
        age = time.time() - (_dir(production_id) / "heartbeat").stat().st_mtime
    except OSError:
        return False
    return age < _STALE_S


def _scenes(folder: Path, state: dict[str, Any]) -> list[dict[str, Any]]:
    ledger = _read_json(folder / "ledger.json") or {}
    plan = _read_json(folder / "work" / "timed-plan.json") or {}
    raw_scenes = plan.get("scenes")
    plan_scenes: list[Any] = raw_scenes if isinstance(raw_scenes, list) else []
    entries = {k: v for k, v in (ledger.get("scenes") or {}).items() if k.startswith("sc") and isinstance(v, dict)}
    # A reroll is a newer take of its scene, not a scene of its own. The row shows a reroll while it is in flight
    # (quoted, rendering), and otherwise the take the film uses (current_take), so a replaced scene never still
    # reads as flagged and a cancelled or failed reroll never stands in for the take that is kept.
    roots = {k for k in entries if not entries[k].get("rerollOf")} | {f"sc{i + 1:02d}" for i in range(len(plan_scenes))}
    asked = (state.get("decisions") or {}).get("rerolls") or {}
    accepted = (state.get("decisions") or {}).get("accept_checks")
    rows = []
    for sid in sorted(roots, key=scene_order):
        ask = asked.get(sid) if isinstance(asked.get(sid), dict) else None
        if ask is not None and not ask.get("take"):
            shown = (ask.get("quote") or {}).get("take")  # None: asked for, not yet quoted
            shown = shown if shown in entries else None
        else:
            shown = current_take(ledger, state, sid)
        entry = entries.get(shown, {}) if shown else {}
        sent = [scene_order(k)[2] for k, v in entries.items()
                if v.get("rerollOf") == sid and (v.get("generation") or {}).get("id")]
        number = scene_order(shown)[2] if shown else max(sent, default=0) + 1  # 0 for the first take
        try:
            index = int(sid[2:]) - 1
        except ValueError:
            index = -1
        planned = plan_scenes[index] if 0 <= index < len(plan_scenes) else {}
        generation = entry.get("generation") or {}
        status = generation.get("status")
        downloaded = entry.get("downloaded") or {}
        if downloaded.get("path"):
            row_status = "succeeded"
        elif status in ("submission_unknown", "billing_unknown", "submitting"):
            row_status = "uncertain"
        elif status in ("queued", "accepted", "reserving_funds"):
            row_status = "queued"
        elif status == "running":
            row_status = "running"
        elif status in ("succeeded", "failed"):
            row_status = status
        elif entry.get("quote"):
            row_status = "quoted"
        else:
            row_status = "unsubmitted"
        rows.append({
            "id": sid, "index": index,
            "startMs": planned.get("startMs"), "endMs": planned.get("endMs"),
            "beat": (planned.get("beat") or "")[:2000] or None,
            "cast": [c for c in planned.get("cast") or [] if isinstance(c, str)][:12],
            "status": row_status,
            "quoteCredits": (entry.get("quote") or {}).get("amountUnits"),
            "generationId": generation.get("id"),
            "clip": {"path": downloaded["path"], "name": Path(downloaded["path"]).name} if downloaded.get("path") else None,
            "check": _check_row(entry),
            "checkAccepted": accepted == "all" or (isinstance(accepted, list) and sid in accepted),
            "take": len([a for a in entry.get("attempts") or [] if isinstance(a, dict)]) + 1 + number,
            "rerolled": ask is not None or any(v.get("rerollOf") == sid for v in entries.values()),
            **_scene_times(entry),
        })
    return rows


def _scene_times(entry: dict[str, Any]) -> dict[str, Any]:
    """When the current take was submitted and when its file arrived (ms), from the driver's scene log."""
    out: dict[str, Any] = {"submittedAt": None, "renderedAt": None}
    for line in entry.get("log") or []:
        if not isinstance(line, dict) or not isinstance(line.get("at"), str):
            continue
        try:
            at = int(datetime.fromisoformat(line["at"].replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            continue
        if line.get("step") == "submit":
            out["submittedAt"], out["renderedAt"] = at, None
        elif line.get("step") == "content":
            out["renderedAt"] = at
    return out


def _check_row(entry: dict[str, Any]) -> dict[str, Any] | None:
    """The scene's character-check verdict, or, when the check could not run on the current take, `unchecked`
    with the driver's reason, so a take nobody judged never reads as passed."""
    check = entry.get("shotCheck")
    if isinstance(check, dict):
        issues = [{**i, "second": i["atSeconds"]} if "second" not in i and "atSeconds" in i else i
                  for i in check.get("issues") or [] if isinstance(i, dict)]
        return {"verdict": check.get("verdict"), "issues": issues}
    error = entry.get("shotCheckError")
    take = (entry.get("artifact") or {}).get("assetId")
    if isinstance(error, dict) and error.get("message") and (not take or error.get("assetId") in (None, take)):
        return {"verdict": "unchecked", "issues": [],
                "error": {"message": str(error["message"])[:300], "code": error.get("code"),
                          "retryable": error.get("retryable") is True}}
    return None


def _assembly(ledger: dict[str, Any]) -> dict[str, Any] | None:
    """The server assembly the driver has submitted, once there is one: the studio's Assembly step reads it."""
    entry = ledger.get("serverAssembly")
    if not isinstance(entry, dict) or not entry.get("id"):
        return None
    receipt = entry.get("trackingReceipt") or {}
    return {"id": entry["id"], "status": entry.get("lastStatus") or receipt.get("state"),
            "acceptedAt": receipt.get("acceptedAt")}


def _committed_credits(ledger: dict[str, Any]) -> int:
    """Credits already bound to submitted attempts, counted the way the driver's ceiling counts them."""
    total = 0
    for entry in (ledger.get("scenes") or {}).values():
        if not isinstance(entry, dict):
            continue
        generation = entry.get("generation") or {}
        attempts = [*(entry.get("attempts") or [])]
        if generation.get("key") or generation.get("id"):
            attempts.append(generation)
        for attempt in attempts:
            approval = ((attempt or {}).get("submission") or {}).get("approval") or entry.get("quote") or {}
            if isinstance(approval.get("amountUnits"), int):
                total += approval["amountUnits"]
    return total


def summary(production_id: str, *, detail: bool = False) -> dict[str, Any]:
    folder = _dir(production_id)
    state = _read_state(production_id)  # an unreadable state file is reported as such, not as a missing production
    if state is None:
        raise ProductionError(f"no production {production_id}", "unknown_production")
    if state.get("state") == "running" and not is_running(production_id):
        state["state"] = "idle"  # a run that died with the process
    ledger = _read_json(folder / "ledger.json") or {}
    scenes = _scenes(folder, state)
    committed = _committed_credits(ledger)
    plan = _read_json(folder / "work" / "timed-plan.json") or {}
    ends = [s["endMs"] for s in scenes if isinstance(s.get("endMs"), (int, float))]
    duration = plan.get("durationMs") if isinstance(plan.get("durationMs"), (int, float)) else (max(ends) if ends else None)
    quoted = [s["quoteCredits"] for s in scenes if isinstance(s.get("quoteCredits"), int)]
    out = {
        "id": production_id,
        "title": state.get("title"),
        "state": state.get("state"),
        "needs": state.get("needs"),
        "message": state.get("message"),
        "updatedAt": state.get("updatedAt"),
        "aspectRatio": state.get("aspectRatio"),
        "projectId": ((ledger.get("scenes") or {}).get("production") or {}).get("projectId"),
        "scenes": {
            "total": len(scenes),
            "downloaded": sum(1 for s in scenes if s["clip"]),
            "running": sum(1 for s in scenes if s["status"] in ("queued", "running", "uncertain")),
            "failed": sum(1 for s in scenes if s["status"] == "failed"),
        },
        "spend": {"approvedCredits": (state.get("decisions") or {}).get("approved_credits"),
                  "committedCredits": committed},
        "durationMs": duration,
        "quotedCredits": sum(quoted) if quoted else None,
        "master": state.get("master"),
        "sessionId": _live_session(state.get("sessionId")),
        # tells the desktop this backend already dropped a deleted chat, so it must not fall back to a chat id it
        # remembered itself (an older backend leaves this out, and the desktop then does its own remembering)
        "sessionChecked": True,
        "assembly": _assembly(ledger),
        "continuity": "chain" if _chain(folder) else None,
    }
    if detail:
        out.update(needsDetail=state.get("needsDetail") if state.get("state") == "needs" else None,
                   scenes=scenes, log=(state.get("log") or [])[-_LOG_LINES:], report=state.get("report"))
    return out


def media_lines(info: dict[str, Any]) -> list[str]:
    lines = []
    detail = info.get("needsDetail") or {}
    clip = detail.get("clip") if isinstance(detail, dict) else None
    if info.get("needs") in ("first_scene_review", "scene_review") and clip and clip.get("path"):
        lines.append(f"MEDIA:{Path(clip['path']).resolve().as_posix()}")
    master = info.get("master")
    if master and master.get("path") and Path(master["path"]).is_file():
        lines.append(f"MEDIA:{Path(master['path']).resolve().as_posix()}")
    return lines


def inventory(production_id: str) -> list[dict[str, Any]]:
    """The files a rights sign-off covers, for the approval prompt."""
    production = _read_json(_dir(production_id) / "production.json") or {}
    files = []
    for path in [production.get("song"), *[r.get("path") for r in production.get("references") or []]]:
        if path and Path(path).is_file():
            files.append({"name": Path(path).name, "bytes": Path(path).stat().st_size})
    return files


def allowed_media_roots() -> list[Path]:
    return [root(), settings.download_dir()]


def signed_files(version: Any) -> set[tuple[str, Any]]:
    """(name, bytes) of every file a production in this profile already holds a sign-off of this version for."""
    out: set[tuple[str, Any]] = set()
    for pid in list_ids():
        if ((load_state(pid) or {}).get("decisions") or {}).get("rights_version") == version:
            out |= {(f.get("name"), f.get("bytes")) for f in inventory(pid)}
    return out


def managing(project_id: Any) -> Optional[str]:
    """The production that drives this SLOPCANNON project, if any."""
    if not project_id:
        return None
    for pid in list_ids():
        ledger = _read_json(_dir(pid) / "ledger.json") or {}
        if ((ledger.get("scenes") or {}).get("production") or {}).get("projectId") == project_id:
            return pid
    return None


def _live_session(session_id: Any) -> Optional[str]:
    """The chat a production came from, or None once that chat is deleted: the studio then sends to a new chat
    instead of opening one that can no longer load. When Hermes cannot say, the id is kept."""
    if not session_id:
        return None
    return None if _session_exists(str(session_id)) is False else str(session_id)


def _session_exists(session_id: str) -> Optional[bool]:
    """Whether this profile's Hermes still has the chat ``session_id``: True, False, or None when that cannot be told
    (an older Hermes, no session store yet, the store busy). It reads one session row through
    ``hermes_state.SessionDB``, which Hermes lists as public plugin API, opened read-only; nothing is written."""
    try:
        from hermes_state import SessionDB

        db = SessionDB(read_only=True)
    except Exception:
        return None
    try:
        return db.get_session(session_id) is not None
    except Exception:
        return None
    finally:
        try:
            db.close()
        except Exception:
            pass
