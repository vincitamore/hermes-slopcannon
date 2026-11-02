# SLOPCANNON desktop half

`plugin.js` is the Hermes Desktop half of the `slopcannon` package: plain ESM,
no build step, imports only `@hermes/plugin-sdk` and `react`. Desktop copies this
folder to `$HERMES_HOME/desktop-plugins/slopcannon/` and loads that copy
(Capabilities > Plugins > Rescan refreshes it).

## What it adds

| Surface | Area | Notes |
|---|---|---|
| Studio page `/slopcannon` | `ROUTES_AREA` | account strip, productions list, production detail (phase stepper, needs banner, master player, scene grid, driver log), Stop with confirm |
| Sidebar row `SLOPCANNON` | `SIDEBAR_NAV_AREA` | codicon `device-camera-video` |
| Status bar item | `STATUSBAR_AREAS.right` | `443 cr`, a spinner and count while renders run, a bell when a production waits; `SLOPCANNON: sign in` when signed out; hidden when the backend is off |
| Palette | `PALETTE_AREA` | SLOPCANNON: Open studio / Sign in / Refresh |
| Directive `slopcannon-film` | `TRANSCRIPT_DIRECTIVE_AREA` | `::slopcannon-film{id="<production id>"}`; ids must match `^[a-z0-9][a-z0-9-]{0,63}$`, anything else renders nothing |
| Clip cards | `TOOL_MEDIA_RENDERER_AREA` | video MEDIA from `slopcannon_wait`, `slopcannon_download`, `slopcannon_produce`, `slopcannon_production_status` |

## Backend it reads

`dashboard/plugin_api.py` through `ctx.rest`: `GET /status`, `GET /productions`,
`GET /productions/{id}`, `POST /productions/{id}/stop`, `POST /login`. Live
updates come from `plugin.slopcannon.production.updated` and
`plugin.slopcannon.account.updated`; polling is the fallback (5 s while a
production runs, 30 s otherwise). If the Python half is not loaded the page
shows one quiet line and the status item hides.

## Video playback

- Clip cards in the chat use `file.resolveUrl()` (the host's ticketed range
  stream) in a plain `<video>`.
- The studio page renders `MEDIA:"<path>"` through the SDK's
  `MessageTextContent`, which is Desktop's own media pipeline (the gateway's
  `/api/files/stream` with a path-bound ticket). `ctx.rest` returns JSON only
  and the SDK has no helper that turns a plugin route into a `<video src>`, so
  the plugin's own `/media` route is not used by this half.

## Decisions go back to the chat

Buttons send a plain message with `host.composer.submit`. Cards in a transcript
send only to their own chat, and if that chat is not on screen nothing is sent.
The studio sends to the chat that last showed the production (remembered in
`ctx.storage`, or `sessionId` on the production if the backend provides it).
If that fails it uses the active composer, then reopens the remembered chat,
and as a last resort copies the message to the clipboard. Messages carry
the production title and id, never paths with query strings or tokens.
