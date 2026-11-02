"""Every SLOPCANNON server tool as a native Hermes tool.

The hosted MCP server is the contract. Its tool list is snapshotted into
``data/server_tools.json`` (refreshed by ``scripts/sync_server_tools.py`` and by
``hermes slopcannon sync`` / ``/slop sync`` into plugin state), and each entry is
registered under its own name with its own schema, so the agent sees the whole
product. Hermes defers non-core plugin tools behind ``tool_search``, so the full
surface costs nothing until used.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from . import settings
from .client import Client, SlopcannonError

SNAPSHOT = Path(__file__).parent / "data" / "server_tools.json"
_STATE_KEY = "server_tools"


def normalize(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for tool in tools:
        name = tool.get("name")
        if not isinstance(name, str) or not name.startswith("slopcannon_"):
            continue
        schema = dict(tool.get("inputSchema") or {"type": "object", "properties": {}})
        schema.pop("$schema", None)
        schema.setdefault("type", "object")
        out.append({
            "name": name,
            "title": tool.get("title") or "",
            "description": tool.get("description") or tool.get("title") or name,
            "inputSchema": schema,
            "annotations": tool.get("annotations") or {},
        })
    return sorted(out, key=lambda t: t["name"])


def write_snapshot(tools: list[dict[str, Any]]) -> None:
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(json.dumps({"tools": tools}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def load() -> list[dict[str, Any]]:
    """The bundled tool set, with a synced copy's newer descriptions and schemas where it has them.

    The set of tools is the bundled snapshot's, which ``plugin.yaml`` declares and the catalog
    reviewed at the pinned commit (catalog rule 6). A synced copy can refresh those tools and drop
    any the server has retired, but a tool it alone lists waits for a plugin release.
    """
    bundled = _bundled()
    cached = settings.state_get(_STATE_KEY)
    if not (isinstance(cached, dict) and isinstance(cached.get("tools"), list) and cached["tools"]):
        return bundled
    declared = {tool["name"] for tool in bundled}
    synced = [tool for tool in cached["tools"] if isinstance(tool, dict) and tool.get("name") in declared]
    return synced or bundled


def _bundled() -> list[dict[str, Any]]:
    if SNAPSHOT.is_file():
        return json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("tools") or []
    return []


def refresh() -> int:
    """Fetch the live list into plugin state; takes effect in the next session, for declared tools only."""
    tools = normalize(Client().list_tools())
    if not tools:
        raise SlopcannonError("the server listed no tools", code="empty_tool_list")
    settings.state_set(_STATE_KEY, {"tools": tools})
    declared = {tool["name"] for tool in _bundled()}
    return sum(1 for tool in tools if tool["name"] in declared)


def _handler(name: str) -> Callable[..., str]:
    def handler(args: dict[str, Any], **_: Any) -> str:
        try:
            result = Client().call_tool(name, args or {})
            return json.dumps({"ok": True, "result": result}, default=str)
        except SlopcannonError as exc:
            return json.dumps(exc.to_dict(), default=str)
        except Exception as exc:
            return json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)})
    return handler


def specs(local_names: set[str]) -> list[tuple[str, dict[str, Any], Callable[..., str]]]:
    out = []
    for tool in load():
        name = tool["name"]
        if name in local_names:
            continue
        schema = {"name": name, "description": tool["description"], "parameters": tool["inputSchema"]}
        out.append((name, schema, _handler(name)))
    return out
