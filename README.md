# SLOPCANNON for Hermes

Music videos from a song, inside Hermes. Ask for a film; the agent writes the direction, SLOPCANNON renders it, and Hermes asks you before every credit is spent. Finished clips and films arrive as native video in the desktop app, the terminal and your messaging apps.

[Install in Hermes](hermes://plugin/install?repo=slopcannon/hermes-slopcannon&enable=1)

## What you get

- **A whole film in one request.** `slopcannon_produce` runs SLOPCANNON's own production driver: uploads, scene audio cut on the server, a timed scene plan, quotes, one first scene for your review, parallel renders, character checks and assembly. It is resumable and never buys a scene twice.
- **You decide every spend.** Credit approvals, rights sign-offs, deleting takes and publishing characters all go through Hermes's approval prompt. Nobody present means no spend. A per-action ceiling and an unattended allowance are in the plugin settings.
- **A studio in Hermes Desktop.** A SLOPCANNON page in the sidebar shows your credits and every production: its phase, each scene with its clip, the decision waiting on you, and the finished film. The agent drops a live production card into the chat, with the answer one click away. Rendered clips play inline, with buttons to keep, check or reroll a take.
- **Every SLOPCANNON tool.** All hosted tools (music videos, source-video remixes, the Ad Cannon, Character Lab, Slop TV) are native Hermes tools, plus what only a local agent can do: upload from disk, word-timed lyrics, wait for renders, bring the video home.

## Setup

1. Install and enable the plugin (the button above, or `hermes plugins install slopcannon`).
2. Connect your account: `/slop login` in the desktop or terminal opens slop.cc in your browser. On a headless machine, create an agent token at [slop.cc/account](https://slop.cc/account) and enter it as **Agent token** in Capabilities, Plugins, SLOPCANNON (or `hermes slopcannon login --token-stdin`).
3. `/slop status` shows the account, credits and service.
4. Whole productions need [Node.js](https://nodejs.org) 22.13 or newer on the machine Hermes runs on. Everything else works without it.

Then ask: *"Make a music video for ~/Music/song.mp3 with my photo ~/Pictures/me.jpg as the lead, 16:9."*

## Commands

| | |
|---|---|
| `/slop status` | account, credits, service |
| `/slop login` / `/slop logout` | connect or forget this machine's token |
| `/slop sync` | refresh the tool list from the server (next session) |
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

- **Network.** Calls `https://api.slop.cc` (the SLOPCANNON API and its MCP endpoint) with your token, and `https://slop.cc` for sign-in. Finished media is downloaded from the short-lived links SLOPCANNON issues; those requests carry no credential. No telemetry.
- **Credentials.** The token is read through Hermes's secret route and sent only to the configured API origin, never across a redirect. `/slop login` runs an OAuth 2.1 + PKCE sign-in with a loopback redirect on `127.0.0.1` and stores the resulting token as `SLOPCANNON_AGENT_TOKEN` through Hermes's secure env writer. The plugin never asks the model for a token, and the model never sees one.
- **Files.** Reads only the songs and pictures you point the agent at. Writes productions and transcripts under `<hermes home>/plugin-data/slopcannon/` and media under the download folder.
- **Background processes.** `slopcannon_produce` runs the bundled production driver (`skills/slopcannon-music-video/scripts/slopcannon-agent.mjs`, plain JavaScript in this repository) with Node.js as a background child process, with the token in that child's environment. It runs only the approvals you gave, as command-line flags; the production file the agent writes cannot carry an approval. Stop it from the studio or with `slopcannon_production_stop`.
- **Spending.** Credits are spent only by calls that passed Hermes's approval prompt. Buying credits is never done by the plugin (it does not request the `billing:purchase` scope).

## Development

```sh
python -m unittest discover -s tests          # offline tests
python scripts/sync_server_tools.py --check   # the tool snapshot matches the server
hermes plugins validate .                     # the catalog check
```
