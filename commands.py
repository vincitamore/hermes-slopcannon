"""``/slop`` in a session and ``hermes slopcannon`` in a terminal."""
from __future__ import annotations

import argparse
import getpass
import json
import sys
import threading
from typing import Any

from . import auth, server_tools, settings
from .client import Client, SlopcannonError

_LOCAL_SURFACES = {"cli", "tui", "desktop", "acp"}
_login_lock = threading.Lock()

HELP = (
    "/slop status   connection, balance and service readiness\n"
    "/slop login    connect your SLOPCANNON account (opens slop.cc in your browser)\n"
    "/slop logout   forget the stored SLOPCANNON token on this machine\n"
    "/slop sync     refresh the SLOPCANNON tool list from the server (next session)"
)


def _status_text() -> str:
    summary = auth.token_summary()
    lines = [f"SLOPCANNON: {'connected' if summary['connected'] else 'not connected'}"
             + (f" ({summary['token_prefix']}, via {summary['via']})" if summary["connected"] else "")]
    client = Client()
    try:
        runtime = client.capabilities().get("hostedRuntime") or {}
        lines.append(f"service: {runtime.get('status')}, submissions "
                     f"{'open' if runtime.get('submissionReady') else 'closed'}")
    except Exception as exc:  # status must never raise into the UI
        lines.append(f"service: unreachable ({exc})")
    if summary["connected"]:
        try:
            balance = client.balance()
            lines.append("balance: " + json.dumps(balance, separators=(",", ":"))[:300])
        except SlopcannonError as exc:
            lines.append(f"balance: {exc}")
    else:
        lines.append("Run /slop login to connect.")
    return "\n".join(lines)


def _surface() -> str:
    ctx = settings.context()
    try:
        return str(ctx.session_surface()) if ctx is not None else "cli"
    except Exception:
        return "cli"


def _login_in_background() -> str:
    if not _login_lock.acquire(blocking=False):
        return "A SLOPCANNON sign-in is already waiting in your browser."

    def run() -> None:
        try:
            auth.login(say=lambda _msg: None)
        except Exception:
            pass
        finally:
            _login_lock.release()

    threading.Thread(target=run, name="slopcannon-login", daemon=True).start()
    return ("Opening slop.cc in your browser to connect SLOPCANNON. Approve there, then run "
            "/slop status. Tools see the new connection on the next call.")


def slash(raw_args: str = "", **_: Any) -> str:
    verb = (raw_args or "").strip().split(" ", 1)[0].lower() or "status"
    if verb == "status":
        return _status_text()
    if verb == "login":
        surface = _surface()
        if surface not in _LOCAL_SURFACES:
            return ("Sign-in opens a browser on the machine Hermes runs on, so it cannot start from "
                    f"{surface}. On that machine run `hermes slopcannon login`, or "
                    "`hermes slopcannon login --token-stdin` with a token from slop.cc/account. "
                    "Never paste a token into chat.")
        return _login_in_background()
    if verb == "logout":
        auth.clear_token()
        return "SLOPCANNON token removed from this machine. Revoke it at slop.cc/account if needed."
    if verb == "sync":
        try:
            count = server_tools.refresh()
        except SlopcannonError as exc:
            return f"Sync failed: {exc}"
        return f"Synced {count} SLOPCANNON tools. They load in your next session."
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
