"""Refresh data/server_tools.json from the live SLOPCANNON MCP server (read-only: tools/list).

The plugin registers every server tool from this snapshot at load, with no network at
startup. Run after the server ships new tools:

    python scripts/sync_server_tools.py            # write the snapshot
    python scripts/sync_server_tools.py --check    # exit 1 when the live server has drifted
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("slopcannon_plugin", ROOT / "__init__.py",
                                              submodule_search_locations=[str(ROOT)])
mod = importlib.util.module_from_spec(spec)
sys.modules["slopcannon_plugin"] = mod
spec.loader.exec_module(mod)
from slopcannon_plugin import server_tools  # noqa: E402
from slopcannon_plugin.client import Client  # noqa: E402

live = server_tools.normalize(Client().list_tools())
path = server_tools.SNAPSHOT
if "--check" in sys.argv:
    current = json.loads(path.read_text(encoding="utf-8"))["tools"] if path.exists() else []
    drift = sorted({t["name"] for t in live} ^ {t["name"] for t in current})
    changed = sorted(t["name"] for t in live
                     if any(c["name"] == t["name"] and c != t for c in current))
    print(json.dumps({"added_or_removed": drift, "changed": changed}, indent=1))
    sys.exit(1 if drift or changed else 0)
server_tools.write_snapshot(live)
import re  # noqa: E402

from slopcannon_plugin import tools as local_tools  # noqa: E402

manifest = ROOT / "plugin.yaml"
names = [s.name for s in local_tools.TOOLS] + [t["name"] for t in live]
block = "provides_tools:\n" + "".join(f"  - {n}\n" for n in names)
manifest.write_text(re.sub(r"provides_tools:\n(?:  - .*\n)+", block, manifest.read_text(encoding="utf-8")),
                    encoding="utf-8", newline="\n")
print(f"wrote {len(live)} tools to {path} and {len(names)} names to plugin.yaml")
