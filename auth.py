"""SLOPCANNON account connection.

The plugin owns its own sign-in so the agent never sees a credential:
OAuth 2.1 authorization code + PKCE (S256) against slop.cc, with dynamic client
registration and a loopback redirect (RFC 8252), the same shape every MCP
client uses. The resulting scoped bearer token is stored through Hermes's
secret path (``.env``) under ``SLOPCANNON_AGENT_TOKEN``; a token minted at
slop.cc/account can be stored the same way for headless seats.
"""
from __future__ import annotations

import base64
import hashlib
import http.server
import os
import secrets
import socket
import threading
import time
import webbrowser
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from . import settings

# billing:purchase is deliberately not requested: buying credits stays in the
# person's own browser at slop.cc/account.
DEFAULT_SCOPES = (
    "projects:read projects:write assets:read assets:write "
    "quotes:create generations:create generations:read billing:read"
)
CLIENT_NAME = "Hermes Agent (SLOPCANNON plugin)"
_CALLBACK_PATH = "/callback"
_LOGIN_TIMEOUT_S = 300


class LoginError(RuntimeError):
    pass


# --------------------------------------------------------------------------- token store


def get_token() -> Optional[str]:
    """The token through Hermes's profile-scoped secret route (catalog rule 11)."""
    try:
        from agent.secret_scope import get_secret

        return (get_secret(settings.TOKEN_ENV) or "").strip() or None
    except ImportError:
        pass  # an older Hermes, or tests
    value = os.environ.get(settings.TOKEN_ENV, "").strip()
    if value:
        return value
    try:
        from hermes_cli.config import get_env_value

        value = (get_env_value(settings.TOKEN_ENV) or "").strip()
    except Exception:
        value = ""
    return value or None


def save_token(token: str) -> None:
    token = token.strip()
    if not token:
        raise LoginError("refusing to store an empty token")
    try:
        from hermes_cli import config as hermes_config

        saver = getattr(hermes_config, "save_env_value_secure", None) or hermes_config.save_env_value
        saver(settings.TOKEN_ENV, token)
    except ImportError:
        pass  # outside Hermes (tests): the process environment is the store
    os.environ[settings.TOKEN_ENV] = token


def clear_token() -> None:
    os.environ.pop(settings.TOKEN_ENV, None)
    try:
        from hermes_cli.config import remove_env_value

        remove_env_value(settings.TOKEN_ENV)
    except Exception:
        try:
            from hermes_cli.config import save_env_value

            save_env_value(settings.TOKEN_ENV, "")
        except Exception:
            pass
    settings.state_set("session", None)


def token_summary() -> dict[str, Any]:
    token = get_token()
    session = settings.state_get("session") or {}
    return {
        "connected": bool(token),
        "token_prefix": (token[:13] + "...") if token else None,
        "expires_at": session.get("expires_at"),
        "scopes": session.get("scope"),
        "via": session.get("via") or ("environment" if token else None),
    }


# --------------------------------------------------------------------------- OAuth


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _pkce_pair() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(48))  # 64 chars of [A-Za-z0-9_-]
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _discover(auth_origin: str, http: httpx.Client) -> dict[str, Any]:
    response = http.get(f"{auth_origin}/.well-known/oauth-authorization-server")
    response.raise_for_status()
    meta = response.json()
    if settings.validated_origin(meta.get("issuer")) != auth_origin:
        raise LoginError(f"authorization server issuer {meta.get('issuer')!r} does not match {auth_origin}")
    for key in ("authorization_endpoint", "token_endpoint", "registration_endpoint"):
        endpoint = meta.get(key) or ""
        if urlsplit(endpoint).scheme + "://" + urlsplit(endpoint).netloc != auth_origin:
            raise LoginError(f"{key} {endpoint!r} is not on {auth_origin}")
    if "S256" not in (meta.get("code_challenge_methods_supported") or []):
        raise LoginError("authorization server does not offer PKCE S256")
    return meta


def _reserve_port(preferred: Optional[int]) -> socket.socket:
    for port in ([preferred] if preferred else []) + [0]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("127.0.0.1", port))
            return sock
        except OSError:
            sock.close()
    raise LoginError("could not bind a loopback port for the sign-in callback")


