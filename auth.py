"""SLOPCANNON credentials, all through Hermes (catalog rule 11).

The plugin runs no sign-in, stores no token and reads no ``.env``:

- **Hermes sign-in (preferred).** ``plugin.yaml`` declares the OAuth client
  ``slop`` (slop.cc's public PKCE client ``hermes-agent``). The person signs in
  once in a terminal with ``hermes auth add slopcannon:slop``; Hermes keeps the
  90-day grant in its own store. The plugin never receives that grant: it asks
  Hermes, through ``credentialed_provider_request``, to POST
  ``/v1/agent-sessions`` with it, and gets back a short-lived, narrower agent
  session token (two hours by default, never ``billing:purchase``). That session
  lives in this process's memory only and is re-minted when it nears expiry or
  the API answers 401.
- **Personal token (alternative).** A token made at slop.cc/account, entered as
  the plugin's **Agent token** setting (``SLOPCANNON_AGENT_TOKEN``) and read
  through ``agent.secret_scope.get_secret``. It is also the only route when the
  API origin is not ``https://api.slop.cc`` (the sign-in is bound to that host).

A production's Node driver runs for hours as a child process, so it gets its own
twelve-hour session in its environment instead of the in-process one.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from . import settings

OAUTH_ID = "slop"
PLUGIN_KEY = "slopcannon"
SIGN_IN_COMMAND = f"hermes auth add {PLUGIN_KEY}:{OAUTH_ID}"
SIGN_OUT_COMMAND = f"hermes auth logout {PLUGIN_KEY}:{OAUTH_ID}"
CLIENT_ID_ENV = "SLOPCANNON_OAUTH_CLIENT_ID"
PUBLIC_CLIENT_ID = "hermes-agent"
CLIENT_ID_COMMAND = f"hermes config set {CLIENT_ID_ENV} {PUBLIC_CLIENT_ID}"
HOSTED_API_ORIGIN = "https://api.slop.cc"
SESSIONS_URL = f"{HOSTED_API_ORIGIN}/v1/agent-sessions"
PERSONAL_TOKEN_HINT = "or enter a slop.cc/account token as the plugin's Agent token setting"

# The scopes plugin.yaml's oauth entry asks for (kept equal by a test). billing:purchase is
# deliberately absent: buying credits stays in the person's own browser at slop.cc/account.
DEFAULT_SCOPES = (
    "projects:read projects:write assets:read assets:write "
    "quotes:create generations:create generations:read billing:read"
)

SESSION_TTL_S = 2 * 60 * 60
DRIVER_TTL_S = 12 * 60 * 60  # the server's maximum: a production never loses its session mid-run
_REMINT_MARGIN_S = 10 * 60
_MINT_TIMEOUT_S = 20
SESSION_NAME = "Hermes - SLOPCANNON plugin"

VIA_SIGN_IN = "hermes sign-in"
VIA_PERSONAL = "personal token"


class NotSignedIn(RuntimeError):
    """No usable credential: not signed in through Hermes and no personal token."""


class CredentialError(RuntimeError):
    """A credential exists but could not be used (refused, rate limited, misconfigured)."""

    def __init__(self, message: str, code: str = "credential_error"):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Credential:
    token: str
    via: str
    expires_at: Optional[float] = None  # epoch seconds; None for a personal token
    scopes: Optional[tuple[str, ...]] = None
    session: bool = False

    def __repr__(self) -> str:  # never show the token
        return f"Credential(via={self.via!r}, expires_at={self.expires_at!r}, session={self.session!r})"

    def remaining(self) -> float:
        return float("inf") if self.expires_at is None else self.expires_at - time.time()


_lock = threading.Lock()
_cached: Optional[Credential] = None
_session_ttl_s = SESSION_TTL_S


def set_session_ttl(seconds: int) -> None:
    """Size this process's in-memory session to its use (a one-shot CLI command needs minutes)."""
    global _session_ttl_s
    _session_ttl_s = max(60, min(DRIVER_TTL_S, int(seconds)))


def _remint_margin() -> float:
    return min(_REMINT_MARGIN_S, _session_ttl_s / 4)


def _not_signed_in_message(detail: str = "") -> str:
    lead = detail.strip() or "SLOPCANNON is not connected."
    if SIGN_IN_COMMAND in lead:  # Hermes's own message already names the command
        return (f"{lead} Run it in a terminal on the Hermes machine (sign-in cannot start inside a chat or "
                f"the gateway), {PERSONAL_TOKEN_HINT}. Never paste a token into chat.")
    return (f"{lead} To connect, run `{SIGN_IN_COMMAND}` in a terminal on the Hermes machine "
            f"(sign-in cannot start inside a chat or the gateway), {PERSONAL_TOKEN_HINT}. "
            "Never paste a token into chat.")


# --------------------------------------------------------------------------- sources


def _hosted() -> bool:
    try:
        return settings.api_origin() == HOSTED_API_ORIGIN
    except ValueError:
        return False


