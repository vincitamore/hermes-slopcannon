"""Backend routes for the SLOPCANNON desktop studio: ``/api/plugins/slopcannon/``.

Hermes imports this file inside the gateway process when the plugin is enabled
in ``plugins.enabled``. It reads the same on-disk production state the agent
tools write, so the studio is correct whichever process drove a production.
Nothing here spends credits or records a rights sign-off: those happen only
through agent tool calls that pass Hermes's approval prompt.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

_PACKAGE_DIR = Path(__file__).resolve().parents[1]
_ALIAS = "hermes_slopcannon_studio"


def _package() -> ModuleType:
    """The plugin package: the copy Hermes already loaded, else one loaded from this folder."""
    init = (_PACKAGE_DIR / "__init__.py").resolve()
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None)
        if file and name.count(".") <= 1 and Path(file).resolve() == init:
            return module
    if _ALIAS not in sys.modules:
        spec = importlib.util.spec_from_file_location(_ALIAS, init, submodule_search_locations=[str(_PACKAGE_DIR)])
        if spec is None or spec.loader is None:
            raise RuntimeError("cannot load the SLOPCANNON plugin package")
        module = importlib.util.module_from_spec(spec)
        sys.modules[_ALIAS] = module
        spec.loader.exec_module(module)
    return sys.modules[_ALIAS]


def _mod(name: str) -> Any:
    package = _package()
    return importlib.import_module(f"{package.__name__}.{name}")


router = APIRouter()


@router.get("/status")
def status() -> dict[str, Any]:
    auth, client_mod = _mod("auth"), _mod("client")
    summary = auth.token_summary()
    out: dict[str, Any] = {
        "connected": bool(summary.get("connected")), "via": summary.get("via"),
        "expiresAt": summary.get("expires_at"), "credits": None,
        "service": {"status": None, "submissionReady": None},
        "error": None if summary.get("connected") or not summary.get("error") else summary.get("message"),
        "node": _mod("production").node_status(), "signIn": _sign_in(auth),
    }
    client = client_mod.Client()
    try:
        runtime = client.capabilities().get("hostedRuntime") or {}
        out["service"] = {"status": runtime.get("status"), "submissionReady": runtime.get("submissionReady")}
    except Exception as exc:
        out["error"] = f"service unreachable ({type(exc).__name__})"
    if out["connected"]:
        try:
            balance = client.balance()
            out["credits"] = {"available": balance.get("availableCredits"),
                              "reserved": balance.get("reservedCredits"), "scope": balance.get("scope")}
        except Exception as exc:
            out["error"] = str(exc)[:300]
    out["node"] = {k: v for k, v in out["node"].items() if k != "node"}  # never a local path
    return out


@router.get("/productions")
def productions() -> dict[str, Any]:
    production = _mod("production")
    rows = []
    for pid in production.list_ids()[:50]:
        try:
            rows.append(production.summary(pid))
        except Exception:
            continue
    return {"productions": rows}


@router.get("/productions/{production_id}")
def production_detail(production_id: str) -> dict[str, Any]:
    production = _mod("production")
    try:
        return production.summary(production_id, detail=True)
    except production.ProductionError as exc:
        raise HTTPException(status_code=404 if exc.code == "unknown_production" else 400, detail=str(exc))


@router.get("/productions/{production_id}/media")
def production_media(production_id: str) -> dict[str, Any]:
    """Poster/filmstrip cache names and the song envelope; ``pending`` while ffmpeg works in the background."""
    production, media = _mod("production"), _mod("media")
    try:
        return media.production_media(production_id)
    except production.ProductionError as exc:
        raise HTTPException(status_code=404 if exc.code == "unknown_production" else 400, detail=str(exc))


@router.get("/thumbs")
def thumbs() -> dict[str, Any]:
    production, media = _mod("production"), _mod("media")
    return media.thumbs(production.list_ids()[:50])


@router.get("/frames/{name}")
def frame(name: str) -> dict[str, Any]:
    """One finished poster/strip/thumb as a data URL, by its opaque cache name (never a path)."""
    media = _mod("media")
    try:
        return {"dataUrl": media.frame_data_url(name)}
    except media.MediaError:
        raise HTTPException(status_code=404, detail="not found")


@router.get("/locate")
def locate(path: str = Query("", max_length=4096), generationId: str = Query("", max_length=200)) -> dict[str, Any]:  # noqa: N803
    """The production and scene a chat clip belongs to (the path is compared with recorded paths, never opened)."""
    hit = _mod("media").locate(path=path or None, generation_id=generationId or None)
    if not hit:
        raise HTTPException(status_code=404, detail="not found")
    return hit


@router.post("/productions/{production_id}/stop")
def production_stop(production_id: str) -> dict[str, Any]:
    production = _mod("production")
    try:
        return {"stopped": production.stop(production_id)}
    except production.ProductionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/login")
def login() -> dict[str, Any]:
    """How to connect. Sign-in is Hermes's own and runs in a terminal; the plugin never starts one."""
    auth = _mod("auth")
    return {"started": False, **_sign_in(auth)}


def _sign_in(auth: Any) -> dict[str, Any]:
    return {"command": auth.SIGN_IN_COMMAND, "clientIdCommand": auth.CLIENT_ID_COMMAND,
            "signOutCommand": auth.SIGN_OUT_COMMAND,
            "alternative": "Or enter a slop.cc/account token as the plugin's Agent token setting."}


@router.get("/media")
def media(path: str = Query(..., min_length=1)) -> FileResponse:
    """Stream a clip or master this plugin saved (byte ranges supported); nothing else on disk."""
    production = _mod("production")
    target = Path(path).expanduser()
    try:
        target = target.resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="not found")
    allowed = False
    for root in production.allowed_media_roots():
        try:
            target.relative_to(Path(root).resolve())
            allowed = True
            break
        except ValueError:
            continue
    if not allowed or not target.is_file() or target.suffix.lower() not in {".mp4", ".mov", ".webm", ".m4a", ".mp3", ".wav"}:
        raise HTTPException(status_code=404, detail="not found")
    media_type = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
                  ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav"}[target.suffix.lower()]
    return FileResponse(target, media_type=media_type, headers={"Cache-Control": "private, max-age=3600"})
