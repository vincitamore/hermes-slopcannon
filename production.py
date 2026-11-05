"""Whole productions, driven by SLOPCANNON's own production driver.

The published CLI ships ``scripts/slopcannon-agent.mjs run``: the reviewed,
resumable pipeline (project, uploads, server scene audio, timed plan, quotes,
first-scene review, parallel renders, character checks, server assembly) with a
ledger that makes every paid step recoverable. The plugin runs that driver
rather than re-implementing it, so Hermes produces films exactly the way the
conformance suite does.

The driver stops at each human gate with ``{"ok": false, "needs": ...}``. Gate
answers (rights assent, the approved credit ceiling, first-scene review,
accepted check flags) are taken only from its command line, so here they come
only from decisions a person confirmed through Hermes's approval prompt
(``gate.py``), never from the production file the model writes.

Each production lives in ``<plugin data>/productions/<id>/``: ``production.json``
(model-authored direction), ``ledger.json`` (the driver's paid-work record),
``state.json`` (this module's view) and ``work/`` (plans, clips, the master).
Runs happen on a background thread so a render can take as long as it takes.
"""
from __future__ import annotations

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
from typing import Any, Optional

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

_runners: dict[str, "_Runner"] = {}
_runners_lock = threading.Lock()


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
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def load_state(production_id: str) -> Optional[dict[str, Any]]:
    return _read_json(_dir(production_id) / "state.json")


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


def node_status() -> dict[str, Any]:
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
    state = load_state(production_id) or {
        "id": production_id, "createdAt": int(time.time() * 1000), "state": "idle", "needs": None,
        "decisions": {}, "runs": [], "log": [],
    }
    state["title"] = clean["title"]
    state["aspectRatio"] = clean.get("aspectRatio")
    _save_state(production_id, state)
    return state


# --------------------------------------------------------------------------- decisions (from the gate only)


def record_decisions(production_id: str, decisions: dict[str, Any]) -> dict[str, Any]:
    state = load_state(production_id)
    if state is None:
        raise ProductionError(f"no production {production_id}", "unknown_production")
    current = state.setdefault("decisions", {})
    for key in ("rights_version", "approved_credits", "review_first", "accept_checks"):
        if decisions.get(key) not in (None, "", []):
            current[key] = decisions[key]
    rerolls = current.setdefault("rerolls", {})
    asked = decisions.get("reroll")
    if isinstance(asked, dict) and asked.get("scene"):
        # A new take of a delivered scene: quoted first, bought only on the person's approve_reroll.
        scene = str(asked["scene"])
        rerolls[scene] = {"direction": (str(asked.get("direction")).strip() or None) if asked.get("direction") else None,
                          "approved": None, "take": None}
    approved = decisions.get("approve_reroll")
    if isinstance(approved, int) and not isinstance(approved, bool):
        scene = (state.get("needsDetail") or {}).get("scene")
        if state.get("needs") == "reroll_approval" and scene in rerolls:
            rerolls[scene]["approved"] = approved
    if not rerolls:
        current.pop("rerolls", None)
    _save_state(production_id, state)
    return current


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
    state = load_state(production_id)
    if state is not None and state.get("sessionId") != session_id:
        state["sessionId"] = session_id
        _save_state(production_id, state)


