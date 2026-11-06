# SLOPCANNON for Hermes

Music videos from a song, inside Hermes. Ask for a film; the agent writes the direction, SLOPCANNON renders it, and Hermes asks you before every credit is spent. Finished clips and films arrive as native video in the desktop app, the terminal and your messaging apps.

[Install in Hermes](hermes://plugin/install?repo=vincitamore/hermes-slopcannon&enable=1)

## What you get

- **A whole film in one request.** `slopcannon_produce` runs SLOPCANNON's own production driver: uploads, scene audio cut on the server, a timed scene plan, quotes, one first scene for your review, parallel renders, character checks and assembly. It is resumable and never buys a scene twice.
- **One world, scene to scene.** Two ways to keep a film's look, palette and characters consistent. **Storyboard** (fast, the default): the agent makes one keyframe per scene with Hermes's image generator, you approve the sheet, and every scene renders at once with its keyframe as its set picture. **Chain** (`"continuity": "chain"`, exact hand-offs): scenes render one at a time, each starting from the last frame of the scene before, and each waits on the card for keep or reroll before the next is bought.
- **You decide every spend.** On Hermes desktop a film's decisions (the rights sign-off, the credit quote, the first scene, keep or reroll each flagged take) are buttons on its film card in the chat, and each accepts only the exact figure or file it shows. Through chat or on other surfaces, credit approvals, rights sign-offs, deleting takes and publishing characters go through Hermes's approval prompt. The agent is told to leave the card's buttons to you and its tools refuse to call them; the card's routes also need the desktop's own session token. When no person can be asked (approvals bypassed, or a cron job), a spend goes ahead only up to the unattended allowance, which is 0 unless you raise it, and a rights sign-off never does. A per-action ceiling applies to every spend.
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
| `unattended_max_credits` | 0 | when no person can be asked (YOLO, approvals off, a cron job), spends at or below this proceed and larger ones are blocked; rights sign-offs are always blocked there |
| `protect_production_files` | true | refuse other tools that would open or edit a production's own files |
| `download_dir` | `<hermes home>/cache/videos/slopcannon` | where clips and films are saved |
| `api_origin` | `https://api.slop.cc` | the API; HTTPS, or loopback HTTP for development |

## What this plugin does on your machine (disclosure)

- **Network.**
  - Calls `https://api.slop.cc`: the SLOPCANNON API, its MCP endpoint, and the public rights statement.
  - `hermes auth add slopcannon:slop` (Hermes, not the plugin) signs in at `https://slop.cc` with a loopback redirect on `127.0.0.1`.
  - Finished media is downloaded from the short-lived HTTPS links SLOPCANNON issues, which may point at its storage provider rather than slop.cc; those requests carry no credential.
  - `/slop sync` refreshes the wording and argument schemas of the declared tools from the server. It can never add or remove a tool.
  - No telemetry. Requests carry a `hermes-slopcannon/<version>` User-Agent.
- **Credentials: what goes where.**
  - *Hermes holds the sign-in.* The 90-day grant from `hermes auth add slopcannon:slop` lives in your Hermes profile's auth store. The plugin never receives it, never reads `.env` or `auth.json`, and never runs an OAuth flow or writes a token.
  - *The plugin holds only short-lived sessions, in memory.* It asks Hermes (`credentialed_provider_request`) to call `POST https://api.slop.cc/v1/agent-sessions` with the grant, and gets back an agent session: two hours, narrower than the grant (never `billing:purchase`), ended with it. This is deliberate least privilege: the plugin's own calls never carry the grant. The session lives in process memory only, is re-minted near expiry or on a 401, and is gone when Hermes exits. A refused mint is not retried for a minute.
  - *The production driver gets its own session.* `slopcannon_produce` starts the Node driver with a dedicated twelve-hour session in that child's environment (`SLOPCANNON_AGENT_TOKEN`), reused for that production while it has more than an hour left. On `api.slop.cc` the driver is never given your personal token itself; if no session can be minted the production does not start. SLOPCANNON has no route for an agent host to revoke a session early: it ends at its expiry, when its parent sign-in or token is revoked, or when you remove it at slop.cc/account.
  - *A personal token, if you choose one,* is read through Hermes's secret route (`get_secret`) and sent only to the configured API origin. With an `api_origin` other than `https://api.slop.cc` (self-hosted or local development) the token itself is the only credential that origin accepts, so the driver gets the token.
  - Credentials go only to the API origin, never across a redirect. The plugin never asks the model for a token, and the model never sees one.
- **Files.**
  - Reads only the songs and pictures you point the agent at, and uploads them to SLOPCANNON after your rights sign-off.
  - Writes productions and transcripts under `<hermes home>/plugin-data/slopcannon/` and media under the download folder. Studio frames (posters, filmstrips, the song envelope) are made with ffmpeg into `plugin-data/slopcannon/media-cache/`; a poster you pick is kept in `plugin-data/slopcannon/posters.json`.
  - To show which chat a film belongs to, it looks up that chat's id in Hermes's session store through `hermes_state.SessionDB` (read only).
- **Processes.**
  - `slopcannon_produce` runs the bundled production driver (`skills/slopcannon-music-video/scripts/slopcannon-agent.mjs`, plain JavaScript in this repository) with Node.js as a background child process. The driver starts more Node processes from the same folder and ffmpeg/ffprobe (from `PATH`, or the folders the `SLOPCANNON_FFMPEG_*` variables name) to cut audio and assemble the film.
  - The driver gets a minimal environment: system paths, temp folders, `SLOPCANNON_*` settings and its session. It never receives Hermes's own variables or your other API keys.
  - It runs only the approvals you gave, as command-line flags; the production file the agent writes cannot carry an approval. Stop it from the studio or with `slopcannon_production_stop`; Hermes stops it when it exits.
  - The plugin runs `node --version` once to check Node, and ffmpeg for the studio's frames.
- **In the chat.**
  - A `transform_llm_output` hook puts a production's film card or clip line at the top of the agent's final reply when the agent did not write it, so the card always appears.
  - A few card buttons send a message to the card's own chat on your behalf ("Ask the agent", "Change the plan", "Change the direction", "Start a new revision"); if that chat cannot take it, the text is put on your clipboard instead. Decisions never go through chat text: they are the card's own calls.
- **Spending.** Credits are spent only on your click on a film card, on a call that passed Hermes's approval prompt, or, when no person can be asked, within the unattended allowance you set (0 by default). A click on the card is recorded in the production's own decisions, not in Hermes's approval log. Buying credits is never done by the plugin (it does not request the `billing:purchase` scope).
- **Hermes internals.** To tell whether approvals are bypassed, the gate reads `tools.approval.is_approval_bypass_active`, which has no public equivalent yet; `hermes plugins validate` lists it as a warning. If it cannot be read, `/slop status` says so and Hermes's own prompt decides. Under `plugins.isolation: host` it cannot see the session's YOLO state, so only `max_credits_per_action` limits spends there under YOLO.
- **Bundled skill.** `skills/slopcannon-music-video/` is a verbatim copy of SLOPCANNON's own agent skill (its `SOURCE` file names the product repository and commit it was copied from). Some of its references describe the standalone CLI for other agent hosts; inside Hermes the plugin's tools replace it, and the `hermes-workflow` skill says so.

## Development

```sh
python -m unittest discover -s tests          # offline tests
python scripts/sync_server_tools.py --check   # the tool snapshot matches the server
hermes plugins validate .                     # the catalog check
```

## License

MIT (see [LICENSE](LICENSE)). This covers the plugin and the bundled skill copy, not the SLOPCANNON service, which has its own terms at [slop.cc](https://slop.cc).
