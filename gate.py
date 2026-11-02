"""The human gate in front of every SLOPCANNON call that spends, signs or destroys.

Hermes's ``pre_tool_call`` hook may return ``{"action": "approve", ...}``, which
routes the call through the same human-approval gate as a dangerous shell
command (CLI prompt, desktop dialog, gateway buttons; fail-closed with nobody
present). The model cannot skip it. The server still enforces its own rules:
a submission must echo the exact quoted debit, so an approval prompt that
shows the model's figure cannot be used to buy at a different price.

The gate covers this plugin's own tools and, by name suffix, the same tools
reached through a SLOPCANNON MCP server entry (``mcp_<server>_slopcannon_*``).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional

from . import settings

# MCP tool -> argument that carries the person-approved credit amount.
SPENDING: dict[str, str] = {
    "slopcannon_submit_generation": "approval.amountUnits",
    "slopcannon_create_audio_spot": "maxCredits",
    "slopcannon_create_ad_pitch": "maxCredits",
}
# MCP tools that record the person's own rights sign-off.
RIGHTS: set[str] = {"slopcannon_import_character", "slopcannon_create_audio_spot"}
# MCP tools whose effect is irreversible or public.
DESTRUCTIVE: dict[str, str] = {
    "slopcannon_delete_take": "permanently deletes a take's stored video",
    "slopcannon_publish_character": "publishes a character publicly on character.slop.cc",
    "slopcannon_unpublish_character": "unpublishes a character and revokes its public pages",
}


def _inner_tool(tool_name: str, args: dict[str, Any]) -> tuple[Optional[str], dict[str, Any]]:
    """(slopcannon server tool name, its arguments) for a native or MCP-catalog call, else (None, {})."""
    if tool_name.startswith("slopcannon_"):
        return tool_name, args
    if tool_name.startswith("mcp_"):
        # Hermes names MCP tools mcp_<server>_<tool>; the server name may itself be "slopcannon".
        marker = tool_name.rfind("slopcannon_")
        if marker >= 4:
            return tool_name[marker:], args
    return None, {}


def _dig(data: dict[str, Any], dotted: str) -> Any:
    value: Any = data
    for part in dotted.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def _approvals_bypassed() -> bool:
    try:
        from tools.approval import is_approval_bypass_active

        return bool(is_approval_bypass_active())
    except Exception:
        return False


def _rule_key(*parts: Any) -> str:
    digest = hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]
    return f"slopcannon:{parts[0]}:{digest}"


def _spend_directive(inner: str, inner_args: dict[str, Any]) -> Optional[dict[str, Any]]:
    raw = _dig(inner_args, SPENDING[inner])
    if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0:
        return {"action": "block", "message": (
            f"BLOCKED: {inner} needs the exact person-approved Cannon Credit amount in "
            f"`{SPENDING[inner]}`. Quote first, show the person the price, then call again.")}
    limited = _credit_limits(raw, inner)
    if limited is not None:
        return None if limited["action"] == "allow" else limited
    what = {
        "slopcannon_submit_generation": f"render quote {inner_args.get('quoteId', '?')}",
        "slopcannon_create_audio_spot": f"a {inner_args.get('lengthS', '?')} s audio spot",
        "slopcannon_create_ad_pitch": "an ad pitch pack",
    }[inner]
    key = inner_args.get("quoteId") or inner_args.get("idempotencyKey") or inner_args
    return {
        "action": "approve",
        "message": f"SLOPCANNON: spend up to {raw} Cannon Credits on {what}",
        "rule_key": _rule_key(inner, key, raw),
    }


def _rights_directive(label: str, version: Any, files: list[dict[str, Any]]) -> dict[str, Any]:
    inventory = "; ".join(f"{f['name']} ({f['bytes']} bytes)" for f in files) or "the referenced media"
    return {
        "action": "approve",
        "message": (
            f"SLOPCANNON rights sign-off ({version}) for {label}: {inventory}. Approving confirms the "
            "person owns or is licensed to use this material (slop.cc/v1/rights-attestation)."
        ),
        "rule_key": _rule_key("rights", label, version, files),
    }


def _credit_limits(amount: int, what: str) -> Optional[dict[str, Any]]:
    """Seat ceiling and unattended-allowance checks shared by every spend; None when a person must approve."""
    ceiling = settings.get_int("max_credits_per_action")
    if ceiling and amount > ceiling:
        return {"action": "block", "message": (
            f"BLOCKED: {amount} Cannon Credits for {what} exceeds this seat's ceiling of {ceiling} "
            "(plugins.entries.slopcannon.settings.max_credits_per_action).")}
    if _approvals_bypassed():
        allowance = settings.get_int("auto_approve_max_credits")
        if amount <= allowance:
            return {"action": "allow"}
        return {"action": "block", "message": (
            f"BLOCKED: approvals are bypassed on this session and {amount} Cannon Credits exceeds the "
            f"unattended allowance of {allowance} (settings.auto_approve_max_credits). "
            "Ask the person to approve it in an attended session.")}
    return None


def _produce_directive(args: dict[str, Any]) -> Optional[dict[str, Any]]:
    """One prompt for every human decision a slopcannon_produce call carries."""
    from . import production

    rights, credits = args.get("rights_version"), args.get("approve_credits")
    review, accept = args.get("review_first"), args.get("accept_checks")
    if all(v in (None, "", []) for v in (rights, credits, review, accept)):
        return None
    pid = str(args.get("production_id") or "")
    if not pid:
        return {"action": "block", "message": (
            "BLOCKED: start the production first (without approvals), show the person what it needs, then call "
            "again with its production_id and their answer.")}
    state = production.load_state(pid) or {}
    title = state.get("title") or pid
    detail = state.get("needsDetail") or {}
    parts: list[str] = []
    if rights not in (None, ""):
        files = production.inventory(pid)
        inventory = ", ".join(f"{f['name']} ({f['bytes']:,} bytes)" for f in files) or "its media"
        parts.append(f"rights sign-off {rights} for {inventory}: the person owns or is licensed to use it")
    if credits is not None:
        if not isinstance(credits, int) or isinstance(credits, bool) or credits < 0:
            return {"action": "block", "message": "BLOCKED: approve_credits must be a whole number of Cannon Credits."}
        total = detail.get("totalCannonCredits") if state.get("needs") == "approval" else None
        limited = _credit_limits(credits, f'"{title}"')
        if limited is not None and limited["action"] == "block":
            return limited
        parts.append(f"spend up to {credits:,} Cannon Credits on the whole film"
                     + (f" (quoted total {total:,})" if isinstance(total, int) else ""))
    if review not in (None, ""):
        scene = detail.get("scene") or "the first scene"
        parts.append(f"the person watched {scene} ({str(review)[:12]}) and approves rendering the rest")
    if accept:
        parts.append("keep flagged takes " + ", ".join(str(a) for a in accept))
    return {
        "action": "approve",
        "message": f'SLOPCANNON "{title}": ' + "; ".join(parts),
        "rule_key": _rule_key("produce", pid, rights, credits, review, accept),
    }


def pre_tool_call(tool_name: str = "", args: Optional[dict[str, Any]] = None, **_: Any) -> Optional[dict[str, Any]]:
    args = args or {}
    try:
        if tool_name == "slopcannon_produce":
            directive = _produce_directive(args)
            return None if directive and directive["action"] == "allow" else directive
        if tool_name == "slopcannon_transcribe" and args.get("rights_version"):
            path = Path(str(args.get("song") or "")).expanduser()
            files = [{"name": path.name, "bytes": path.stat().st_size}] if path.is_file() else []
            return _rights_directive("song analysis", args.get("rights_version"), files)
        if tool_name == "slopcannon_upload":
            path = Path(str(args.get("path") or "")).expanduser()
            files = [{"name": path.name, "bytes": path.stat().st_size}] if path.is_file() else []
            return _rights_directive(f"uploading a {args.get('kind', 'file')}", args.get("rights_version"), files)

        inner, inner_args = _inner_tool(tool_name, args)
        if not inner:
            return None
        if inner in SPENDING:
            directive = _spend_directive(inner, inner_args)
            if directive is not None and directive["action"] == "approve" and inner in RIGHTS:
                directive["message"] += (
                    f", and record the person's rights sign-off "
                    f"({inner_args.get('rightsAttestationVersion')}) for its content")
            if directive is not None:
                return directive
            if inner not in RIGHTS:
                return None
        if inner in RIGHTS:
            return _rights_directive(inner.replace("slopcannon_", "").replace("_", " "),
                                     inner_args.get("rightsAttestationVersion"), [])
        if inner in DESTRUCTIVE:
            return {
                "action": "approve",
                "message": f"SLOPCANNON: {inner} {DESTRUCTIVE[inner]}",
                "rule_key": _rule_key(inner, inner_args),
            }
    except Exception as exc:  # fail closed on a gate bug for anything that could spend
        inner, _ = _inner_tool(tool_name, args)
        if tool_name in ("slopcannon_upload", "slopcannon_produce") or (inner and (inner in SPENDING or inner in RIGHTS)):
            return {"action": "block", "message": f"BLOCKED: SLOPCANNON approval gate error: {exc}"}
    return None
