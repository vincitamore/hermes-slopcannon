"""SLOPCANNON for Hermes Agent.

Registers every hosted SLOPCANNON tool natively (``server_tools.py``), the local
media-plane tools (``tools.py``), whole productions (``production_tools.py``),
the spend/rights/irreversible-action gate, ``/slop``, ``hermes slopcannon`` and
the bundled skills. The desktop studio is ``desktop/plugin.js`` with its backend
in ``dashboard/plugin_api.py``.
"""
from __future__ import annotations

import logging
from pathlib import Path

from . import commands, gate, production_tools, server_tools, settings, tools

logger = logging.getLogger(__name__)
_SKILLS = Path(__file__).parent / "skills"
TOOLSET = "slopcannon"


def register(ctx) -> None:
    settings.bind(ctx)
    local = [*tools.TOOLS, *production_tools.TOOLS]
    local_names = {spec.name for spec in local}
    for spec in local:
        ctx.register_tool(name=spec.name, toolset=TOOLSET, schema=spec.schema, handler=spec.handler,
                          description=spec.schema["description"])
    for name, schema, handler in server_tools.specs(local_names):
        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler,
                          description=schema["description"])
    ctx.register_hook("pre_tool_call", gate.pre_tool_call)
    ctx.register_command("slop", commands.slash, description="SLOPCANNON: status, login, logout, sync",
                         args_hint="[status|login|logout|sync]")
    ctx.register_cli_command("slopcannon", "SLOPCANNON account connection", commands.setup_cli,
                             commands.run_cli, description="Connect, inspect, sync or disconnect SLOPCANNON")
    if _SKILLS.is_dir():
        for child in sorted(_SKILLS.iterdir()):
            skill_md = child / "SKILL.md"
            if child.is_dir() and skill_md.is_file():
                ctx.register_skill(child.name, skill_md)