def _personal_token() -> Optional[str]:
    """The personal token through Hermes's profile-scoped secret route; nothing else is read."""
    try:
        from agent.secret_scope import get_secret
    except ImportError:
        return None  # not inside Hermes: there is no secret route to read
    try:
        return (get_secret(settings.TOKEN_ENV) or "").strip() or None
    except Exception:  # an unscoped read under multiplexing fails closed
        return None


def _error_body(payload: Any) -> tuple[str, str]:
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return str(error.get("code") or ""), str(error.get("message") or "")
    return "", ""


_REFUSALS = {
    "AGENT_SESSION_RATE_LIMITED": "Too many SLOPCANNON sessions this hour; try again later.",
    "AGENT_SESSIONS_UNAVAILABLE": "SLOPCANNON agent sessions are not available yet; try again later.",
    "PERSONAL_TOKEN_REQUIRED": "An organization credential cannot start agent sessions; sign in with your own account.",
    "AGENT_SESSION_CANNOT_DELEGATE": "This credential is itself an agent session and cannot start another.",
    "INVALID_SCOPES": "SLOPCANNON refused the requested session scopes.",
}


def _session_from(status: int, payload: Any, *, via: str) -> Credential:
    """A minted session, or the server's refusal as a NotSignedIn / CredentialError."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if status == 201 and isinstance(data, dict) and isinstance(data.get("token"), str) and data["token"]:
        expires_ms, expires_in = data.get("expiresAt"), data.get("expiresIn")
        if isinstance(expires_ms, (int, float)):
            expires_at = float(expires_ms) / 1000.0
        elif isinstance(expires_in, (int, float)):
            expires_at = time.time() + float(expires_in)
        else:
            expires_at = time.time() + 60.0  # unknown: treat as nearly spent so it is re-minted soon
        scopes = data.get("scopes")
        return Credential(token=data["token"], via=via, expires_at=expires_at,
                          scopes=tuple(str(s) for s in scopes) if isinstance(scopes, list) else None, session=True)
    code, message = _error_body(payload)
    if status == 401:
        if via == VIA_SIGN_IN:
            raise NotSignedIn(_not_signed_in_message(
                "slop.cc no longer accepts this Hermes sign-in (revoked or expired)."))
        raise CredentialError("slop.cc refused the personal token (invalid, revoked or expired). "
                              "Make a new one at slop.cc/account.", "invalid_token")
    text = _REFUSALS.get(code) or message or f"SLOPCANNON could not start an agent session (HTTP {status})."
    raise CredentialError(text, (code or f"http_{status}").lower())


def _session_body(ttl_s: int, name: str) -> dict[str, Any]:
    # scopes omitted: the session gets the parent's scopes minus billing:purchase.
    return {"name": name[:60], "ttlSeconds": max(60, min(DRIVER_TTL_S, int(ttl_s)))}


def _auth_error_message(code: str, exc: BaseException) -> str:
    if code == "oauth_client_id_missing":
        return (f"{CLIENT_ID_ENV} is not set. Set it to slop.cc's public client id `{PUBLIC_CLIENT_ID}` "
                f"(`{CLIENT_ID_COMMAND}`), then run `{SIGN_IN_COMMAND}` in a terminal.")
    if code in ("invalid_client", "unauthorized_client"):
        return (f"slop.cc rejected the OAuth client. Check that {CLIENT_ID_ENV} is `{PUBLIC_CLIENT_ID}`, "
                f"then run `{SIGN_IN_COMMAND}` again in a terminal.")
    if code == "invalid_scope":
        return f"slop.cc rejected the requested scopes; run `{SIGN_IN_COMMAND}` again in a terminal."
    return f"The SLOPCANNON sign-in could not be used ({code}): {exc}"


def _mint_with_sign_in(ttl_s: int, name: str) -> Credential:
    """Ask Hermes to mint a session with the person's grant; the grant never reaches this code."""
    try:
        from hermes_cli.plugin_provider_requests import ProviderNotSignedIn, credentialed_provider_request
    except ImportError:
        raise NotSignedIn(_not_signed_in_message(
            "This Hermes has no plugin sign-in (update Hermes).")) from None
    try:
        from hermes_cli.auth_constants import AuthError
    except ImportError:  # pragma: no cover - present wherever the helper is
        AuthError = None  # type: ignore[assignment,misc]
    try:
        response = credentialed_provider_request(
            OAUTH_ID, "POST", SESSIONS_URL, json=_session_body(ttl_s, name), timeout=_MINT_TIMEOUT_S)
    except ProviderNotSignedIn as exc:
        raise NotSignedIn(_not_signed_in_message(str(exc))) from None
    except PermissionError as exc:
        raise CredentialError(f"Hermes refused the SLOPCANNON sign-in request: {exc}", "sign_in_refused") from None
    except httpx.HTTPError as exc:
        raise CredentialError(f"Could not reach SLOPCANNON ({type(exc).__name__}).", "network") from None
    except Exception as exc:
        if AuthError is not None and isinstance(exc, AuthError):
            code = str(getattr(exc, "code", "") or "oauth_error")
            raise CredentialError(_auth_error_message(code, exc), code) from None
        # Anything else is Hermes's helper failing, not a refusal: say so, never with a traceback.
        raise CredentialError(f"Hermes could not make the signed-in request ({type(exc).__name__}).",
                              "sign_in_unavailable") from None
    try:
        payload = response.json()
    except ValueError:
        payload = None
    return _session_from(response.status, payload, via=VIA_SIGN_IN)


