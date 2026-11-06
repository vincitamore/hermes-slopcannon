# SLOPCANNON desktop half

`plugin.js` is the Hermes Desktop half of the `slopcannon` package: plain ESM,
no build step, imports only `@hermes/plugin-sdk` and `react`. Desktop copies this
folder to `$HERMES_HOME/desktop-plugins/slopcannon/` and loads that copy
(Capabilities > Plugins > Rescan refreshes it). SDK names are read through a
namespace import, so a name an older Desktop lacks degrades instead of failing
the load.

## What it adds

| Surface | Area | Notes |
|---|---|---|
| Directive `slopcannon-film` | `TRANSCRIPT_DIRECTIVE_AREA` | `::slopcannon-film{id="<production id>"}`: the film card, one card that changes in place (needs you with the plan on the song, rendering with the latest take and progress, done with the film). Every decision is made here (see below). Ids must match `^[a-z0-9][a-z0-9-]{0,63}$`, anything else renders nothing; a card that fails to render leaves one quiet line with Open in studio and Try again |
| Studio page `/slopcannon` | `ROUTES_AREA` | productions grouped Needs you / Rendering / Finished / Paused with the film's own thumbnail; account as quiet text; header, step line, the same decision block as the card, the film with its poster, the scenes laid on the song (frames at each scene's real length, the song's envelope, playhead tied to the film), the scene inspector (take, credits, check verdict in plain words, direction, Reroll), driver log, Stop with confirm; first-run and signed-out states |
| Sidebar row `SLOPCANNON` | `SIDEBAR_NAV_AREA` | codicon `device-camera-video` |
| Status bar item | `STATUSBAR_AREAS.right` | a `StatusbarItem` data entry: `SLOPCANNON 443 cr · 1 rendering · 1 needs you`, `SLOPCANNON sign in` when signed out; opens the studio; listed in the bar's right-click show/hide menu |
| Palette | `PALETTE_AREA` | SLOPCANNON: Open studio / Ask for a music video / Copy sign-in command / Refresh |
| Scene cards | `TOOL_MEDIA_RENDERER_AREA` | video MEDIA from `slopcannon_wait`, `slopcannon_download`, `slopcannon_produce`, `slopcannon_production_status`, drawn as the studio's scene inspector (poster, timing, verdict, take, credits); a reroll take (`sc09.r1`) is shown as its scene |

## Decisions are made on the card

Each button answers the gate the production is stopped at by posting
`POST /productions/{id}/decide` through `ctx.rest`: `{gate: 'rights', version}`,
`{gate: 'approval', credits}`, `{gate: 'budget', credits}`,
`{gate: 'first_scene_review', sha256}`, `{gate: 'scene_review', sha256}`,
`{gate: 'shot_review', keep, reroll}`, `{gate: 'reroll', reroll}` (with the
note as the new take's direction), `{gate: 'reroll_approval', credits | cancel}`,
`{gate: 'recheck'}` and `{gate: 'resume'}`. The backend accepts only the exact
figure, version or take the gate names and keeps the seat's credit ceiling, so a
stale card cannot approve something else; the card then shows the next step.
No chat message is sent and no agent turn runs.

When the record does not yet hold what an answer must name (the statement
version, the quoted total, the take's digest), the card reads the production
again and shows a quiet "Updating" line; it never guesses and never falls back
to a chat message. To reroll a scene of a finished film, choose the scene on
the card's track, then Reroll.

Only questions and requests that the agent alone can act on go to the chat:
Ask the agent, Change the plan, Change the direction, Start a new revision. A
card sends them only to its own chat; a card that does not know its chat sends
nothing and says where to ask. The studio sends them to the chat the
production came from (remembered in `ctx.storage`, or `sessionId` on the
production), else the active composer, else that chat opened, else a new chat,
and as a last resort the clipboard. Messages carry the production title and id,
never paths with query strings or tokens.

## Backend it reads

`dashboard/plugin_api.py` through `ctx.rest`: `GET /status`, `GET /productions`,
`GET /productions/{id}`, `GET /productions/{id}/media`,
`POST /productions/{id}/poster`, `POST /productions/{id}/decide`,
`POST /productions/{id}/stop`, `GET /thumbs`, `GET /frames/{name}`, `GET /locate`.
An unknown production answers 404 with `no production <id>`; a 404 without it
means the backend is not mounted, and the page shows one quiet line saying so.
Live updates come from `plugin.slopcannon.production.updated` and
`plugin.slopcannon.account.updated`. Polling is the fallback (5 s while a
production renders, 30 s otherwise); only the first mounted reader of a
running production keeps polling while the window is hidden. Cached reads are
keyed by connection and profile.

## Frames and the song envelope

`media.py` makes posters, six-frame strips, thumbs and the song's RMS envelope with
ffmpeg, lazily, on two background workers, cached under the plugin data folder by the
source file's path, size and mtime. The UI asks for a production's media (cache names
and `pending`), polls while anything is pending, and reads each image once as a data
URL by its opaque name. A request never names a file. Without ffmpeg the slots stay
neutral and the scenes line says so once. A poster picked in the studio
(`POST /productions/{id}/poster`) is kept in the plugin's own data.

## Video playback

- Clip cards in the chat use `file.resolveUrl()` (the host's ticketed range
  stream) in a plain `<video>`.
- The studio page and the film card render `MEDIA:"<path>"` through the SDK's
  `MessageTextContent` in a hidden probe of their own, which is Desktop's own
  media pipeline (Electron's media protocol, or the gateway's ticketed file
  stream), and play that source in their own `<video>` with the poster. The SDK
  has no path-to-URL resolver outside a tool media renderer, so the probe is the
  way in; it reads only its own node. If the probe yields no source, Desktop's
  built-in player is shown as it is.