def _driver_args(folder: Path, decisions: dict[str, Any], concurrency: int) -> list[str]:
    """The next driver call: an open reroll, then the cut with the chosen takes, else the film's own run."""
    ledger = str(folder / "ledger.json")
    checks = decisions.get("accept_checks")
    rerolls = decisions.get("rerolls") or {}
    for scene, ask in rerolls.items():
        if ask.get("take"):
            continue
        args = ["reroll", "--ledger", ledger, "--scene", scene,
                "--plan", str(folder / "work" / "scene-audio" / "scene-plans" / f"{scene}.json"),
                "--cast", str(folder / "work" / "cast.json")]
        if ask.get("direction"):
            args += ["--direction", str(ask["direction"])]
        if isinstance(ask.get("approved"), int):
            # A reroll counts toward the film's ceiling, so the approved take raises it by exactly its quote.
            ceiling = int(decisions.get("approved_credits") or 0) + sum(
                int(r.get("approved") or 0) for r in rerolls.values())
            args += ["--approve-units", str(ask["approved"]), "--max-credits", str(ceiling)]
        return args
    takes = {scene: ask["take"] for scene, ask in rerolls.items() if ask.get("take")}
    if takes:
        title = _film_title(folder)
        args = ["cut", "--ledger", ledger, "--plan", str(folder / "work" / "timed-plan.json"),
                "--takes", ",".join(f"{scene}={take}" for scene, take in takes.items()),
                "--title", title, "--output", str(folder / "work" / f"{re.sub(r'[^A-Za-z0-9._-]+', '-', title)}.mp4")]
        if checks:
            args += ["--accept-checks", "all" if checks == "all" else ",".join(checks)]
        return args
    args = ["run", "--production", str(folder / "production.json"), "--ledger", str(folder / "ledger.json"),
            "--concurrency", str(max(1, min(16, concurrency)))]
    if decisions.get("rights_version"):
        args += ["--rights-accepted", str(decisions["rights_version"])]
    if isinstance(decisions.get("approved_credits"), int):
        args += ["--approve", "all", "--max-credits", str(decisions["approved_credits"])]
    if decisions.get("review_first"):
        args += ["--review-first", str(decisions["review_first"])]
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
        state = load_state(pid) or {}
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
            env = {**os.environ, settings.TOKEN_ENV: token, "SLOPCANNON_AGENT_ORIGIN": settings.api_origin()}
            while True:
                verb_args = _driver_args(folder, state.get("decisions") or {}, self.concurrency)
                code, result, stdout, stderr = self._call([node["node"], str(DRIVER), *verb_args], env, state)
                state = load_state(pid) or state
                state["runs"][-1].update(endedAt=int(time.time() * 1000), exitCode=code)
                state["log"] = (state.get("log") or [])[-_LOG_LINES:] + _log_lines(result, stderr)
                if verb_args[0] == "reroll" and code == 0 and result.get("ok") and not self.stopped:
                    ask = state["decisions"]["rerolls"][verb_args[verb_args.index("--scene") + 1]]
                    ask["take"] = result.get("scene")
                    ask["check"] = (result.get("check") or {}).get("verdict")
                    state["log"].append(f"reroll {result.get('rerollOf')} -> {result.get('scene')}")
                    _save_state(pid, state)
                    continue  # the next reroll, or the cut with the new takes
                break
            if verb_args[0] == "reroll" and code == 2 and result.get("needs") == "approval":
                result = {**result, "needs": "reroll_approval"}
            if self.stopped:
                state.update(state="idle", needs=None, message="Stopped. Paid work already accepted keeps running "
                             "on the server; continuing the production recovers it without paying again.")
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
            _save_state(pid, state)
        except ProductionError as exc:
            state.update(state="error", needs=None, message=str(exc), errorCode=exc.code)
            _save_state(pid, state)
        except Exception as exc:  # never leave a production stuck in "running"
            state.update(state="error", needs=None, message=f"{type(exc).__name__}: {exc}")
            _save_state(pid, state)
        finally:
            (folder / "heartbeat").unlink(missing_ok=True)
            self.done.set()
            with _runners_lock:
                if _runners.get(pid) is self:
                    _runners.pop(pid, None)

    def _call(self, args: list[str], env: dict[str, str], state: dict[str, Any]) -> tuple[int, dict[str, Any], str, str]:
        state.update(state="running", needs=None, message=None)
        state.setdefault("runs", []).append({"startedAt": int(time.time() * 1000), "verb": args[2]})
        _save_state(self.production_id, state)
        self.proc = subprocess.Popen(args, cwd=str(_dir(self.production_id)), env=env, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
        watcher = threading.Thread(target=contextvars.copy_context().run, args=(self._watch_ledger,), daemon=True)
        watcher.start()
        stdout, stderr = self.proc.communicate()
        return self.proc.returncode, _last_json(stdout) or _last_json(stderr) or {}, stdout, stderr

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
        self.stopped = True
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()


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
    if needs == "reroll_approval":
        return {"scene": result.get("rerollOf"), "take": result.get("scene"), "amountUnits": result.get("amountUnits"),
                "quoteId": result.get("quoteId"), "expiresAt": result.get("expiresAt"),
                "productionCeilingCredits": result.get("productionCeilingCredits")}
    if needs == "shot_review":
        return {"flagged": [{"scene": f.get("scene"), "verdict": f.get("verdict"), "issues": f.get("issues") or []}
                            for f in result.get("flagged") or [] if isinstance(f, dict)]}
    if needs == "review":
        return {"failed": result.get("failed") or []}
    return {}


# --------------------------------------------------------------------------- public operations


def start(production_id: str, *, concurrency: int = 4) -> dict[str, Any]:
    if load_state(production_id) is None:
        raise ProductionError(f"no production {production_id}", "unknown_production")
    with _runners_lock:
        existing = _runners.get(production_id)
        if existing is not None and existing.is_alive():
            return summary(production_id)
        if is_running(production_id):  # driven by another Hermes process on this machine
            return summary(production_id)
        (_dir(production_id) / "stop.request").unlink(missing_ok=True)
        runner = _Runner(production_id, concurrency)
        _runners[production_id] = runner
        state = load_state(production_id) or {}
        state.update(state="running", needs=None, message=None)
        _save_state(production_id, state)
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
    # A reroll is a newer take of its scene, not a scene of its own: the row shows the take the film will use
    # (the newest reroll once asked for), so a replaced scene never still reads as flagged.
    rerolls: dict[str, list[dict[str, Any]]] = {}
    for key, value in entries.items():
        if value.get("rerollOf"):
            rerolls.setdefault(str(value["rerollOf"]), []).append(value)
    ids = sorted({k for k in entries if not entries[k].get("rerollOf")} | {f"sc{i + 1:02d}" for i in range(len(plan_scenes))})
    asked = (state.get("decisions") or {}).get("rerolls") or {}
    rows = []
    for sid in ids:
        entry = entries.get(sid, {})
        takes = rerolls.get(sid) or []
        if takes:
            entry = takes[-1]
        elif sid in asked:
            entry = {}  # asked for, not yet quoted
        try:
            index = int(sid[2:].split(".")[0]) - 1
        except ValueError:
            index = -1
        planned = plan_scenes[index] if 0 <= index < len(plan_scenes) and "." not in sid else {}
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
        accepted = (state.get("decisions") or {}).get("accept_checks")
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
            "take": len([a for a in entry.get("attempts") or [] if isinstance(a, dict)]) + 1 + len(takes),
            "rerolled": bool(takes) or sid in asked,
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
    state = load_state(production_id)
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
        "sessionChecked": True,
        "assembly": _assembly(ledger),
    }
    if detail:
        out.update(needsDetail=state.get("needsDetail") if state.get("state") == "needs" else None,
                   scenes=scenes, log=(state.get("log") or [])[-_LOG_LINES:], report=state.get("report"))
    return out


def media_lines(info: dict[str, Any]) -> list[str]:
    lines = []
    detail = info.get("needsDetail") or {}
    clip = detail.get("clip") if isinstance(detail, dict) else None
    if info.get("needs") == "first_scene_review" and clip and clip.get("path"):
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
    instead of opening one that can no longer load. Unknown (no readable session store) keeps the id."""
    if not session_id:
        return None
    try:
        import sqlite3

        from hermes_constants import get_hermes_home

        db = Path(get_hermes_home()) / "state.db"
        if not db.is_file():
            return str(session_id)
        con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute("select 1 from sessions where id = ?", (str(session_id),)).fetchone()
        finally:
            con.close()
        return str(session_id) if row else None
    except Exception:
        return str(session_id)
