"""Plugin settings and the bound PluginContext.

Hermes hands ``register(ctx)`` one context per load. Tool handlers and hooks run
later on other threads, so the context is kept here and read through small
accessors that fall back to the manifest defaults when the plugin runs outside
Hermes (tests, the CLI before a session exists).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

DEFAULT_API_ORIGIN = "https://api.slop.cc"
DEFAULT_AUTH_ORIGIN = "https://slop.cc"
TOKEN_ENV = "SLOPCANNON_AGENT_TOKEN"
USER_AGENT = "hermes-slopcannon/0.2.0"

_DEFAULTS: dict[str, Any] = {
    "api_origin": DEFAULT_API_ORIGIN,
    "auth_origin": DEFAULT_AUTH_ORIGIN,
    "download_dir": "",
    "max_credits_per_action": 0,
    "auto_approve_max_credits": 0,
}

_ctx: Any = None


def bind(ctx: Any) -> None:
    global _ctx
    _ctx = ctx


def context() -> Any:
    return _ctx


def get(key: str) -> Any:
    default = _DEFAULTS.get(key)
    if _ctx is None:
        return default
    try:
        value = _ctx.get_config(key, default=default)
    except Exception:
        return default
    return default if value in (None, "") and default not in (None, "") else value


def get_int(key: str) -> int:
    try:
        return max(0, int(get(key) or 0))
    except (TypeError, ValueError):
        return 0


def validated_origin(raw: Optional[str]) -> str:
    """An HTTPS origin, or loopback HTTP; never a path, query, fragment or userinfo."""
    value = (raw or "").strip().rstrip("/")
    parts = urlsplit(value)
    loopback = parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        (parts.scheme != "https" and not loopback)
        or not parts.netloc
        or parts.username
        or parts.password
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise ValueError(f"{value!r} is not an HTTPS origin (or loopback HTTP)")
    return f"{parts.scheme}://{parts.netloc}"


def api_origin() -> str:
    return validated_origin(get("api_origin") or DEFAULT_API_ORIGIN)


def auth_origin() -> str:
    return validated_origin(get("auth_origin") or DEFAULT_AUTH_ORIGIN)


def mcp_resource() -> str:
    """The OAuth protected-resource identifier the token is minted for."""
    return f"{api_origin()}/mcp"


def download_dir() -> Path:
    configured = (get("download_dir") or "").strip()
    if configured:
        path = Path(configured).expanduser()
    else:
        try:
            from hermes_constants import get_hermes_home

            path = Path(get_hermes_home()) / "cache" / "videos" / "slopcannon"
        except Exception:
            path = Path.home() / ".hermes" / "cache" / "videos" / "slopcannon"
    path.mkdir(parents=True, exist_ok=True)
    return path


def state_get(key: str, default: Any = None) -> Any:
    if _ctx is None:
        return default
    try:
        return _ctx.state.get(key, default=default)
    except Exception:
        return default


def state_set(key: str, value: Any) -> None:
    if _ctx is None:
        return
    try:
        _ctx.state.set(key, value)
    except Exception:
        pass
