"""Credential lifetimes and transport failures: driver sessions, the refusal backoff, network errors.

Offline: the Hermes sign-in helper and secret route are the fakes test_plugin installs, and every
HTTP exchange goes through httpx.MockTransport.
Run with the other tests: python -m unittest discover -s tests
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

import test_plugin as tp  # installs the Hermes stubs and loads the plugin package

from slopcannon_plugin import auth, client as client_mod, settings  # noqa: E402

ORIGIN = tp.ORIGIN
NOT_SIGNED_IN = "Not signed in to slop for plugin 'slopcannon'. Run `hermes auth add slopcannon:slop`."


def refusal(status, code):
    return tp.ProviderResponse(status, {"error": {"code": code, "message": "x"}})


class AuthTestBase(unittest.TestCase):
    def setUp(self):
        tp.bind()
        auth.reset()
        auth.set_session_ttl(auth.SESSION_TTL_S)
        self.addCleanup(auth.reset)
        secrets = mock.patch.dict(tp._SECRETS, {}, clear=True)
        secrets.start()
        self.addCleanup(secrets.stop)
        self.calls: list[dict] = []
        self.responses: list = []
        self.now = 1000.0
        clock = mock.patch.object(auth, "_monotonic", lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)

    def helper(self, *responses):
        """Queue sign-in helper answers; a call with none queued fails the test."""
        self.responses = list(responses)

        def fake(provider, method, url, *, json=None, headers=None, timeout=30.0):
            self.calls.append({"provider": provider, "method": method, "url": url, "json": json})
            if not self.responses:
                raise AssertionError("unexpected sign-in request")
            item = self.responses.pop(0)
            if isinstance(item, BaseException):
                raise item
            return item
        patch = mock.patch.object(tp._fake_requests, "credentialed_provider_request", fake)
        patch.start()
        self.addCleanup(patch.stop)


class DriverSessionTest(AuthTestBase):
    def test_a_production_reuses_its_session_while_more_than_an_hour_remains(self):
        self.helper(tp.ProviderResponse(201, tp.session_payload("slop_live_drv", ttl_s=43200)))
        first = auth.driver_token("film-1")
        second = auth.driver_token("film-1")
        self.assertIs(first, second)
        self.assertEqual(first.token, "slop_live_drv")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["json"]["ttlSeconds"], auth.DRIVER_TTL_S)

    def test_a_session_with_under_an_hour_left_is_reminted(self):
        self.helper(tp.ProviderResponse(201, tp.session_payload("slop_live_old", ttl_s=3000)),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_new", ttl_s=43200)))
        self.assertEqual(auth.driver_token("film-1").token, "slop_live_old")
        self.assertEqual(auth.driver_token("film-1").token, "slop_live_new")
        self.assertEqual(auth.driver_token("film-1").token, "slop_live_new")
        self.assertEqual(len(self.calls), 2)

    def test_each_production_has_its_own_session_and_never_the_in_process_one(self):
        self.helper(tp.ProviderResponse(201, tp.session_payload("slop_live_a", ttl_s=43200)),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_b", ttl_s=43200)),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_inproc")))
        self.assertEqual(auth.driver_token("film-a").token, "slop_live_a")
        self.assertEqual(auth.driver_token("film-b").token, "slop_live_b")
        self.assertEqual(auth.get_token(), "slop_live_inproc")
        self.assertEqual(auth.driver_token("film-a").token, "slop_live_a")
        self.assertEqual(len(self.calls), 3)

    def test_forget_driver_drops_the_cached_session(self):
        self.helper(tp.ProviderResponse(201, tp.session_payload("slop_live_1", ttl_s=43200)),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_2", ttl_s=43200)))
        auth.driver_token("film-1")
        auth.forget_driver("film-1")
        auth.forget_driver("never-started")  # unknown ids are fine
        self.assertEqual(auth.driver_token("film-1").token, "slop_live_2")

    def test_reset_and_invalidate_drop_driver_sessions(self):
        self.helper(tp.ProviderResponse(201, tp.session_payload("slop_live_1", ttl_s=43200)),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_2", ttl_s=43200)),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_3", ttl_s=43200)))
        auth.driver_token("film-1")
        auth.reset()
        self.assertEqual(auth.driver_token("film-1").token, "slop_live_2")
        self.assertFalse(auth.invalidate("slop_live_2"))  # not the in-process session: no in-process retry
        self.assertEqual(auth.driver_token("film-1").token, "slop_live_3")

    def test_hosted_driver_gets_a_session_minted_from_the_personal_token(self):
        self.helper(tp.ProviderNotSignedIn(NOT_SIGNED_IN))
        tp._SECRETS[settings.TOKEN_ENV] = "slop_live_personal"
        minted = auth.Credential(token="slop_live_child", via=auth.VIA_PERSONAL,
                                 expires_at=auth.time.time() + 43200, session=True)
        with mock.patch.object(auth, "_mint_with_personal", return_value=minted) as mint:
            self.assertEqual(auth.driver_token("film-2").token, "slop_live_child")
            self.assertEqual(auth.driver_token("film-2").token, "slop_live_child")  # cached: no second mint
        self.assertEqual(mint.call_count, 1)
        self.assertEqual(mint.call_args.args[:2], ("slop_live_personal", auth.DRIVER_TTL_S))

    def test_hosted_driver_never_falls_back_to_the_raw_personal_token(self):
        for code, status in (("AGENT_SESSION_RATE_LIMITED", 429), ("AGENT_SESSIONS_UNAVAILABLE", 503)):
            with self.subTest(code=code):
                auth.reset()
                self.helper(tp.ProviderNotSignedIn(NOT_SIGNED_IN))
                tp._SECRETS[settings.TOKEN_ENV] = "slop_live_personal"
                refused = auth.CredentialError(auth._REFUSALS[code], code.lower(), status)
                with mock.patch.object(auth, "_mint_with_personal", side_effect=refused):
                    with self.assertRaises(auth.CredentialError) as err:
                        auth.driver_token("film-3")
                self.assertEqual(err.exception.code, code.lower())
                self.assertIn("try again later", str(err.exception))
                self.assertIn("never given the personal token", str(err.exception))
                self.assertNotIn("slop_live_personal", str(err.exception))

    def test_a_personal_mint_refusal_is_waited_out_too(self):
        self.helper(tp.ProviderNotSignedIn(NOT_SIGNED_IN), tp.ProviderNotSignedIn(NOT_SIGNED_IN))
        tp._SECRETS[settings.TOKEN_ENV] = "slop_live_personal"
        refused = auth.CredentialError("Too many", "agent_session_rate_limited", 429)
        with mock.patch.object(auth, "_mint_with_personal", side_effect=refused) as mint:
            for _ in range(2):
                with self.assertRaises(auth.CredentialError):
                    auth.driver_token("film-3")
        self.assertEqual(mint.call_count, 1)

    def test_hosted_driver_without_any_credential_is_not_signed_in(self):
        self.helper(tp.ProviderNotSignedIn(NOT_SIGNED_IN))
        with self.assertRaises(auth.NotSignedIn):
            auth.driver_token("film-4")

    def test_a_sign_in_refusal_without_a_personal_token_is_raised(self):
        self.helper(refusal(429, "AGENT_SESSION_RATE_LIMITED"))
        with self.assertRaises(auth.CredentialError) as err:
            auth.driver_token("film-5")
        self.assertEqual(err.exception.code, "agent_session_rate_limited")

    def test_self_hosted_driver_gets_the_personal_token_and_mints_nothing(self):
        tp.bind({"api_origin": "http://127.0.0.1:8787"})
        self.helper()  # any sign-in request fails the test
        tp._SECRETS[settings.TOKEN_ENV] = "slop_live_local"
        with mock.patch.object(auth, "_mint_with_personal", side_effect=AssertionError("minted")):
            cred = auth.driver_token("film-6")
        self.assertEqual((cred.token, cred.via, cred.session), ("slop_live_local", auth.VIA_PERSONAL, False))
        tp._SECRETS.clear()
        with self.assertRaises(auth.NotSignedIn) as err:
            auth.driver_token("film-6")
        self.assertIn("personal token", str(err.exception))
        self.assertEqual(self.calls, [])

    def test_the_driver_docstring_discloses_the_self_hosted_route(self):
        self.assertIn("personal token is the only credential", " ".join(auth.driver_token.__doc__.split()))


class RefusalBackoffTest(AuthTestBase):
    def test_a_rate_limit_is_not_retried_for_a_minute(self):
        self.helper(refusal(429, "AGENT_SESSION_RATE_LIMITED"),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_ok")))
        for _ in range(3):
            with self.assertRaises(auth.CredentialError) as err:
                auth.credential()
            self.assertEqual(err.exception.code, "agent_session_rate_limited")
        self.assertEqual(len(self.calls), 1)
        self.now += 59
        with self.assertRaises(auth.CredentialError):
            auth.credential()
        self.assertEqual(len(self.calls), 1)
        self.now += 2  # the minute is over: one new request
        self.assertEqual(auth.get_token(), "slop_live_ok")
        self.assertEqual(len(self.calls), 2)

    def test_unavailable_server_errors_and_network_failures_back_off(self):
        cases = (refusal(503, "AGENT_SESSIONS_UNAVAILABLE"), refusal(502, ""),
                 refusal(500, "INTERNAL_ERROR"), httpx.ConnectError("refused"))
        for item in cases:
            with self.subTest(item=item):
                auth.reset()
                self.calls.clear()
                self.helper(item)
                for _ in range(2):
                    with self.assertRaises(auth.CredentialError):
                        auth.credential()
                self.assertEqual(len(self.calls), 1)

    def test_status_reads_inside_the_window_send_nothing(self):
        self.helper(refusal(429, "AGENT_SESSION_RATE_LIMITED"))
        for _ in range(3):
            summary = auth.token_summary()
            self.assertFalse(summary["connected"])
            self.assertEqual(summary["error"], "agent_session_rate_limited")
        self.assertEqual(len(self.calls), 1)

    def test_not_signed_in_is_never_cached(self):
        self.helper(tp.ProviderNotSignedIn(NOT_SIGNED_IN), tp.ProviderResponse(201, tp.session_payload()))
        with self.assertRaises(auth.NotSignedIn):
            auth.credential()
        self.assertEqual(auth.get_token(), "slop_live_session_a")  # signed in since: works at once
        self.assertEqual(len(self.calls), 2)

    def test_configuration_errors_are_not_cached(self):
        self.helper(tp.AuthError("x", code="oauth_client_id_missing"), tp.ProviderResponse(201, tp.session_payload()))
        with self.assertRaises(auth.CredentialError):
            auth.credential()
        self.assertEqual(auth.get_token(), "slop_live_session_a")

    def test_fresh_and_reset_clear_the_backoff(self):
        self.helper(refusal(429, "AGENT_SESSION_RATE_LIMITED"),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_fresh")),
                    refusal(429, "AGENT_SESSION_RATE_LIMITED"),
                    tp.ProviderResponse(201, tp.session_payload("slop_live_reset")))
        with self.assertRaises(auth.CredentialError):
            auth.credential()
        self.assertEqual(auth.credential(fresh=True).token, "slop_live_fresh")
        with self.assertRaises(auth.CredentialError):
            auth.credential(fresh=True)
        auth.reset()
        self.assertEqual(auth.get_token(), "slop_live_reset")
        self.assertEqual(len(self.calls), 4)

    def test_the_personal_token_still_answers_inside_the_window(self):
        self.helper(refusal(429, "AGENT_SESSION_RATE_LIMITED"))
        tp._SECRETS[settings.TOKEN_ENV] = "slop_live_personal"
        self.assertEqual(auth.get_token(), "slop_live_personal")
        self.assertEqual(auth.get_token(), "slop_live_personal")
        self.assertEqual(len(self.calls), 1)

    def test_a_session_due_for_renewal_keeps_working_while_the_mint_is_refused(self):
        self.helper(tp.ProviderResponse(201, tp.session_payload("slop_live_short", ttl_s=300)),
                    refusal(429, "AGENT_SESSION_RATE_LIMITED"))
        self.assertEqual(auth.get_token(), "slop_live_short")
        self.assertEqual(auth.get_token(), "slop_live_short")  # renewal refused; 5 minutes still left
        self.assertEqual(auth.get_token(), "slop_live_short")  # inside the window: no request
        self.assertEqual(len(self.calls), 2)

    def test_the_replayed_refusal_is_a_new_exception(self):
        self.helper(refusal(429, "AGENT_SESSION_RATE_LIMITED"))
        errors = []
        for _ in range(2):
            try:
                auth.credential()
            except auth.CredentialError as exc:
                errors.append(exc)
        self.assertIsNot(errors[0], errors[1])
        self.assertEqual((str(errors[0]), errors[0].code), (str(errors[1]), errors[1].code))


class NetworkErrorTest(unittest.TestCase):
    """A transport failure leaves every Client path as SlopcannonError(code='network')."""

    def setUp(self):
        tp.bind()
        self.seen: list[str] = []

    def client(self, exc_type: type[httpx.TransportError] = httpx.ConnectError, token: str = "slop_live_secret"):
        def boom(request):
            self.seen.append(str(request.url))
            raise exc_type("boom for " + str(request.url), request=request)
        return client_mod.Client(origin=ORIGIN, token=token, transport=httpx.MockTransport(boom))

    def assert_network(self, err, *, timeout=False):
        exc = err.exception
        self.assertIsInstance(exc, client_mod.SlopcannonError)
        self.assertEqual(exc.code, "network")
        self.assertIsNone(exc.__cause__)
        self.assertTrue(exc.__suppress_context__)
        text = str(exc)
        self.assertNotIn("http", text)  # no URL, capability or otherwise
        self.assertNotIn("slop_live", text)
        self.assertNotIn("boom", text)  # httpx's own text is never repeated
        self.assertIn("ReadTimeout" if timeout else "ConnectError", text)
        if timeout:
            self.assertIn("may still have arrived", text)
        self.assertEqual(exc.to_dict()["error"], "network")

    def test_rest_reads(self):
        c = self.client()
        for call in (c.balance, c.capabilities):
            with self.subTest(call=call.__name__):
                with self.assertRaises(client_mod.SlopcannonError) as err:
                    call()
                self.assert_network(err)

    def test_mcp_calls(self):
        c = self.client()
        for call in (lambda: c.call_tool("get_workspace"), c.list_tools, lambda: c.mcp("tools/list")):
            with self.assertRaises(client_mod.SlopcannonError) as err:
                call()
            self.assert_network(err)

    def test_a_timeout_says_the_request_may_have_arrived(self):
        with self.assertRaises(client_mod.SlopcannonError) as err:
            self.client(httpx.ReadTimeout).call_tool("submit_generation")
        self.assert_network(err, timeout=True)

    def test_uploads(self):
        with tempfile.TemporaryDirectory() as tmp:
            song = Path(tmp) / "song.mp3"
            song.write_bytes(b"ID3 not really")
            with self.assertRaises(client_mod.SlopcannonError) as err:
                self.client().upload_asset(path=song, project_id="p1", kind="song", content_type="audio/mpeg",
                                           rights_version="v1", idempotency_key="k1")
        self.assert_network(err)

    def test_downloads_own_origin_and_capability_links(self):
        for url in (f"{ORIGIN}/v1/generations/g1/content", "https://cdn.example.com/clip.mp4?sig=secret"):
            with self.subTest(url=url), tempfile.TemporaryDirectory() as tmp:
                dest = Path(tmp) / "clip.mp4"
                with self.assertRaises(client_mod.SlopcannonError) as err:
                    self.client().download(url, dest)
                self.assert_network(err)
                self.assertNotIn("sig=", str(err.exception))
                self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_a_stream_dropped_midway_leaves_no_partial_file(self):
        class Dropping(httpx.SyncByteStream):
            def __iter__(self):
                yield b"x" * 1024
                raise httpx.ReadError("connection reset")

        c = client_mod.Client(origin=ORIGIN, token="t", transport=httpx.MockTransport(
            lambda request: httpx.Response(200, stream=Dropping())))
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "clip.mp4"
            with self.assertRaises(client_mod.SlopcannonError) as err:
                c.download(f"{ORIGIN}/v1/generations/g1/content", dest)
            self.assertEqual(err.exception.code, "network")
            self.assertIn("ReadError", str(err.exception))
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_the_signed_in_path_is_wrapped_too(self):
        def down(request):
            raise httpx.ConnectError("down", request=request)

        with mock.patch.object(auth, "credential", return_value=auth.Credential(
                token="slop_live_s", via=auth.VIA_SIGN_IN, expires_at=None, session=True)):
            c = client_mod.Client(origin=ORIGIN, transport=httpx.MockTransport(down))  # no fixed token
            with self.assertRaises(client_mod.SlopcannonError) as err:
                c.balance()
        self.assert_network(err)

    def test_a_non_json_success_is_a_bad_response_not_a_value_error(self):
        c = client_mod.Client(origin=ORIGIN, token="t", transport=httpx.MockTransport(
            lambda request: httpx.Response(200, text="<html>maintenance</html>")))
        with self.assertRaises(client_mod.SlopcannonError) as err:
            c.balance()
        self.assertEqual(err.exception.code, "bad_response")

    def test_refusals_and_guards_are_unchanged(self):
        c = client_mod.Client(origin=ORIGIN, token="t", transport=httpx.MockTransport(
            lambda request: httpx.Response(302, headers={"Location": "https://evil.example/"})))
        with self.assertRaises(client_mod.SlopcannonError) as err:
            c.balance()
        self.assertEqual(err.exception.code, "unexpected_redirect")
        with self.assertRaises(client_mod.SlopcannonError) as err:
            c.get_json("https://evil.example/v1/billing/balance")
        self.assertEqual(err.exception.code, "foreign_origin")


if __name__ == "__main__":
    unittest.main()
