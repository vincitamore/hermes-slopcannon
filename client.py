"""HTTP client for the SLOPCANNON partner API and its MCP control plane.

Two transports, one origin:
- MCP JSON-RPC (stateless Streamable HTTP, ``POST /api/mcp``) for every
  control-plane operation the server exposes as a tool;
- REST for the media plane MCP refuses on purpose (asset bytes in, clips and
  masters out).

The bearer token is only ever sent to the configured API origin. Redirects
are never followed with it, and capability links on other origins are fetched
without credentials.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlencode, urlsplit

import httpx

from . import auth, settings

MCP_PROTOCOL_VERSION = "2025-11-25"
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_UPLOAD_TIMEOUT = httpx.Timeout(300.0, connect=10.0)
_DOWNLOAD_TIMEOUT = httpx.Timeout(600.0, connect=10.0)


class SlopcannonError(RuntimeError):
    def __init__(self, message: str, *, code: str = "error", status: Optional[int] = None,
                 details: Any = None):
        super().__init__(message)
        self.code, self.status, self.details = code, status, details

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ok": False, "error": self.code, "message": str(self)}
        if self.status is not None:
            out["status"] = self.status
        if self.details is not None:
            out["details"] = self.details
        return out


class NotConnected(SlopcannonError):
    def __init__(self) -> None:
        super().__init__(
            "SLOPCANNON is not connected. Ask the person to run `/slop login` (or "
            "`hermes slopcannon login` in a terminal) and sign in at slop.cc; never ask them "
            "to paste a token into chat.",
            code="not_connected",
        )


def _error_from(response: httpx.Response) -> SlopcannonError:
    try:
        payload = response.json()
    except Exception:
        payload = None
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        return SlopcannonError(str(error.get("message") or f"HTTP {response.status_code}"),
                               code=str(error.get("code") or "http_error"),
                               status=response.status_code, details=error.get("details"))
    if isinstance(error, str):
        return SlopcannonError(error, code="http_error", status=response.status_code)
    return SlopcannonError(f"SLOPCANNON returned HTTP {response.status_code}", code="http_error",
                           status=response.status_code)


class Client:
    def __init__(self, *, origin: Optional[str] = None, token: Optional[str] = None,
                 transport: Optional[httpx.BaseTransport] = None):
        self.origin = settings.validated_origin(origin or settings.api_origin())
        self._token = token
        self._transport = transport

    # ----------------------------------------------------------------- plumbing

    def _http(self, timeout: httpx.Timeout = _TIMEOUT) -> httpx.Client:
        return httpx.Client(timeout=timeout, follow_redirects=False, transport=self._transport,
                            headers={"User-Agent": settings.USER_AGENT})

    def token(self) -> str:
        token = self._token or auth.get_token()
        if not token:
            raise NotConnected()
        return token

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token()}"}

    def _url(self, path: str) -> str:
        url = path if path.startswith(("http://", "https://")) else f"{self.origin}{path}"
        parts = urlsplit(url)
        if f"{parts.scheme}://{parts.netloc}" != self.origin:
            raise SlopcannonError("refused to send the SLOPCANNON token to another origin",
                                  code="foreign_origin")
        return url

    @staticmethod
    def _check(response: httpx.Response) -> httpx.Response:
        if 300 <= response.status_code < 400:
            raise SlopcannonError("SLOPCANNON answered with a redirect; the token was not forwarded",
                                  code="unexpected_redirect", status=response.status_code)
        if response.status_code >= 400:
            raise _error_from(response)
        return response

    # ----------------------------------------------------------------- REST

    def get_json(self, path: str, *, authenticated: bool = True) -> Any:
        headers = {"Accept": "application/json", **(self._auth_headers() if authenticated else {})}
        with self._http() as http:
            response = self._check(http.get(self._url(path), headers=headers))
        payload = response.json()
        if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
            return payload["data"]
        return payload

    def capabilities(self) -> dict[str, Any]:
        return self.get_json("/v1/capabilities", authenticated=False)

    def rights_policy(self) -> dict[str, Any]:
        return self.get_json("/v1/rights-attestation", authenticated=False)

    def balance(self) -> dict[str, Any]:
        return self.get_json("/v1/billing/balance")

    def upload_asset(self, *, path: Path, project_id: str, kind: str, content_type: str,
                     rights_version: str, idempotency_key: str,
                     duration_ms: Optional[int] = None) -> dict[str, Any]:
        data = path.read_bytes()
        query = urlencode({"projectId": project_id, "kind": kind, "filename": path.name})
        headers = {
            **self._auth_headers(),
            "Content-Type": content_type,
            "Idempotency-Key": idempotency_key,
            "X-Slopcannon-Rights-Attestation": rights_version,
            "X-Content-SHA256": hashlib.sha256(data).hexdigest(),
        }
        if duration_ms:
            headers["X-Media-Duration-Ms"] = str(int(duration_ms))
        with self._http(_UPLOAD_TIMEOUT) as http:
            response = self._check(http.post(self._url(f"/v1/assets?{query}"), headers=headers, content=data))
        return response.json()

    def download(self, url: str, dest: Path) -> dict[str, Any]:
        """Stream ``url`` to ``dest``. Own-origin URLs carry the token; others are capability links."""
        parts = urlsplit(url)
        if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in {"127.0.0.1", "localhost"}):
            raise SlopcannonError("download URL is not HTTPS", code="insecure_url")
        own = f"{parts.scheme}://{parts.netloc}" == self.origin
        headers = {"Accept": "video/mp4,application/octet-stream", **(self._auth_headers() if own else {})}
        dest.parent.mkdir(parents=True, exist_ok=True)
        partial = dest.with_suffix(dest.suffix + ".part")
        digest = hashlib.sha256()
        size = 0
        with self._http(_DOWNLOAD_TIMEOUT) as http:
            with http.stream("GET", url, headers=headers) as response:
                if response.status_code >= 300:
                    response.read()
                    self._check(response)
                with partial.open("wb") as handle:
                    for chunk in response.iter_bytes(1 << 20):
                        handle.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
        partial.replace(dest)
        return {"path": str(dest), "bytes": size, "sha256": digest.hexdigest()}

    # ----------------------------------------------------------------- MCP

    def mcp(self, method: str, params: Optional[dict[str, Any]] = None,
            timeout: httpx.Timeout = _TIMEOUT) -> Any:
        body = {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params or {}}
        headers = {
            **self._auth_headers(),
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        with self._http(timeout) as http:
            response = http.post(self._url("/api/mcp"), headers=headers, content=json.dumps(body))
        if 300 <= response.status_code < 400:
            self._check(response)
        envelope = _parse_rpc(response)
        if envelope is None:
            raise _error_from(response) if response.status_code >= 400 else SlopcannonError(
                f"SLOPCANNON returned HTTP {response.status_code} without a JSON-RPC body", code="bad_response")
        if envelope.get("error"):
            err = envelope["error"]
            raise SlopcannonError(str(err.get("message") or "MCP error"), code=str(err.get("code", "mcp_error")),
                                  status=response.status_code, details=err.get("data"))
        if response.status_code >= 400:
            raise _error_from(response)
        return envelope.get("result")

    def list_tools(self) -> list[dict[str, Any]]:
        tools: list[dict[str, Any]] = []
        cursor: Optional[str] = None
        for _ in range(20):
            result = self.mcp("tools/list", {"cursor": cursor} if cursor else {}) or {}
            tools.extend(result.get("tools") or [])
            cursor = result.get("nextCursor")
            if not cursor:
                break
        return tools

    def call_tool(self, name: str, arguments: Optional[dict[str, Any]] = None,
                  timeout: httpx.Timeout = _TIMEOUT) -> Any:
        result = self.mcp("tools/call", {"name": name, "arguments": arguments or {}}, timeout=timeout) or {}
        if result.get("isError"):
            structured = result.get("structuredContent") or {}
            error = structured.get("error") if isinstance(structured, dict) else None
            if isinstance(error, dict):
                raise SlopcannonError(str(error.get("message") or "tool call failed"),
                                      code=str(error.get("code") or "tool_error"), details=error.get("details"))
            text = " ".join(c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict))
            raise SlopcannonError(text.strip() or f"{name} failed", code="tool_error")
        if "structuredContent" in result:
            return result["structuredContent"]
        texts = [c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"]
        joined = "\n".join(texts)
        try:
            return json.loads(joined)
        except (ValueError, TypeError):
            return joined


def _parse_rpc(response: httpx.Response) -> Optional[dict[str, Any]]:
    content_type = response.headers.get("content-type", "")
    text = response.text
    if "text/event-stream" in content_type:
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    candidate = json.loads(line[5:].strip())
                except ValueError:
                    continue
                if isinstance(candidate, dict) and ("result" in candidate or "error" in candidate):
                    return candidate
        return None
    try:
        payload = json.loads(text)
    except ValueError:
        return None
    return payload if isinstance(payload, dict) and ("result" in payload or "error" in payload) else None