def _mint_with_personal(token: str, ttl_s: int, name: str) -> Credential:
    """A session whose parent is the personal token (for the driver child process)."""
    try:
        with httpx.Client(timeout=_MINT_TIMEOUT_S, follow_redirects=False,
                          headers={"User-Agent": settings.USER_AGENT}) as http:
            response = http.post(SESSIONS_URL, json=_session_body(ttl_s, name),
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise CredentialError(f"Could not reach SLOPCANNON ({type(exc).__name__}).", "network") from None
    try:
        payload = response.json()
    except ValueError:
        payload = None
    return _session_from(response.status_code, payload, via=VIA_PERSONAL)


# --------------------------------------------------------------------------- resolution


def credential(*, fresh: bool = False) -> Credential:
    """The bearer for in-process API calls: a cached sign-in session, else the personal token.

    Raises NotSignedIn when neither exists, and CredentialError when the sign-in exists but
    cannot be used and there is no personal token to fall back on.
    """
    global _cached
    with _lock:  # one mint at a time: the server limits sessions per hour
        problem: Optional[RuntimeError] = None
        if _hosted():
            cached = _cached
            if cached is not None and not fresh and cached.remaining() > _remint_margin():
                return cached
            try:
                _cached = _mint_with_sign_in(_session_ttl_s, SESSION_NAME)
                return _cached
            except (NotSignedIn, CredentialError) as exc:
                _cached = None
                problem = exc
        personal = _personal_token()
        if personal:
            return Credential(token=personal, via=VIA_PERSONAL)
        if problem is not None:
            raise problem
        raise NotSignedIn(
            f"SLOPCANNON is not connected. The API origin {settings.api_origin()} takes a personal token only: "
            "enter a token from that service as the plugin's Agent token setting. Never paste a token into chat.")


def get_token() -> str:
    return credential().token


def invalidate(token: str) -> bool:
    """Forget the cached session if *token* is it (the API answered 401); True when a retry can help."""
    global _cached
    with _lock:
        if _cached is not None and _cached.token == token:
            _cached = None
            return True
    return False


def reset() -> None:
    """Drop the in-memory session (nothing is stored anywhere else)."""
    global _cached
    with _lock:
        _cached = None


def driver_token(production_id: str) -> Credential:
    """A dedicated long session for a production driver child, never the in-process one."""
    name = f"Hermes - SLOPCANNON production {production_id}"
    problem: Optional[RuntimeError] = None
    if _hosted():
        try:
            return _mint_with_sign_in(DRIVER_TTL_S, name)
        except (NotSignedIn, CredentialError) as exc:
            problem = exc
    personal = _personal_token()
    if personal:
        if _hosted():
            try:
                return _mint_with_personal(personal, DRIVER_TTL_S, name)
            except CredentialError:
                pass  # sessions unavailable or rate limited: the personal token itself, as before
        return Credential(token=personal, via=VIA_PERSONAL)
    if problem is not None:
        raise problem
    raise NotSignedIn(_not_signed_in_message())


def token_summary() -> dict[str, Any]:
    """What the status surfaces show: how the plugin is connected, never a token or any part of one."""
    base: dict[str, Any] = {"connected": False, "via": None, "expires_at": None, "scopes": None,
                            "session": False, "sign_in": SIGN_IN_COMMAND, "message": None, "error": None}
    try:
        cred = credential()
    except NotSignedIn as exc:
        return {**base, "message": str(exc)}
    except CredentialError as exc:
        return {**base, "message": str(exc), "error": exc.code}
    return {**base, "connected": True, "via": cred.via,
            "expires_at": int(cred.expires_at) if cred.expires_at is not None else None,
            "scopes": list(cred.scopes) if cred.scopes is not None else None, "session": cred.session}


def sign_in_help() -> list[tuple[str, str]]:
    """(label, text) rows explaining how to connect; shared by /slop and the CLI."""
    return [
        ("sign-in", f"run `{SIGN_IN_COMMAND}` in a terminal on the Hermes machine"),
        ("why", "it opens your browser, so it cannot start inside a chat or the gateway"),
        ("once", f"first set the client id: `{CLIENT_ID_COMMAND}`"),
        ("or", "enter a slop.cc/account token as the plugin's Agent token setting"),
        ("never", "paste a token into chat"),
    ]
