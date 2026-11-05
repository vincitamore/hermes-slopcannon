# SLOPCANNON for Hermes

Music videos from a song, inside Hermes. Ask for a film; the agent writes the direction, SLOPCANNON renders it, and Hermes asks you before every credit is spent. Finished clips and films arrive as native video in the desktop app, the terminal and your messaging apps.

[Install in Hermes](hermes://plugin/install?repo=vincitamore/hermes-slopcannon&enable=1)

## What you get

- **A whole film in one request.** `slopcannon_produce` runs SLOPCANNON's own production driver: uploads, scene audio cut on the server, a timed scene plan, quotes, one first scene for your review, parallel renders, character checks and assembly. It is resumable and never buys a scene twice.
- **You decide every spend.** On Hermes desktop a film's decisions (the rights sign-off, the credit quote, the first scene, keep or reroll each flagged take) are buttons on its film card in the chat, and each accepts only the exact figure or file it shows. Through chat or on other surfaces, credit approvals, rights sign-offs, deleting takes and publishing characters go through Hermes's approval prompt. The agent can never press the card's buttons. Nobody present means no spend. A per-action ceiling and an unattended allowance are in the plugin settings.
- **A studio in Hermes Desktop.** A SLOPCANNON page in the sidebar shows your credits and every production: its phase, each scene with its clip, the decision waiting on you, and the finished film. The agent drops a live production card into the chat, with the answer one click away. Rendered clips play inline, with buttons to keep, check or reroll a take.
- **Every SLOPCANNON tool.** All hosted tools (music videos, source-video remixes, the Ad Cannon, Character Lab, Slop TV) are native Hermes tools, plus what only a local agent can do: upload from disk, word-timed lyrics, wait for renders, bring the video home.

## Setup

1. Install and enable the plugin: the button above, or `hermes plugins install https://github.com/vincitamore/hermes-slopcannon` then `hermes plugins enable slopcannon`.
2. Connect your account. Hermes runs the sign-in, in a terminal on the machine Hermes runs on:

   ```sh
   hermes config set SLOPCANNON_OAUTH_CLIENT_ID hermes-agent   # once: slop.cc's public client id for Hermes
   hermes auth add slopcannon:slop                             # opens slop.cc in your browser to approve
   ```

   The sign-in cannot start from a chat, the desktop app or a messaging app (it needs your browser and a terminal), so `/slop login` only shows these commands. `hermes auth status slopcannon:slop` shows the sign-in; `hermes auth logout slopcannon:slop` removes it. It lasts 90 days; run `hermes auth add slopcannon:slop` again when it ends.

   **Or use a personal token** (headless machines, or an `api_origin` other than `https://api.slop.cc`): create an agent token at [slop.cc/account](https://slop.cc/account) and enter it as **Agent token** in Capabilities, Plugins, SLOPCANNON (or `hermes config set SLOPCANNON_AGENT_TOKEN <token>` in a terminal). Never paste a token into chat.
3. `/slop status` shows the account, credits and service.
4. Whole productions need [Node.js](https://nodejs.org) 22.13 or newer on the machine Hermes runs on. Everything else works without it.

Then ask: *"Make a music video for ~/Music/song.mp3 with my photo ~/Pictures/me.jpg as the lead, 16:9."*

## Commands

| | |
|---|---|
| `/slop status` | account, credits, service |
| `/slop login` / `/slop logout` | show the `hermes auth add` / `hermes auth logout slopcannon:slop` commands to run in a terminal |
| `/slop sync` | refresh the declared tools' descriptions from the server (next session); new server tools arrive with a plugin release |
| `hermes slopcannon ...` | the same from a terminal |

## Settings

`plugins.entries.slopcannon.settings` (or the desktop Plugins page):

| Key | Default | |
|---|---|---|
| `max_credits_per_action` | 0 (none) | any single spend above this is blocked before the prompt |
| `auto_approve_max_credits` | 0 | under YOLO / approvals off, spends at or below this proceed; larger ones are blocked |
| `download_dir` | `<hermes home>/cache/videos/slopcannon` | where clips and films are saved |
| `api_origin` | `https://api.slop.cc` | the API; HTTPS, or loopback HTTP for development |

## What this plugin does on your machine (disclosure)

- **Network.** Calls `https://api.slop.cc` (the SLOPCANNON API and its MCP endpoint). `hermes auth add slopcannon:slop` (Hermes, not the plugin) signs in at `https://slop.cc` with a loopback redirect on `127.0.0.1`. Finished media is downloaded from the short-lived links SLOPCANNON issues; those requests carry no credential. No telemetry.
- **Credentials: what goes where.**
  - *Hermes holds the sign-in.* The 90-day grant from `hermes auth add slopcannon:slop` lives in your Hermes profile's auth store. The plugin never receives it, never reads `.env` or `auth.json`, and never runs an OAuth flow or writes a token.
  - *The plugin holds only short-lived sessions, in memory.* It asks Hermes (`credentialed_provider_request`) to call `POST https://api.slop.cc/v1/agent-sessions` with the grant, and gets back an agent session token: two hours, narrower than the grant (never `billing:purchase`), revoked with it. The session is kept in the process's memory only, re-minted near expiry or on a 401, and gone when Hermes exits. Sessions show on slop.cc/account.
  - *The production driver gets its own session.* `slopcannon_produce` starts the Node driver with a dedicated twelve-hour session in that child's environment (`SLOPCANNON_AGENT_TOKEN`), so a long run cannot lose its credential midway.
  - *A personal token, if you choose one,* is read through Hermes's secret route (`get_secret`) and sent only to the configured API origin; with `api.slop.cc` the driver still gets a twelve-hour session minted from it rather than the token itself.
  - Credentials go only to the API origin, never across a redirect. The plugin never asks the model for a token, and the model never sees one.
- **Files.** Reads only the songs and pictures you point the agent at. Writes productions and transcripts under `<hermes home>/plugin-data/slopcannon/` and media under the download folder. The studio's frames (posters, filmstrips, the song envelope) are made with ffmpeg into `plugin-data/slopcannon/media-cache/`; a poster you pick in the studio ("Use this frame as poster") is kept in `plugin-data/slopcannon/posters.json`, never in the production's own files.
- **Background processes.** `slopcannon_produce` runs the bundled production driver (`skills/slopcannon-music-video/scripts/slopcannon-agent.mjs`, plain JavaScript in this repository) with Node.js as a background child process, with its own short-lived session in that child's environment. It runs only the approvals you gave, as command-line flags; the production file the agent writes cannot carry an approval. Stop it from the studio or with `slopcannon_production_stop`.
- **Spending.** Credits are spent only on the person's click on a film card or on a call that passed Hermes's approval prompt. Buying credits is never done by the plugin (it does not request the `billing:purchase` scope).

## Development

```sh
python -m unittest discover -s tests          # offline tests
python scripts/sync_server_tools.py --check   # the tool snapshot matches the server
hermes plugins validate .                     # the catalog check
```

## License

MIT (see [LICENSE](LICENSE)). This covers the plugin and the bundled skill copy, not the SLOPCANNON service, which has its own terms at [slop.cc](https://slop.cc).
