"""The human gate in front of every SLOPCANNON call that spends, signs or destroys.

Hermes's ``pre_tool_call`` hook may return ``{"action": "approve", ...}``, which
routes the call through the same human-approval gate as a dangerous shell
command (CLI prompt, desktop dialog, gateway buttons; fail-closed with nobody
present). The model cannot skip it. The server still enforces its own rules:
a submission must echo the exact quoted debit, so an approval prompt that
shows the model's figure cannot be used to buy at a different price.

When no person can be asked (approvals bypassed, or the call runs inside a
cron job) the gate decides by itself: a spend at or under the
``unattended_max_credits`` setting proceeds, a larger one is blocked, and a
rights sign-off is always blocked, because it is a person's own attestation.

The gate covers this plugin's own tools and, by name suffix, the same tools
reached through a SLOPCANNON MCP server entry (``mcp_<server>_slopcannon_*``).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import unquote

from . import settings

logger = logging.getLogger(__name__)

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


# --------------------------------------------------------------------------- who is present

# Why Hermes's bypass check could not be loaded, once it failed; "" while it works (or was never needed).
_bypass_unavailable = ""


def _bypass_check() -> Optional[Callable[[], Any]]:
    """Hermes's YOLO / approvals-off check, or None when this Hermes does not have it where we look.

    ``tools.approval`` is Hermes internals with no public alternative; a failure to import it is
    recorded and logged once rather than retried on every tool call.
    """
    global _bypass_unavailable
    if _bypass_unavailable:
        return None
    try:
        from tools.approval import is_approval_bypass_active
    except Exception as exc:
        _bypass_unavailable = f"{type(exc).__name__}: {exc}"
        logger.warning("SLOPCANNON cannot see whether Hermes approvals are bypassed (%s). The gate treats "
                       "approvals as active, so Hermes's own approval prompt decides each spend; under YOLO "
                       "only max_credits_per_action still limits them.", _bypass_unavailable)
        return None
    return is_approval_bypass_active


def bypass_check_available() -> bool:
    """False when Hermes's bypass check could not be loaded (``/slop status`` says so)."""
    return _bypass_check() is not None


def bypass_check_problem() -> str:
    """Why the bypass check is unavailable, or "" when it works."""
    _bypass_check()
    return _bypass_unavailable


def _approvals_bypassed() -> bool:
    """True when Hermes approvals are bypassed on this session (``--yolo``, ``/yolo``, ``approvals.mode: off``).

    When the check is unavailable this returns False: the gate then hands its approve directives to
    Hermes, whose own prompt applies (and which a real bypass would approve without asking, bounded only
    by ``max_credits_per_action``). It never fails open silently: the failure is logged once and shown
    by ``/slop status``.
    """
    check = _bypass_check()
    if check is None:
        return False
    try:
        return bool(check())
    except Exception:
        logger.debug("Hermes's approval bypass check raised; treating approvals as active.", exc_info=True)
        return False


def _in_cron() -> bool:
    """True when this call runs inside a Hermes cron job (the bound PluginContext's public check).

    A Hermes without the check, or one whose check fails, reads as "not cron": Hermes then applies its
    own ``approvals.cron_mode`` (deny by default) to every approval this gate asks for.
    """
    current = getattr(settings.context(), "current_cron_execution", None)
    if not callable(current):
        return False
    try:
        return current() is not None
    except Exception:
        logger.debug("ctx.current_cron_execution() raised; treating the call as attended.", exc_info=True)
        return False


def _unattended() -> str:
    """Why no person can be asked about this call, or "" when one can."""
    if _approvals_bypassed():
        return "approvals are bypassed on this session"
    if _in_cron():
        return "this call runs inside a cron job"
    return ""


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


def _rights_unattended(why: str) -> dict[str, Any]:
    return {"action": "block", "message": (
        f"BLOCKED: a rights sign-off is a person's own legal attestation, and {why}. Nobody can sign it "
        "for them: ask the person to sign it in an attended session.")}


