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
# Per-scene tools that would drive a managed production's project by hand, outside its ledger.
HAND_DRIVEN: set[str] = {
    "slopcannon_create_quote", "slopcannon_slice_scene_audio", "slopcannon_create_render_request",
    "slopcannon_plan_cuts", "slopcannon_direct_scenes", "slopcannon_start_assembly", "slopcannon_select_take",
    "slopcannon_save_workspace", "slopcannon_add_reference", "slopcannon_remove_reference",
    "slopcannon_check_take",
}
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


def _policy(version: Any, known: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """The rights statement the person is signing, verbatim: from the production's own gate when it is the
    same version, otherwise from the public rights-attestation endpoint. Empty when neither is reachable."""
    if known and known.get("statement") and known.get("requiredVersion") == version:
        return known
    try:
        from .client import Client

        policy = Client().rights_policy()
        policy = policy.get("data", policy) if isinstance(policy, dict) else {}
        return policy if policy.get("requiredVersion") == version else {}
    except Exception:
        return {}


def rights_text(version: Any, files: list[dict[str, Any]], *, label: str = "",
                known: Optional[dict[str, Any]] = None) -> str:
    """The approval prompt for a rights sign-off: what is uploaded, then the statement itself, so the person
    reads exactly what their Approve click attests. Approving is the sign-off; nothing is asked in chat."""
    policy = _policy(version, known)
    lines = [f"SLOPCANNON rights sign-off ({version})" + (f" for {label}" if label else "")]
    if files:
        lines.append("Files: " + "; ".join(
            f"{f['name']} ({int(f['bytes']):,} bytes)" if isinstance(f.get("bytes"), int) else str(f["name"])
            for f in files))
    statement = str(policy.get("statement") or "").strip()
    if statement:
        lines += ["", f"\u201c{statement}\u201d"]
    else:
        lines += ["", "Approving confirms you own or are licensed to use this material and agree to "
                      "slop.cc's Terms of Service and Acceptable Use Policy."]
    terms = policy.get("termsUrl") or "https://slop.cc/terms"
    aup = policy.get("acceptableUseUrl") or "https://slop.cc/acceptable-use"
    lines += ["", f"Terms: {terms} \u00b7 Acceptable Use: {aup}", "Approve to sign; Deny to stop."]
    return "\n".join(lines)


def _already_signed(version: Any, files: list[dict[str, Any]]) -> bool:
    """True when the person already signed this version for exactly these files: one sign-off is enough."""
    if not version or not files:
        return False
    from . import production

    try:
        signed = production.signed_files(version)
    except Exception:
        return False
    return all((f.get("name"), f.get("bytes")) in signed for f in files)


def _rights_directive(label: str, version: Any, files: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if _already_signed(version, files):
        return None
    return {
        "action": "approve",
        "message": rights_text(version, files, label=label),
        "rule_key": _rule_key("rights", label, version, files),
    }


def _spec_files(spec: Any) -> list[dict[str, Any]]:
    """The local files a production spec names (song, then references), for a sign-off on the first call."""
    if not isinstance(spec, dict):
        return []
    files = []
    for path in [spec.get("song"), *[r.get("path") for r in spec.get("references") or [] if isinstance(r, dict)]]:
        p = Path(str(path or "")).expanduser()
        if path and p.is_file():
            files.append({"name": p.name, "bytes": p.stat().st_size})
    return files


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
    keep = args.get("keep_scene")
    reroll, reroll_units = args.get("reroll"), args.get("approve_reroll")
    pid = str(args.get("production_id") or "")
    spec = args.get("production")
    if reroll not in (None, "", {}, []):
        if not pid:
            return {"action": "block", "message": "BLOCKED: reroll names scenes of a production: pass its production_id."}
        asked = production._reroll_list(reroll)
        problems = [p for p in (production.reroll_problem(pid, a["scene"]) for a in asked) if p]
        if not asked:
            problems.append("reroll needs scene ids, such as [{\"scene\": \"sc03\"}]")
        if problems:
            return {"action": "block", "message": f"BLOCKED: cannot reroll now: {'; '.join(problems)}."}
    if all(v in (None, "", []) for v in (rights, credits, review, accept, reroll_units, keep)):
        return None
    starting = not pid and isinstance(spec, dict)
    if not pid and not starting:
        return {"action": "block", "message": (
            "BLOCKED: pass the production to start (it may carry rights_version), or the production_id of one "
            "already started.")}
    if starting:
        plan = args.get("timed_plan") if isinstance(args.get("timed_plan"), dict) else None
        problems = production.check_production(spec, plan)
        if problems:  # never ask for a sign-off on a production that cannot start
            return {"action": "block", "message": (
                "BLOCKED: fix the production before it starts (nothing was signed or uploaded): "
                + "; ".join(problems))}
    if starting and any(v not in (None, "", []) for v in (credits, review, accept, reroll_units, keep)):
        return {"action": "block", "message": (
            "BLOCKED: a new production can carry only rights_version. Credits, reviews and accepted takes "
            "answer a gate the production has reached; start it, then answer with its production_id.")}
    state = (production.load_state(pid) if pid else None) or {}
    title = state.get("title") or (spec.get("title") if isinstance(spec, dict) else None) or pid
    detail = state.get("needsDetail") or {}
    parts: list[str] = []
    rights_block = ""
    signed = (state.get("decisions") or {}).get("rights_version") == rights
    if rights not in (None, "") and not signed:  # a version this production already holds is never asked again
        files = _spec_files(spec) or (production.inventory(pid) if pid else [])
        rights_block = rights_text(rights, files, known=detail if state.get("needs") == "rights" else None)
    if reroll_units is not None:
        if state.get("needs") != "reroll_approval":
            return {"action": "block", "message": (
                "BLOCKED: approve_reroll answers a reroll's quote. Ask for the reroll first (reroll = {scene, "
                "direction}); the production quotes it and stops for the approval.")}
        quoted = detail.get("amountUnits")
        scenes = ", ".join(str(q.get("scene")) for q in detail.get("quotes") or []) or "the scene"
        if reroll_units != quoted:
            return {"action": "block", "message": (
                f"BLOCKED: approve_reroll must be the quoted total of {quoted} Cannon Credits ({scenes}).")}
        limited = _credit_limits(reroll_units, f"new takes of {scenes}")
        if limited is not None and limited["action"] == "block":
            return limited
        each = "; ".join(f"{q.get('scene')} {q.get('amountUnits')}" for q in detail.get("quotes") or [])
        parts.append(f"spend {reroll_units:,} Cannon Credits on new takes of {scenes} ({each}); they render "
                     "together and the first takes stay available")
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
        parts.append(f"watch {scene} above ({str(review)[:12]}), then Approve to render the rest of the film; "
                     "Deny to stop and change the direction")
    if accept:
        parts.append("keep flagged takes " + ", ".join(str(a) for a in accept))
    if keep not in (None, ""):
        if state.get("needs") != "scene_review" or keep != detail.get("sha256"):
            return {"action": "block", "message": (
                "BLOCKED: keep_scene answers a delivered scene: pass needsDetail.sha256 of the scene it waits on.")}
        scene = detail.get("take") or detail.get("scene") or "this scene"
        parts.append(f"keep {scene} above ({str(keep)[:12]}); the next scene is bought from its last frame")
    message = f'SLOPCANNON "{title}": ' + "; ".join(parts) if parts else ""
    if rights_block:
        message = (message + "\n\n" if message else f'SLOPCANNON "{title}"\n') + rights_block
    if not message:  # only an answer the production already holds (a repeated rights_version): nothing to ask
        return None
    return {
        "action": "approve",
        "message": message,
        "rule_key": _rule_key("produce", pid or title, rights, credits, review, accept, reroll_units, keep,
                              detail.get("quoteIds") if reroll_units is not None else None),
    }


# The production files, the driver, and the film card's decision routes (a person's click, never the agent's).
_PRIVATE = ("plugin-data/slopcannon", "plugins/slopcannon/", "api/plugins/slopcannon")


def _private_paths_directive(tool_name: str, args: dict[str, Any]) -> Optional[dict[str, Any]]:
    """A production's ledger, state and driver are the plugin's own: the agent reads them through the tools.

    Hand edits to a ledger can lose a paid job's receipt, and an agent digging through them mid-film is the
    failure the tools exist to prevent, so any other tool whose arguments name those folders is refused.
    """
    if tool_name.startswith("slopcannon_"):
        return None
    text = json.dumps(args, default=str).replace("\\\\", "/").replace("\\", "/").lower()
    if "api/plugins/slopcannon" in text:  # the film card's buttons: on every seat, the person's click only
        return {"action": "block", "message": (
            "BLOCKED: the SLOPCANNON film card's routes are the person's own buttons. The person answers on the "
            "card; if they answer you in chat, pass their answer to slopcannon_produce.")}
    if str(settings.get("protect_production_files")).lower() in ("false", "0", "no"):
        return None
    if not any(part in text for part in _PRIVATE):
        return None
    return {"action": "block", "message": (
        "BLOCKED: SLOPCANNON's production files and driver belong to the plugin. Read a production with "
        "slopcannon_production_status and resume it with slopcannon_produce (same production_id): it recovers "
        "earlier jobs by itself and never buys them twice. Never open, edit or run them by hand.")}


def pre_tool_call(tool_name: str = "", args: Optional[dict[str, Any]] = None, **_: Any) -> Optional[dict[str, Any]]:
    args = args or {}
    try:
        from . import production

        private = _private_paths_directive(tool_name, args)
        if private is not None:
            return private
        if tool_name == "slopcannon_produce":
            directive = _produce_directive(args)
            return None if directive and directive["action"] == "allow" else directive
        if tool_name == "slopcannon_transcribe" and args.get("rights_version"):
            path = Path(str(args.get("song") or "")).expanduser()
            files = [{"name": path.name, "bytes": path.stat().st_size}] if path.is_file() else []
            return _rights_directive("song analysis", args.get("rights_version"), files)
        if tool_name == "slopcannon_upload" and production.managing(args.get("project_id") or args.get("projectId")):
            return {"action": "block", "message": (
                "BLOCKED: this project belongs to a production that slopcannon_produce drives; its pictures are "
                "already uploaded. Reroll a scene with slopcannon_produce(production_id, reroll={scene, direction}).")}
        if tool_name == "slopcannon_upload":
            path = Path(str(args.get("path") or "")).expanduser()
            files = [{"name": path.name, "bytes": path.stat().st_size}] if path.is_file() else []
            return _rights_directive(f"uploading a {args.get('kind', 'file')}", args.get("rights_version"), files)

        inner, inner_args = _inner_tool(tool_name, args)
        if not inner:
            return None
        if inner in HAND_DRIVEN:
            owner = production.managing(inner_args.get("projectId") or inner_args.get("project_id"))
            if owner:
                return {"action": "block", "message": (
                    f"BLOCKED: this project belongs to the production {owner}, which slopcannon_produce drives. To "
                    f"replace a scene, call slopcannon_produce(production_id=\"{owner}\", reroll={{scene, "
                    "direction}}): it quotes the new take, asks the person, and cuts it into the film. To check "
                    "takes the check skipped, call slopcannon_produce with the production_id: it checks them again.")}
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
