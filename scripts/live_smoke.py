"""Read-only live smoke against the real service with this seat's token. Spends nothing.

Run with the Hermes venv's python from the plugin root:  python scripts/live_smoke.py
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
from slopcannon_plugin import server_tools, tools  # noqa: E402

READ_ONLY = ("slopcannon_capabilities", "slopcannon_list_generations", "slopcannon_list_characters")


def short(value: object, n: int = 300) -> str:
    text = json.dumps(value, default=str)
    return text if len(text) <= n else text[:n] + "..."


local = {t.name: t.handler for t in tools.TOOLS}
remote = {name: handler for name, _, handler in server_tools.specs(set(local))}
account = json.loads(local["slopcannon_account"]({}))
print("account:", short({k: account.get(k) for k in ("ok", "connection", "service")}))
print(f"registered: {len(local)} local + {len(remote)} server tools")
for name in READ_ONLY:
    out = json.loads(remote[name]({}))
    print(f"{name}: ok={out.get('ok')}", short(out.get("result") or out))
