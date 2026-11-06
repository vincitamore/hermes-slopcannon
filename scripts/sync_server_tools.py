"""Refresh data/server_tools.json from the live SLOPCANNON MCP server (read-only: tools/list).

The plugin registers every server tool from this snapshot at load, with no network at
startup. Run after the server ships new tools:

    python scripts/sync_server_tools.py            # write the snapshot and plugin.yaml's provides_tools
    python scripts/sync_server_tools.py --check    # exit 1 when the live server has drifted
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "plugin.yaml"
_PROVIDES = re.compile(r"provides_tools:\n(?:  - .*\n)+")


def load_plugin() -> Any:
    """The plugin package as ``slopcannon_plugin``, loaded from this checkout once."""
    if "slopcannon_plugin" not in sys.modules:
        spec = importlib.util.spec_from_file_location("slopcannon_plugin", ROOT / "__init__.py",
                                                      submodule_search_locations=[str(ROOT)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules["slopcannon_plugin"] = mod
        spec.loader.exec_module(mod)
    return sys.modules["slopcannon_plugin"]


def provides_tools(server: list[dict[str, Any]]) -> list[str]:
    """plugin.yaml's provides_tools: the plugin's own tools in registration order, then the server's."""
    from slopcannon_plugin import production_tools, tools
    local = [spec.name for spec in (*tools.TOOLS, *production_tools.TOOLS)]
    return local + [tool["name"] for tool in server if tool["name"] not in local]


def with_provides_tools(manifest: str, names: list[str]) -> str:
    """The manifest text with its provides_tools list replaced by ``names``."""
    block = "provides_tools:\n" + "".join(f"  - {name}\n" for name in names)
    updated, count = _PROVIDES.subn(lambda _: block, manifest)
    if count != 1:
        raise SystemExit("plugin.yaml has no single provides_tools list to replace")
    return updated


def drift(live: list[dict[str, Any]], current: list[dict[str, Any]]) -> dict[str, list[str]]:
    by_name = {tool["name"]: tool for tool in current}
    return {
        "added_or_removed": sorted({t["name"] for t in live} ^ set(by_name)),
        "changed": sorted(t["name"] for t in live if t["name"] in by_name and by_name[t["name"]] != t),
    }


def main(argv: list[str]) -> int:
    load_plugin()
    from slopcannon_plugin import server_tools
    from slopcannon_plugin.client import Client

    live = server_tools.normalize(Client().list_tools())
    path = server_tools.SNAPSHOT
    if "--check" in argv:
        current = json.loads(path.read_text(encoding="utf-8"))["tools"] if path.exists() else []
        report = drift(live, current)
        print(json.dumps(report, indent=1))
        return 1 if report["added_or_removed"] or report["changed"] else 0
    server_tools.write_snapshot(live)
    names = provides_tools(live)
    MANIFEST.write_text(with_provides_tools(MANIFEST.read_text(encoding="utf-8"), names),
                        encoding="utf-8", newline="\n")
    print(f"wrote {len(live)} tools to {path} and {len(names)} names to plugin.yaml")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