def _rights_directive(label: str, version: Any, files: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    why = _unattended()
    if why:  # checked first: a call that carries a sign-off is never sent unattended, even a repeated one
        return _rights_unattended(why)
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
    """Seat ceiling and unattended-allowance checks shared by every spend; None when a person must approve.

    The ceiling (``max_credits_per_action``) always applies. When no person can be asked, a spend at or
    under ``unattended_max_credits`` is allowed and a larger one is blocked.
    """
    ceiling = settings.get_int("max_credits_per_action")
    if ceiling and amount > ceiling:
        return {"action": "block", "message": (
            f"BLOCKED: {amount} Cannon Credits for {what} exceeds this seat's ceiling of {ceiling} "
            "(plugins.entries.slopcannon.settings.max_credits_per_action).")}
    why = _unattended()
    if why:
        allowance = settings.get_int("unattended_max_credits")
        if amount <= allowance:
            return {"action": "allow"}
        return {"action": "block", "message": (
            f"BLOCKED: {why}, so no person can approve it, and {amount} Cannon Credits for {what} exceeds the "
            f"unattended allowance of {allowance} (settings.unattended_max_credits). "
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
    allowed = 0  # how many of the parts are spends the unattended allowance already covers
    rights_block = ""
    signed = (state.get("decisions") or {}).get("rights_version") == rights
    if rights not in (None, "") and not signed:  # a version this production already holds is never asked again
        why = _unattended()
        if why:
            return _rights_unattended(why)
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
        allowed += limited is not None
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
        allowed += limited is not None
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
    if parts and allowed == len(parts) and not rights_block:  # unattended spends within the allowance only
        return {"action": "allow"}
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


# --------------------------------------------------------------------------- the plugin's own files

# The film card's decision routes (a person's click, never the agent's), then the production files and the
# installed driver. Built from parts so that editing this file is not itself refused by the check below.
_CARD_ROUTE = "/".join(("api", "plugins", "slopcannon"))
_PRIVATE = ("/".join(("plugin-data", "slopcannon")), "/".join(("plugins", "slopcannon", "")), _CARD_ROUTE)

# Tools that act on files, processes or the network: the private-paths rules apply to them. Any tool in
# neither list is treated as acting too (fail safe), so this list documents the known ones.
_ACTING: frozenset[str] = frozenset({
    "terminal", "process", "process_manage", "read_terminal", "execute_code", "read_file", "write_file",
    "patch", "search_files", "web_extract", "computer_use", "cronjob", "cronjob_manage", "tool_call",
})
_ACTING_PREFIXES: tuple[str, ...] = ("browser_", "mcp_")
# Tools whose arguments are only text for a model or a person: a brief, a question, a note, a plan, a skill.
# Quoting a route or a folder there reaches nothing, so they are never refused for it. A cron job's prompt is
# not here: it runs later with tools, so cron tools count as acting.
_TEXT_ONLY: frozenset[str] = frozenset({
    "delegate_task", "clarify", "memory", "todo", "todo_list", "session_search", "skill_view", "skills_list",
    "skill_manage", "tool_search", "tool_describe",
})


def _acts(tool_name: str) -> bool:
    """True when the tool can act on files, processes or the network (unknown tools count as acting)."""
    if tool_name in _ACTING or tool_name.startswith(_ACTING_PREFIXES):
        return True
    return tool_name not in _TEXT_ONLY


def _normalised(args: dict[str, Any]) -> str:
    """The arguments as one lower-case string, URL-decoded once, with every slash forward and single."""
    text = unquote(json.dumps(args, default=str, ensure_ascii=False)).replace("\\", "/").lower()
    text = re.sub(r"/+", "/", text)
    return re.sub(r"/(\./)+", "/", text)


def _private_paths_directive(tool_name: str, args: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Keep a cooperative agent off the film card's buttons and out of the plugin's own files.

    This is advice, not a security boundary: it reads the arguments of tools that can act on files,
    processes or the network (``_acts``) for the card's route and the plugin's folders, after URL-decoding
    once and normalising slashes and case, so a plain or lightly disguised mention is refused. A determined
    caller can still build the string at run time. The card's real boundary is the dashboard session token,
    which the agent never holds. Text-only tools (a delegated brief, a note) may quote these paths freely.

    Hand edits to a ledger can lose a paid job's receipt, and an agent digging through it mid-film is the
    failure the production tools exist to prevent.
    """
    if tool_name.startswith("slopcannon_") or not _acts(tool_name):
        return None
    text = _normalised(args)
    if _CARD_ROUTE in text:  # the film card's buttons: on every seat, the person's click only
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
    except Exception as exc:  # fail closed on a gate bug for anything that could spend, sign or destroy
        inner, _ = _inner_tool(tool_name, args)
        if tool_name in ("slopcannon_upload", "slopcannon_produce") or (
                inner and (inner in SPENDING or inner in RIGHTS or inner in DESTRUCTIVE)):
            return {"action": "block", "message": f"BLOCKED: SLOPCANNON approval gate error: {exc}"}
    return None
