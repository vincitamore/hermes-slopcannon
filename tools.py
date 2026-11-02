"""The local tools: what only an agent on the person's own machine can do.

Every hosted SLOPCANNON tool is registered natively by ``server_tools.py``. These
four add the media plane and the session plumbing on top: account state, uploads
from disk, waiting on renders, and bringing clips and masters home as native video.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from . import auth, settings
from .client import Client, NotConnected, SlopcannonError

GENERATION_TERMINAL = {"succeeded", "failed"}
ASSEMBLY_TERMINAL = {"completed", "failed", "uncertain"}
UPLOAD_KINDS = ["song", "character_reference", "set_reference"]
_CONTENT_TYPES = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
}
_POLL_S = 20
_MAX_WAIT_S = 900
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class ToolSpec:
    name: str
    schema: dict[str, Any]
    handler: Callable[..., str]


def _ok(**payload: Any) -> str:
    return json.dumps({"ok": True, **payload}, default=str)


def _fail(exc: Exception) -> str:
    if isinstance(exc, SlopcannonError):
        return json.dumps(exc.to_dict(), default=str)
    return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)})


def _guard(fn: Callable[[dict[str, Any]], str]) -> Callable[..., str]:
    def handler(args: dict[str, Any], **_: Any) -> str:
        try:
            return fn(args or {})
        except Exception as exc:  # every failure is a structured result, never a crash
            return _fail(exc)
    return handler


def _media_line(path: str) -> str:
    return f"MEDIA:{Path(path).resolve().as_posix()}"


def _safe(name: str) -> str:
    return _SAFE_NAME.sub("-", name).strip("-") or "item"


# --------------------------------------------------------------------------- account


def _account(args: dict[str, Any]) -> str:
    client = Client()
    summary = auth.token_summary()
    caps = client.capabilities()
    runtime = caps.get("hostedRuntime") or {}
    contract = caps.get("contract") or {}
    generation = contract.get("generation") or {}
    try:
        rights = client.rights_policy()
    except SlopcannonError:
        rights = {}
    out: dict[str, Any] = {
        "connection": summary,
        "service": {
            "status": runtime.get("status"),
            "submissionReady": runtime.get("submissionReady"),
            "quoteReady": runtime.get("quoteReady"),
        },
        "generation": {k: generation.get(k) for k in (
            "aspectRatios", "sceneDurationMs", "minimumCannonCreditsPerGeneration",
            "cannonCreditsPerOutputSecond", "imageReferencesPerScene", "inFlight") if k in generation},
        "rights": {
            "requiredVersion": rights.get("requiredVersion"),
            "statement": rights.get("statement"),
        },
    }
    if summary["connected"]:
        try:
            out["balance"] = client.balance()
        except SlopcannonError as exc:
            out["balance"] = exc.to_dict()
    else:
        out["next"] = summary.get("message") or NotConnected().args[0]
    return _ok(**out)


ACCOUNT = ToolSpec("slopcannon_account", {
    "name": "slopcannon_account",
    "description": (
        "SLOPCANNON (music videos from a song) connection state, Cannon Credit balance, service "
        "readiness, generation limits and the current rights statement and version. Call "
        "slopcannon_account first. If not connected, tell the person to run `hermes auth add slopcannon:slop` "
        "in a terminal (or set a personal token in the plugin settings); never ask for a token in chat. Before producing anything, load skill_view('slopcannon:hermes-workflow')."),
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}, _guard(_account))


# --------------------------------------------------------------------------- upload


def _upload(args: dict[str, Any]) -> str:
    path = Path(str(args.get("path") or "")).expanduser()
    if not path.is_file():
        raise SlopcannonError(f"no file at {path}", code="file_not_found")
    kind = str(args.get("kind") or "")
    if kind not in UPLOAD_KINDS:
        raise SlopcannonError(f"kind must be one of {UPLOAD_KINDS}", code="invalid_kind")
    project_id = str(args.get("project_id") or "")
    if not project_id:
        raise SlopcannonError("project_id is required (create one with "
                              "slopcannon_create_project)", code="missing_project")
    client = Client()
    policy = client.rights_policy()
    required = policy.get("requiredVersion")
    if not isinstance(required, str) or not required:
        raise SlopcannonError("SLOPCANNON did not return a current rights version", code="rights_unavailable")
    if args.get("rights_version") != required:
        return json.dumps({
            "ok": False, "error": "rights_required", "requiredVersion": required,
            "statement": policy.get("statement"),
            "message": ("Show the person this statement and the file name. Call again with "
                        "rights_version set to requiredVersion; Hermes will ask them to approve."),
        })
    content_type = args.get("content_type") or _CONTENT_TYPES.get(path.suffix.lower()) \
        or mimetypes.guess_type(path.name)[0]
    if not content_type:
        raise SlopcannonError("unknown file type; pass content_type", code="unknown_content_type")
    limits = (client.capabilities().get("contract") or {}).get("assetUploadLimits") or {}
    max_bytes = limits.get("standardMaxBytes")
    size = path.stat().st_size
    if isinstance(max_bytes, int) and size > max_bytes:
        raise SlopcannonError(f"{path.name} is {size} bytes; the upload limit is {max_bytes}",
                              code="too_large")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    key = args.get("idempotency_key") or f"hermes-{kind}-{project_id}-{digest[:32]}"
    asset = client.upload_asset(path=path, project_id=project_id, kind=kind, content_type=content_type,
                                rights_version=required, idempotency_key=key,
                                duration_ms=args.get("duration_ms"))
    return _ok(asset=asset, sha256=digest, idempotencyKey=key)


UPLOAD = ToolSpec("slopcannon_upload", {
    "name": "slopcannon_upload",
    "description": (
        "Upload a local song or reference picture into a SLOPCANNON project (no browser step). "
        "kind: song (mp3/wav/m4a/ogg), character_reference (a recurring person/character or a "
        "product), set_reference (a place). Needs the current rights version from "
        "slopcannon_account; Hermes asks the person to approve the rights sign-off. Re-uploading "
        "the same file to the same project is safe (idempotent). Pictures used for generation "
        "must be under 768 KiB."),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Absolute path of the local file."},
            "project_id": {"type": "string"},
            "kind": {"type": "string", "enum": UPLOAD_KINDS},
            "rights_version": {"type": "string", "description": "requiredVersion from slopcannon_account."},
            "duration_ms": {"type": "integer", "description": "Song duration in ms, when known."},
            "content_type": {"type": "string"},
            "idempotency_key": {"type": "string"},
        },
        "required": ["path", "project_id", "kind", "rights_version"],
        "additionalProperties": False,
    },
}, _guard(_upload))


# --------------------------------------------------------------------------- media home


def _project_dir(project_id: Optional[str]) -> Path:
    base = settings.download_dir()
    path = base / _safe(project_id) if project_id else base
    path.mkdir(parents=True, exist_ok=True)
    return path


def _find_url(value: Any, keys: tuple[str, ...] = ("downloadUrl", "url", "href", "link")) -> Optional[str]:
    if isinstance(value, dict):
        for key in keys:
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.startswith("https://"):
                return candidate
        for nested in value.values():
            found = _find_url(nested, keys)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find_url(item, keys)
            if found:
                return found
    return None


def _download_generation(client: Client, generation_id: str, project_id: Optional[str]) -> dict[str, Any]:
    meta = client.get_json(f"/v1/generations/{generation_id}/content")
    artifacts = meta.get("artifacts") if isinstance(meta, dict) else None
    url = (artifacts[0] or {}).get("downloadUrl") if artifacts else None
    url = url or _find_url(meta)
    if not url:
        raise SlopcannonError("the generation has no downloadable clip yet", code="not_ready", details=meta)
    saved = client.download(url, _project_dir(project_id) / f"{_safe(generation_id)}.mp4")
    return {**saved, "generationId": generation_id, "media": _media_line(saved["path"])}


def _download_assembly(client: Client, assembly_id: str, project_id: Optional[str]) -> dict[str, Any]:
    links = client.call_tool("slopcannon_assembly_download_links", {"assemblyId": assembly_id})
    url = _find_url(links)
    if not url:
        raise SlopcannonError("no download link was issued for this assembly", code="not_ready", details=links)
    saved = client.download(url, _project_dir(project_id) / f"master-{_safe(assembly_id)}.mp4")
    return {**saved, "assemblyId": assembly_id, "media": _media_line(saved["path"])}


def _download(args: dict[str, Any]) -> str:
    client = Client()
    project_id = args.get("project_id")
    if args.get("generation_id"):
        return _ok(**_download_generation(client, str(args["generation_id"]), project_id))
    if args.get("assembly_id"):
        return _ok(**_download_assembly(client, str(args["assembly_id"]), project_id))
    raise SlopcannonError("pass generation_id or assembly_id", code="missing_target")


DOWNLOAD = ToolSpec("slopcannon_download", {
    "name": "slopcannon_download",
    "description": (
        "Save a finished scene clip (generation_id) or the finished film (assembly_id) to disk and "
        "return its path plus a `media` line. Put that MEDIA: line, alone on its own line, in your "
        "reply so the video plays inline (desktop) or arrives as a native video (Telegram, "
        "Discord). Never paste download links into shared chats."),
    "parameters": {
        "type": "object",
        "properties": {
            "generation_id": {"type": "string"},
            "assembly_id": {"type": "string"},
            "project_id": {"type": "string", "description": "Files are grouped by project."},
        },
        "additionalProperties": False,
    },
}, _guard(_download))


def _wait(args: dict[str, Any]) -> str:
    client = Client()
    generation_ids = [str(g) for g in (args.get("generation_ids") or []) if g]
    assembly_id = args.get("assembly_id")
    if not generation_ids and not assembly_id:
        raise SlopcannonError("pass generation_ids and/or assembly_id", code="missing_target")
    deadline = time.monotonic() + max(30, min(int(args.get("timeout_s") or 600), _MAX_WAIT_S))
    fetch = args.get("download", True) is not False
    project_id = args.get("project_id")
    done: dict[str, Any] = {}
    pending = list(generation_ids)
    assembly: Optional[dict[str, Any]] = None
    while True:
        for gid in list(pending):
            record = client.call_tool("slopcannon_get_generation", {"generationId": gid})
            record = record if isinstance(record, dict) else {}
            if isinstance(record.get("generation"), dict):
                record = record["generation"]
            status = record.get("status")
            if status in GENERATION_TERMINAL:
                pending.remove(gid)
                entry: dict[str, Any] = {"status": status}
                if status == "failed":
                    entry["error"] = record.get("error") or record.get("failure")
                elif fetch:
                    try:
                        entry.update(_download_generation(client, gid, project_id))
                    except SlopcannonError as exc:
                        entry["download"] = exc.to_dict()
                done[gid] = entry
        if assembly_id and (assembly is None or assembly.get("status") not in ASSEMBLY_TERMINAL):
            raw = client.call_tool("slopcannon_get_assembly", {"assemblyId": assembly_id})
            current: dict[str, Any] = raw if isinstance(raw, dict) else {"raw": raw}
            nested = current.get("assembly")
            if isinstance(nested, dict):
                current = dict(nested)
            if current.get("status") == "completed" and fetch:
                try:
                    current.update(_download_assembly(client, str(assembly_id), project_id))
                except SlopcannonError as exc:
                    current["download"] = exc.to_dict()
            assembly = current
        assembly_done = not assembly_id or (assembly or {}).get("status") in ASSEMBLY_TERMINAL
        if (not pending and assembly_done) or time.monotonic() >= deadline:
            break
        time.sleep(_POLL_S)
    media = [v["media"] for v in done.values() if v.get("media")]
    if assembly and assembly.get("media"):
        media.append(assembly["media"])
    return _ok(finished=done, still_running=pending, assembly=assembly, media=media,
               note=("Still running; call slopcannon_wait again with the remaining IDs. Never "
                     "resubmit a running generation." if pending or not assembly_done else None))


WAIT = ToolSpec("slopcannon_wait", {
    "name": "slopcannon_wait",
    "description": (
        "Wait for submitted scene generations and/or a final assembly to finish (polls every "
        f"{_POLL_S}s, up to timeout_s, max {_MAX_WAIT_S}), then download finished clips and the "
        "master. Returns `media` lines: put each MEDIA: line alone on its own line in your reply to "
        "show the videos. On timeout, call again with still_running; never resubmit."),
    "parameters": {
        "type": "object",
        "properties": {
            "generation_ids": {"type": "array", "items": {"type": "string"}},
            "assembly_id": {"type": "string"},
            "project_id": {"type": "string"},
            "timeout_s": {"type": "integer", "minimum": 30, "maximum": _MAX_WAIT_S},
            "download": {"type": "boolean", "description": "Default true."},
        },
        "additionalProperties": False,
    },
}, _guard(_wait))


TOOLS: list[ToolSpec] = [ACCOUNT, UPLOAD, WAIT, DOWNLOAD]
