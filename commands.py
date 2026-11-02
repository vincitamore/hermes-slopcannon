"""``/slop`` in a session and ``hermes slopcannon`` in a terminal."""
from __future__ import annotations

import argparse
import getpass
import sys
import threading
from typing import Any

from . import auth, server_tools, settings
from .client import Client, SlopcannonError

_LOCAL_SURFACES = {"cli", "tui", "desktop", "acp"}
_login_lock = threading.Lock()

HELP = "\n".join([
    "SLOPCANNON",
    "  /slop status   account, credits and service",
    "  /slop login    connect your account (opens slop.cc in your browser)",
    "  /slop logout   forget this machine's SLOPCANNON token",
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

    return "expires " + _dt.datetime.fromtimestamp(epoch).strftime("%d %b %Y").lstrip("0")


def _status_text() -> str:
    summary = auth.token_summary()
    rows = ["SLOPCANNON"]
    if summary["connected"]:
        via = {"oauth": "signed in at slop.cc", "pasted": "account token", "environment": "token from environment"}
        account = " · ".join(part for part in (
            "connected", via.get(summary["via"] or "", summary["via"] or ""), _expiry(summary["expires_at"])) if part)
        rows.append(_row("account", account))
    else:
        rows.append(_row("account", "not connected · run /slop login"))

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


def _surface() -> str:
    ctx = settings.context()
    try:
        return str(ctx.session_surface()) if ctx is not None else "cli"
    except Exception:
        return "cli"


def _login_in_background() -> str:
    if not _login_lock.acquire(blocking=False):
        return "\n".join(["SLOPCANNON", _row("sign-in", "already waiting in your browser")])

    def run() -> None:
        try:
            auth.login(say=lambda _msg: None)
        except Exception:
            pass
        finally:
            _login_lock.release()

    threading.Thread(target=run, name="slopcannon-login", daemon=True).start()
    return "\n".join(["SLOPCANNON", _row("sign-in", "opening slop.cc in your browser"),
                      _row("next", "approve there, then /slop status")])


def slash(raw_args: str = "", **_: Any) -> str:
    verb = (raw_args or "").strip().split(" ", 1)[0].lower() or "status"
    if verb == "status":
        return _status_text()
    if verb == "login":
        surface = _surface()
        if surface not in _LOCAL_SURFACES:
            return "\n".join(["SLOPCANNON", _row("sign-in", f"needs a browser on the Hermes machine, not {surface}"),
                              _row("instead", "run `hermes slopcannon login` on that machine"),
                              _row("headless", "`hermes slopcannon login --token-stdin` with a slop.cc/account token"),
                              _row("never", "paste a token into chat")])
        return _login_in_background()
    if verb == "logout":
        auth.clear_token()
        return "\n".join(["SLOPCANNON", _row("account", "disconnected on this machine"),
                          _row("revoke", "slop.cc/account, to end the token everywhere")])
    if verb == "sync":
        try:
            count = server_tools.refresh()
        except SlopcannonError as exc:
            return "\n".join(["SLOPCANNON", _row("sync", f"failed ({exc})")])
        return "\n".join(["SLOPCANNON", _row("sync", f"{count} tools · they load in your next session")])
    return HELP


# --------------------------------------------------------------------------- CLI


def setup_cli(parser: argparse.ArgumentParser) -> None:
    sub = parser.add_subparsers(dest="slop_command")
    login = sub.add_parser("login", help="Connect your SLOPCANNON account")
    login.add_argument("--no-browser", action="store_true", help="Print the sign-in URL instead of opening it")
    login.add_argument("--token-stdin", action="store_true",
                       help="Store a token from slop.cc/account read from stdin (headless seats)")
    sub.add_parser("logout", help="Forget the stored token")
    sub.add_parser("status", help="Connection, balance and service readiness")
    sub.add_parser("sync", help="Refresh the server tool list into plugin state")


def run_cli(args: argparse.Namespace) -> int:
    command = getattr(args, "slop_command", None) or "status"
    try:
        if command == "login":
            if getattr(args, "token_stdin", False):
                token = sys.stdin.readline() if not sys.stdin.isatty() else getpass.getpass("SLOPCANNON token: ")
                summary = auth.store_pasted_token(token)
            else:
                summary = auth.login(open_browser=not getattr(args, "no_browser", False))
            print(f"Connected ({summary['token_prefix']}).")
            print(_status_text())
            return 0
        if command == "logout":
            auth.clear_token()
            print("SLOPCANNON token removed.")
            return 0
        if command == "sync":
            print(f"Synced {server_tools.refresh()} SLOPCANNON tools; they load in the next session.")
            return 0
        print(_status_text())
        return 0
    except auth.LoginError as exc:
        print(f"Sign-in failed: {exc}", file=sys.stderr)
        return 1
    except SlopcannonError as exc:
        print(f"SLOPCANNON: {exc}", file=sys.stderr)
        return 1
