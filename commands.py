"""``/slop`` in a session and ``hermes slopcannon`` in a terminal."""
from __future__ import annotations

import argparse
import sys
from typing import Any

from . import auth, server_tools
from .client import Client, SlopcannonError

HELP = "\n".join([
    "SLOPCANNON",
    "  /slop status   account, credits and service",
    "  /slop login    how to connect your account (a terminal command)",
    "  /slop logout   how to disconnect it",
    "  /slop sync     refresh the tool list from the server (applies next session)",
])

_LABEL_WIDTH = 10


def _row(label: str, value: str) -> str:
    return f"  {label:<{_LABEL_WIDTH}} {value}"


def _credits(value: Any) -> str:
    return f"{value:,}" if isinstance(value, int) and not isinstance(value, bool) else "?"


def _expiry(epoch: Any) -> str:
    if not isinstance(epoch, (int, float)):
        return ""
    import datetime as _dt

    return "session until " + _dt.datetime.fromtimestamp(epoch).strftime("%H:%M")


_VIA = {auth.VIA_SIGN_IN: "Hermes sign-in", auth.VIA_PERSONAL: "personal token"}


def _status_text() -> str:
    summary = auth.token_summary()
    rows = ["SLOPCANNON"]
    if summary["connected"]:
        via = summary.get("via") or ""
        account = " · ".join(part for part in (
            "connected", _VIA.get(via, via), _expiry(summary.get("expires_at"))) if part)
        rows.append(_row("account", account))
    elif summary.get("error"):
        rows.append(_row("account", f"not connected ({summary['error']})"))
        rows.append(_row("why", str(summary.get("message") or "")))
    else:
        rows.append(_row("account", "not connected · /slop login shows how"))

    client = Client()
    if summary["connected"]:
        try:
            balance = client.balance()
            available, reserved = balance.get("availableCredits"), balance.get("reservedCredits")
            credits = f"{_credits(available)} available"
            if isinstance(reserved, int) and reserved:
                credits += f" · {_credits(reserved)} held for running work"
            if balance.get("scope") == "organization-customer":
                credits += " · organization allowance"
            rows.append(_row("credits", credits))
        except SlopcannonError as exc:
            rows.append(_row("credits", f"unavailable ({exc})"))

    try:
        runtime = client.capabilities().get("hostedRuntime") or {}
        status = str(runtime.get("status") or "unknown")
        rows.append(_row("service", " · ".join([
            status,
            "rendering open" if runtime.get("submissionReady") else "rendering paused",
        ])))
    except Exception as exc:  # status must never raise into the UI
        rows.append(_row("service", f"unreachable ({type(exc).__name__})"))

    if summary["connected"]:
        rows.append(_row("top-up", "slop.cc/account#buy-credits"))
    return "\n".join(rows)


def login_text() -> str:
    """Sign-in is Hermes's, in a terminal: a plugin never runs an OAuth flow (catalog rule 11)."""
    return "\n".join(["SLOPCANNON", *(_row(label, text) for label, text in auth.sign_in_help()),
                      _row("then", "/slop status")])


def logout_text() -> str:
    auth.reset()  # the in-memory session; nothing else is stored by the plugin
    return "\n".join([
        "SLOPCANNON",
        _row("sign-out", f"run `{auth.SIGN_OUT_COMMAND}` in a terminal"),
        _row("token", "clear the Agent token plugin setting if you entered one"),
        _row("revoke", "slop.cc/account ends the connection everywhere"),
    ])


def slash(raw_args: str = "", **_: Any) -> str:
    verb = (raw_args or "").strip().split(" ", 1)[0].lower() or "status"
    if verb == "status":
        return _status_text()
    if verb == "login":
        return login_text()
    if verb == "logout":
        return logout_text()
    if verb == "sync":
        try:
            count = server_tools.refresh()
        except SlopcannonError as exc:
            return "\n".join(["SLOPCANNON", _row("sync", f"failed ({exc})")])
        return "\n".join(["SLOPCANNON", _row("sync", f"{count} tools · they load in your next session")])
    return HELP


# --------------------------------------------------------------------------- CLI

_CLI_SESSION_TTL_S = 15 * 60  # a one-shot command: its session lapses soon after it exits


def setup_cli(parser: argparse.ArgumentParser) -> None:
    sub = parser.add_subparsers(dest="slop_command")
    sub.add_parser("login", help=f"How to connect your SLOPCANNON account (`{auth.SIGN_IN_COMMAND}`)")
    sub.add_parser("logout", help=f"How to disconnect it (`{auth.SIGN_OUT_COMMAND}`)")
    sub.add_parser("status", help="Connection, balance and service readiness")
    sub.add_parser("sync", help="Refresh the server tool list into plugin state")


def run_cli(args: argparse.Namespace) -> int:
    command = getattr(args, "slop_command", None) or "status"
    if command == "login":
        print(login_text())
        return 0
    if command == "logout":
        print(logout_text())
        return 0
    auth.set_session_ttl(_CLI_SESSION_TTL_S)
    try:
        if command == "sync":
            print(f"Synced {server_tools.refresh()} SLOPCANNON tools; they load in the next session.")
            return 0
        print(_status_text())
        return 0
    except SlopcannonError as exc:
        print(f"SLOPCANNON: {exc}", file=sys.stderr)
        return 1
