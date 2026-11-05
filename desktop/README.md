# SLOPCANNON desktop half

`plugin.js` is the Hermes Desktop half of the `slopcannon` package: plain ESM,
no build step, imports only `@hermes/plugin-sdk` and `react`. Desktop copies this
folder to `$HERMES_HOME/desktop-plugins/slopcannon/` and loads that copy
(Capabilities > Plugins > Rescan refreshes it).

## What it adds

| Surface | Area | Notes |
|---|---|---|
| Studio page `/slopcannon` | `ROUTES_AREA` | productions grouped Needs you / Rendering / Finished / Paused with the film's own thumbnail; account as quiet text; header, step line, the decision block, the film with its poster, the scenes laid on the song (frames at each scene's real length, the song's envelope, playhead tied to the film), the scene inspector (take, credits, check verdict in plain words, direction, Reroll / Check again), driver log, Stop with confirm; first-run and signed-out states |
| Sidebar row `SLOPCANNON` | `SIDEBAR_NAV_AREA` | codicon `device-camera-video` |
| Status bar item | `STATUSBAR_AREAS.right` | `SLOPCANNON 443 cr · 1 rendering · 1 needs you`; `SLOPCANNON sign in` when signed out; hidden when the backend is off |
| Palette | `PALETTE_AREA` | SLOPCANNON: Open studio / Ask for a music video / Copy sign-in command / Refresh |
| Directive `slopcannon-film` | `TRANSCRIPT_DIRECTIVE_AREA` | `::slopcannon-film{id="<production id>"}`: one card that changes in place (needs you with the plan on the song, rendering with the latest take and progress, done with the film); actions sit below the card; ids must match `^[a-z0-9][a-z0-9-]{0,63}$`, anything else renders nothing |
| Scene cards | `TOOL_MEDIA_RENDERER_AREA` | video MEDIA from `slopcannon_wait`, `slopcannon_download`, `slopcannon_produce`, `slopcannon_production_status`, drawn as the studio's scene inspector (poster, timing, verdict, take, credits) |

## Backend it reads

`dashboard/plugin_api.py` through `ctx.rest`: `GET /status`, `GET /productions`,
`GET /productions/{id}`, `GET /productions/{id}/media`, `GET /thumbs`, `GET /frames/{name}`,
`GET /locate`, `POST /productions/{id}/stop`, `POST /login` (returns the
`hermes auth add slopcannon:slop` command; it starts nothing). Live
updates come from `plugin.slopcannon.production.updated` and
`plugin.slopcannon.account.updated`; polling is the fallback (5 s while a
production runs, 30 s otherwise). If the Python half is not loaded the page
shows one quiet line and the status item hides.

## Frames and the song envelope

`media.py` makes posters, six-frame strips, thumbs and the song's RMS envelope with
ffmpeg, lazily, on two background workers, cached under the plugin data folder by the
source file's path, size and mtime. The UI asks for a production's media (cache names
and `pending`), polls while anything is pending, and reads each image once as a data
URL by its opaque name. A request never names a file. Without ffmpeg the slots stay
neutral and the scenes line says so once.

## Video playback

- Clip cards in the chat use `file.resolveUrl()` (the host's ticketed range
  stream) in a plain `<video>`.
- The studio page and the film card render `MEDIA:"<path>"` through the SDK's
  `MessageTextContent` in a hidden probe, which is Desktop's own media pipeline
  (Electron's media protocol, or the gateway's `/api/files/stream` with a
  path-bound ticket), and play that source in their own `<video>` with the
  poster. If the probe yields no source, Desktop's built-in player is shown
  as it is. `ctx.rest` returns JSON only, so the plugin's own `/media` route
  is not used by this half.

## Decisions go back to the chat

Buttons send a plain message with `host.composer.submit`. Cards in a transcript
send only to their own chat, and if that chat is not on screen nothing is sent.
The studio sends to the chat that last showed the production (remembered in
`ctx.storage`, or `sessionId` on the production if the backend provides it).
If that fails it uses the active composer, then reopens the remembered chat,
and as a last resort copies the message to the clipboard. Messages carry
the production title and id, never paths with query strings or tokens.