def _register_client(meta: dict[str, Any], redirect_uri: str, http: httpx.Client) -> str:
    response = http.post(
        meta["registration_endpoint"],
        json={
            "client_name": CLIENT_NAME,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
    )
    if response.status_code >= 400:
        raise LoginError(f"client registration refused: HTTP {response.status_code} {response.text[:300]}")
    client_id = response.json().get("client_id")
    if not client_id:
        raise LoginError("client registration returned no client_id")
    return str(client_id)


class _CallbackServer(http.server.HTTPServer):
    result: dict[str, str]


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 (stdlib API)
        parts = urlsplit(self.path)
        if parts.path != _CALLBACK_PATH:
            self.send_response(404)
            self.end_headers()
            return
        query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        self.server.result.update(query)  # type: ignore[attr-defined]
        ok = "code" in query
        body = (
            "<html><body style='font-family:sans-serif;padding:2em'>"
            + ("<h2>SLOPCANNON is connected to Hermes.</h2><p>You can close this tab.</p>" if ok
               else "<h2>Sign-in did not complete.</h2><p>Return to Hermes for details.</p>")
            + "</body></html>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - silence stdlib access log
        return


def login(
    *,
    open_browser: bool = True,
    timeout_s: int = _LOGIN_TIMEOUT_S,
    say: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Run the browser sign-in and store the token. Returns a token summary."""
    auth_origin = settings.auth_origin()
    resource = settings.mcp_resource()
    with httpx.Client(timeout=20.0, follow_redirects=False, headers={"User-Agent": settings.USER_AGENT}) as http:
        meta = _discover(auth_origin, http)

        cached = settings.state_get("oauth_client") or {}
        cached_port = None
        if cached.get("auth_origin") == auth_origin and cached.get("client_id"):
            cached_port = urlsplit(cached.get("redirect_uri", "")).port
        sock = _reserve_port(cached_port)
        port = sock.getsockname()[1]
        redirect_uri = f"http://127.0.0.1:{port}{_CALLBACK_PATH}"
        if cached_port == port:
            client_id = cached["client_id"]
        else:
            client_id = _register_client(meta, redirect_uri, http)
            settings.state_set("oauth_client", {
                "auth_origin": auth_origin, "client_id": client_id, "redirect_uri": redirect_uri,
            })

        verifier, challenge = _pkce_pair()
        state = _b64url(secrets.token_bytes(24))
        authorize_url = meta["authorization_endpoint"] + "?" + urlencode({
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": DEFAULT_SCOPES,
            "resource": resource,
        })

        server = _CallbackServer(("127.0.0.1", port), _CallbackHandler, bind_and_activate=False)
        server.socket.close()
        server.socket = sock
        server.server_activate()
        server.result = {}
        server.timeout = 1.0
        thread = threading.Thread(target=lambda: _serve_until_result(server, timeout_s), daemon=True)
        thread.start()

        say("Opening slop.cc to connect SLOPCANNON to Hermes. If no browser opens, visit:\n" + authorize_url)
        if open_browser:
            try:
                webbrowser.open(authorize_url)
            except Exception:
                pass
        thread.join(timeout_s + 5)
        server.server_close()

        result = dict(server.result)
        if not result:
            raise LoginError("sign-in timed out; run the login again")
        if result.get("error"):
            raise LoginError(f"sign-in refused: {result.get('error')}: {result.get('error_description', '')}")
        if not secrets.compare_digest(result.get("state", ""), state):
            raise LoginError("sign-in state mismatch; the callback was not for this request")

        response = http.post(meta["token_endpoint"], data={
            "grant_type": "authorization_code",
            "code": result.get("code", ""),
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
            "resource": resource,
        })
        if response.status_code >= 400:
            raise LoginError(f"token exchange refused: HTTP {response.status_code} {response.text[:300]}")
        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise LoginError("token exchange returned no access_token")

    save_token(token)
    expires_in = payload.get("expires_in")
    settings.state_set("session", {
        "via": "oauth",
        "scope": payload.get("scope"),
        "expires_at": int(time.time()) + int(expires_in) if isinstance(expires_in, (int, float)) else None,
    })
    return token_summary()


def _serve_until_result(server: _CallbackServer, timeout_s: int) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline and "code" not in server.result and "error" not in server.result:
        server.handle_request()


def store_pasted_token(token: str) -> dict[str, Any]:
    """Store a token minted at slop.cc/account (headless seats)."""
    token = token.strip()
    if not token.startswith("slop_"):
        raise LoginError("that does not look like a SLOPCANNON token (expected slop_...)")
    save_token(token)
    settings.state_set("session", {"via": "pasted", "scope": None, "expires_at": None})
    return token_summary()
