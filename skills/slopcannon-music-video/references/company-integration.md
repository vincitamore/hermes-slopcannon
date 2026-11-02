# Integrate whole projects

Build one managed production into your product or agent: one durable project, one master upload, server scene-audio slicing, per-scene quotes, reviewed saved takes and included server assembly. Your backend owns orchestration and recovery; the user supplies the creative brief, rights assent, budget approval and feedback. Read live readiness before promising completion.

The canonical API origin is `https://api.slop.cc` and every path below is relative to it. The customer application at `https://slop.cc` has a separate `/api/v1` deployment. Its readiness is not evidence about the partner API. API paths below are rooted at `/v1`; returned absolute endpoint URLs are authoritative.

## 1. Mint a credential

Token creation is a signed-in browser action. A person opens `https://slop.cc/account`, creates a scoped token, and copies it once — it is never shown again. Store it in your server's secret manager and supply it to the worker as `SLOPCANNON_AGENT_TOKEN`. It never belongs in a browser bundle, a committed file, a prompt, or an MCP tool argument.

Scopes are what the token may do: `projects:read`, `projects:write`, `assets:read`, `assets:write`, `quotes:create`, `generations:create`, `generations:read`, `billing:read`, `billing:purchase`. Issue the narrowest set the worker needs.

## 2. Read the contract and branch on it

```sh
curl https://api.slop.cc/v1/capabilities
```

No token is required. The manifest is authoritative and fails closed: a missing adapter reports `false` rather than failing at the moment money moves. Branch on it before every production run and use the absolute URLs in its `endpoints` object for later calls rather than the host that served the document.

| Field | What it decides |
| --- | --- |
| `hostedRuntime.quoteReady` | A quote can be issued. |
| `hostedRuntime.submissionReady` | Paid generation is accepted. When it is false, stop before requesting payment. |
| `hostedRuntime.contentReady` | Delivered clips can be read back. |
| `hostedRuntime.projectReady` | Project control is available; check assets and organizations separately. |
| `hostedRuntime.songAnalysisControlReady` | Hosted word timing is available; otherwise supply a local transcript. |
| `contract.generation.sceneDurationMs` | The 5,000–15,000 ms bounds every scene clip sits inside. |
| `contract.generation.maximumScenesPerQuote` | Scenes per quote. At `1`, retain the project master and quote a scene's server-created `sourceAudioAssetId`. |
| `contract.generation.sourceAssetMaxBytes` | The 768 KiB generation-input ceiling; whole masters for slicing use the separate 50 MiB hosted upload limit. |
| `contract.generation.minimumCannonCreditsPerGeneration` | The billing floor, so a deliberately short probe costs what a real scene costs. |
| `contract.workspace.readReady` / `writeReady` | The saved film can be read and written. |
| `contract.assembly.serverReady` | The master is built on the server rather than in your worker. |
| `contract.assembly.pricingSet`, `creditsPerOutputMinute` | Assembly is included; the rate is zero. Renderer readiness is a separate field. |
| `contract.assembly.engine` | The configured renderer; native verification is described in the assembly guide. |
| `contract.productionWorkflow.finalAssembly` | `server-ffmpeg-with-sync-report` or `client-ffmpeg-with-sync-report`. |
| `contract.organizations.ready` | The reseller surface answers on this deployment. |
| `contract.generation.serverSideSlicing` | The song is cut into scene audio on the server, so your worker needs no media tool. |
| `contract.generation.sourceAudioAssetIdAccepted` | A quote may name the scene-audio asset the server cut for that scene. |
| `contract.mcp.toolNames` | The advertised tool names; read argument schemas from `tools/list` and gate each operation on readiness. |

## 3. Install the client

The application publishes `/cli/manifest.json` at `https://slop.cc`. It names a content-addressed, zero-dependency npm tarball with its SHA-256 and SHA-512 integrity. Resolve its `download` path against `https://slop.cc`, verify bytes and digest, pin that URL and integrity in your build, then install with `npm install --ignore-scripts <exact HTTPS tarball URL>`. The archive holds the command, the complete portable skill and the media helpers — no application code, no install scripts, no secrets. Never publish the private root application as a CLI.

Use Node 22.13 or newer. Managed media processing runs on SLOPCANNON; the user does not need an FFmpeg setup. `slopcannon status` reads live capabilities without a token.

For direct HTTP, read `/openapi.json` on the API origin. For MCP, connect to `https://api.slop.cc/mcp`, negotiate Streamable HTTP, and read `tools/list`. Both enforce the same ownership, quote, idempotency and wallet rules. Media bytes never travel in MCP arguments.

## 4. Rights, before any bytes leave the device

```sh
curl https://api.slop.cc/v1/rights-attestation
```

Read `data.statement`, `data.requiredVersion`, `data.termsUrl` and `data.acceptableUseUrl`. Resolve the two links against the site origin the human signs in to. Present the complete statement and both links verbatim, name the files and the disclosed service purpose, and wait for explicit affirmative sign-off. `I agree` is sufficient; no magic phrase is required. One sign-off covers the statement version for the rest of the session: later files the same human supplies or directs you to create ride it without asking again; name each file as you upload it. Ask again only when the version changes, another person directs the work, or the human withdraws it. Only then may the unchanged `requiredVersion` travel in `X-Slopcannon-Rights-Attestation` on the matching upload. For music this covers the sound recording and the composition and lyrics alike.

Possession, an earlier upload, project ownership, silence, or a general request to make a video is not assent. Never synthesize or alter the statement, agree on the human's behalf, set the header before assent, carry assent into a new session or statement version, or fabricate a receipt.

## 5. Create the project

`POST /v1/projects` is replay-safe when it carries an `Idempotency-Key`: the first project is returned again under `Idempotency-Replayed: true`, and the same key with a different body answers 409. HTTP and MCP project creation share one key namespace, so a key minted on either surface replays on both.

```sh
curl -X POST https://api.slop.cc/v1/projects \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: campaign-001-project' \
  -d '{
        "name": "Northwind single",
        "concept": "A midnight performance in one long corridor.",
        "aspectRatio": "16:9",
        "targetResolution": "2K"
      }'
```

The project's `aspectRatio` is its frame. Every quote for the project must ask for the same `output.aspectRatio`; the server refuses any other as `409 project_aspect_ratio_mismatch`, naming both ratios, before anything is priced or held.

## 6. Upload the master and the references

Assets are raw request bodies with the metadata in headers.

```sh
curl -X POST "https://api.slop.cc/v1/assets?projectId=$PROJECT_ID&kind=song&filename=master.mp3" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: audio/mpeg' \
  -H 'Idempotency-Key: campaign-001-master-song' \
  -H "X-Slopcannon-Rights-Attestation: $ACCEPTED_POLICY_VERSION" \
  -H "X-Content-Sha256: $MASTER_SHA256" \
  --data-binary @./master.mp3

curl -X POST "https://api.slop.cc/v1/assets?projectId=$PROJECT_ID&kind=character_reference&filename=lead.webp" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: image/webp' \
  -H 'Idempotency-Key: campaign-001-lead-reference' \
  -H "X-Slopcannon-Rights-Attestation: $ACCEPTED_POLICY_VERSION" \
  --data-binary @./lead.webp
```

`X-Media-Duration-Ms` is optional for the full master on the server-slicing path. The slicer decodes and stores the actual duration. If you send a duration, it must agree within 250 ms or slicing fails; upload itself does not verify it. `X-Content-Sha256` is optional and recommended to reject corrupted bytes. Prepare reference images within `sourceAssetMaxBytes` before generation; the larger master-upload allowance does not enlarge provider-input limits.

Character references upload as `kind=character_reference`. The endpoint also accepts `kind=set_reference` for the same image types. A quote takes a set picture only for a cast member of `kind: "product"` (food, a product, an object or a place as the business photographed it), or in an edit of existing footage. It rejects any other cast member whose reference is not a `character_reference` and reports `character_asset_not_found`; a "not found" on an asset ID you are holding means the kind is wrong.

The key binds project, kind, sanitized filename, content type, exact byte count, digest and duration. An exact replay returns the original private asset; changed media or parameters answer 409.

## 7. Slice the master

SLOPCANNON generates a scene at a time: the hosted plane accepts one 5–15 second scene per quote, and its `sourceAudioAssetId` is the exact slice of the master it covers. **Where `contract.generation.serverSideSlicing` is true, that cut runs on the server.** Upload the master once, then ask for the slices:

```sh
curl -X POST "https://api.slop.cc/v1/projects/$PROJECT_ID/scene-audio"   -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"   -H 'Content-Type: application/json'   -d '{"scenes":[{"id":0,"startMs":0,"endMs":10000},{"id":1,"startMs":10000,"endMs":20000}]}'

curl "https://api.slop.cc/v1/projects/$PROJECT_ID/scene-audio?ticketId=$TICKET_ID"   -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"
```

The POST answers 202 with a ticket; read it until `phase` is `completed`, and every scene then carries its `assetId`, `bytes`, `sha256` and `durationMs`. Quote that scene by naming its chunk as the scene's `sourceAudioAssetId`. Scenes run from 0 without gaps, each 5000–15000 ms, and the same window of the same song always returns the same asset, so a retry costs nothing. The song's own length is decoded server-side, so a master uploaded without a declared duration gains one. The bundled CLI does all of this with `slopcannon video prepare --server $PROJECT_ID --plan plan.json`, and a worker on this path needs no media tool at all.


## 8. Save the plan, register references, then direct

The examples describe a 20-second master with two 10-second scenes. Replace all IDs with returned values and use a plan covering your actual decoded duration; example amounts and revisions are not approvals.

For a supplied plan, first read `GET /v1/projects/$PROJECT_ID/producer-workspace` and use its returned revision. Save a complete state through `PUT` to that route. Workspace scene times are **seconds**, while quote and scene-audio times are **milliseconds**. A minimal initial state is:

```json
{
  "expectedRevision": 0,
  "state": {
    "schemaVersion": 1,
    "pace": "music",
    "ratio": "16:9",
    "masterAudioMode": "song",
    "project": {
      "id": "PROJECT_ID",
      "treatment": "A midnight performance in one long corridor.",
      "activeSceneId": 0,
      "references": [],
      "scenes": [
        { "id": 0, "start": 0, "end": 10, "sceneText": "Track through the corridor.", "referenceIds": [] },
        { "id": 1, "start": 10, "end": 20, "sceneText": "The corridor opens into the rain.", "referenceIds": [] }
      ]
    }
  }
}
```

Use revision zero only when the read returned zero. For an existing production, modify the full returned state and preserve its takes, controls and references; never replace it with this initial fixture. A conflict means read again and reapply the intended change.


Choose a supplied timed plan or, when ready stored song analysis exists, use server cut planning. The `cuts` operation below cannot create missing word timing. When `songAnalysisControlReady` is false, the managed workflow can still use an agent-authored plan from supplied timing; do not repeatedly request transcription or claim it happened.

```sh
curl -X POST "https://api.slop.cc/v1/projects/$PROJECT_ID/cuts"   -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"   -H 'Content-Type: application/json'   -d '{"pace":"music"}'

```

`cuts` scores scene boundaries against the project's stored word timings and saves them as the timeline; a project with no ready analysis answers 409 `SONG_ANALYSIS_REQUIRED` and names the analysis endpoints. `director` drafts scene text and cast from the treatment and the film's references. Both write the same workspace document under an `expectedRevision`, and without one a project that already has a timeline gets its plan back with `written: false` instead of losing what it has. Neither debits Cannon Credits: direction calls a model and spends the account's producer fair-use budget, while cut planning reaches no provider and consumes no fair-use slot.

Uploading a reference makes its bytes addressable; putting it on the film makes it castable. A scene may only name references the film carries, and so may the director, so register each one against the project:

```sh
curl -X POST "https://api.slop.cc/v1/projects/$PROJECT_ID/references"   -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"   -H 'Content-Type: application/json'   -d '{"assetId":"'$LEAD_ASSET_ID'","name":"LEAD","kind":"person","visualDescription":"A tall man in a soaked grey coat."}'
```

The film needs a saved timeline first. Save the validated plan or use ready analysis to plan cuts, register references, then call the director. Read the current workspace revision between these writes; the example revision is not reusable. A new entry answers 201 and a repeat of the same asset answers 200 with the entry that already exists, so this is safe to retry. `DELETE /v1/projects/$PROJECT_ID/references/$REFERENCE_ID` takes one off, and answers 409 `REFERENCE_IN_USE` with the scene ids that still cast it rather than leaving the saved film unable to validate.

After registration, read the workspace again and use that exact revision for direction:

```sh
curl -X POST "https://api.slop.cc/v1/projects/$PROJECT_ID/director" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"expectedRevision\":$WORKSPACE_REVISION}"
```

## 9. Quote, approve, submit

A quote performs no generation and costs nothing. `price.customerTotal` is the exact wallet debit in Cannon Credits, frozen on the quote: a later rate change does not reprice an issued approval.

```sh
curl -X POST https://api.slop.cc/v1/quotes \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d @quote.json
```

```json
{
  "schemaVersion": "1.0",
  "projectId": "PROJECT_ID",
  "songAssetId": "MASTER_AUDIO_ASSET_ID",
  "creativeBible": "Consistent identity and lighting. No visible text or logos.",
  "cast": [{ "id": "lead", "name": "LEAD", "referenceAssetId": "REFERENCE_ASSET_ID" }],
  "timedPlan": {
    "schemaVersion": 1,
    "durationMs": 10000,
    "scenes": [
      {
        "startMs": 0,
        "endMs": 10000,
        "sourceAudioAssetId": "SCENE_AUDIO_ASSET_ID",
        "cast": ["LEAD"],
        "beat": "LEAD performs to the supplied complete scene audio. No visible text."
      }
    ]
  },
  "output": { "resolution": "2K", "aspectRatio": "16:9", "container": "mp4" }
}
```

`output.aspectRatio` is the project's frame (section 5). For a later scene, retain its absolute master times and set the single-scene plan's `durationMs` to that scene's absolute `endMs`. The master remains `songAssetId`.

Show the customer the exact `price.customerTotal`, its expiry and the scene count, and take explicit approval for that amount or a cap that covers it. Never round the approval value. Then echo it back exactly:

```sh
curl -X POST https://api.slop.cc/v1/generations \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: campaign-001-scene-01-generation' \
  -d '{
        "schemaVersion": "1.0",
        "quoteId": "QUOTE_ID",
        "approval": { "amountUnits": 80, "currency": "CANNON_CREDIT", "creditUnit": "cannon-credit" },
        "clientReference": "campaign-001/scene-01"
      }'
```

Write the idempotency key to your durable ledger **before** the call. A timeout or an ambiguous response is never permission to submit again with a fresh key: recover the same operation.

```sh
curl -X POST https://api.slop.cc/v1/generations/recover \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"campaign-001-scene-01-generation"}'
```

Recovery is an owner-scoped read. It submits nothing, reserves nothing, and works after the quote has expired. A missing record is not authorization to retry with a new key.

## 10. Poll, then read the delivered clip

```sh
curl "https://api.slop.cc/v1/generations/$GENERATION_ID" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"
```

The status carries a `settlement` block — `reservedCredits`, `debitedCredits`, `refundedCredits`, an optional `providerCostMicros`, and a `state` of `unreserved`, `reserved`, `debited`, `partially_debited` or `refunded`. That is settled money read from the authorization row, distinct from the quote, which is exposure. `failed`, `submission_unknown` and `billing_unknown` are terminal for the poll loop; an unknown status is recovered, never resubmitted.

At `succeeded`, read the content metadata and take the bytes:

```sh
curl "https://api.slop.cc/v1/generations/$GENERATION_ID/content" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"

curl -L --output scene-01.mp4 "https://api.slop.cc/v1/generations/$GENERATION_ID/download" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"
```

SLOPCANNON persists a completed generation as a `generated_take` asset. `/content` reports `bytes`, `sha256`, `assetId` and `workspaceAttachment` when available. Verify bytes and digest before delivery. Missing persistence metadata can mean the download is still proxied from the provider; do not claim storage or digest verification before they are present. A `workspaceAttachment` of `pending` is unresolved; `unattached` gives a terminal placement reason. Preserve the asset and inspect the workspace for a deliberate revision-guarded repair instead of regenerating. Refresh expired metadata using the same generation ID.

## 11. The take is in the workspace

Check `workspaceAttachment.status` and read the workspace to confirm placement. The stored asset can exist even when a scene has been removed or the take limit prevents automatic placement.

```sh
curl "https://api.slop.cc/v1/projects/$PROJECT_ID/producer-workspace" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"
```

The response carries the scenes, every take under each, the current selection, and a `revision`. Every change must carry the revision it read. Over HTTP the write is the whole state:

```sh
curl -X PUT "https://api.slop.cc/v1/projects/$PROJECT_ID/producer-workspace" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"expectedRevision":7,"state":{ … }}'
```

A stale revision answers 409 with the current one rather than overwriting a newer save. Read again and re-apply; never retry with a guessed revision.

MCP carries the three narrow verbs instead of the whole-state write:

| Operation | HTTP | MCP |
| --- | --- | --- |
| Read the film | `GET /v1/projects/{id}/producer-workspace` | `slopcannon_get_workspace` |
| Choose a take | `PUT /v1/projects/{id}/producer-workspace` | `slopcannon_select_take` |
| Delete a take | `PUT /v1/projects/{id}/producer-workspace` | `slopcannon_delete_take` |
| List generations | `GET /v1/generations` | `slopcannon_list_generations` |

`slopcannon_select_take` and `slopcannon_delete_take` take `{projectId, sceneId, takeId, expectedRevision}`. Deletion releases the take's stored video and is refused on a scene's selected take: select another take first. Deleted video is not recoverable and its credits are not refunded. Selection reflects a person's judgment about identity, mouth timing and continuity, never the agent's. Takes in a project an agent generated into are kept until the agent deletes them: the retention rules for a person's own projects (rejected takes after 7 days, a finished project's takes 28 days after its last activity, an unfinished project's after 90 days without activity) never apply to it.

The bundled CLI exposes the same two:

```sh
slopcannon video workspace --project "$PROJECT_ID"
slopcannon video select --project "$PROJECT_ID" --scene-id 3 --take 2 --revision 7
```

## 12. Build the master on the server

Where `contract.assembly.serverReady` is true, request server assembly from selected persisted takes. Native rendering uses absolute frame boundaries, the original master and verification before publication. Read the returned `engine` and verification fields instead of assuming every engine is native. See [assembly.md](assembly.md) for supported controls and verification.

```sh
curl -X POST https://api.slop.cc/v1/assemblies \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: campaign-001-master' \
  -d '{
        "projectId": "PROJECT_ID",
        "title": "Northwind single",
        "durationMs": 20000,
        "audioMode": "song",
        "masterAudioAssetId": "MASTER_AUDIO_ASSET_ID",
        "clips": [
          { "assetId": "TAKE_ASSET_ID_1", "startMs": 0, "endMs": 10000 },
          { "assetId": "TAKE_ASSET_ID_2", "startMs": 10000, "endMs": 20000 }
        ]
      }'
```

Every clip references an asset this account owns, so takes are persisted first. The response is 202 with the assembly view: `id`, `status`, `progress`, `engine`, and `credits: { reserved, captured, released }`. Poll it, or read the latest assembly for a project:

```sh
curl "https://api.slop.cc/v1/assemblies/$ASSEMBLY_ID" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"

curl "https://api.slop.cc/v1/assemblies?projectId=$PROJECT_ID" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"
```

At `status: "completed"` the view carries `assetId`, `sizeBytes` and `sha256`. Issue a download session for the file:

```sh
curl -X POST "https://api.slop.cc/v1/assemblies/$ASSEMBLY_ID/download-links" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"

curl -L --output master.mp4 "https://api.slop.cc$DOWNLOAD_PATH"
```

The issued token is itself the whole capability, so `/v1/assembly-downloads/{token}` carries no bearer and expires on its own. Keep it out of public logs.

**Pricing.** Server assembly is included. `contract.assembly.creditsPerOutputMinute` is zero; no separate fee, reservation or debit applies. Read `serverReady` for renderer availability. Unsupported cuts stay in browser assembly.

**If server finishing is unavailable**, preserve the film and report it. Local assembly is an explicit choice (`run --assembly local`), using the same project, plan, master and verified ledger takes; it requires FFmpeg and FFprobe. Never silently change the finishing mode or fragment the film into per-scene projects.

Native status exposes `syncVerified: true` after successful presentation-clock verification, together with `sizeBytes` and `sha256`. The full internal native report is not a public download: preserve the status evidence and independently verify delivered bytes and digest. A local assembly, when explicitly chosen, returns the full JSON sync report described in [assembly.md](assembly.md). Timing verification does not judge mouth movement or take quality.

## 13. Cancel

```sh
curl -X DELETE "https://api.slop.cc/v1/assemblies/$ASSEMBLY_ID" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"
```

`DELETE /v1/assemblies/{id}` cancels a native attempt durably and returns after renderer shutdown is confirmed. Retry a 503 against the same assembly: cancellation may already be recorded. A completed output wins the race and answers `409 ASSEMBLY_ALREADY_TERMINAL`; repeated confirmed cancellation returns the same saved result. This requires the compatible private service. Assembly carries no new customer charge.

## 14. Reconcile

```sh
curl https://api.slop.cc/v1/billing/balance \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"

curl "https://api.slop.cc/v1/usage?limit=50" \
  -H "Authorization: Bearer $SLOPCANNON_AGENT_TOKEN"
```

`/v1/billing/balance` reports `availableCredits`, `reservedCredits` and `totalCredits`. It carries no email, profile, Stripe identifier or purchase history. The wallet cannot go negative.

`/v1/usage` pages that credential's own Cannon Credit ledger, newest first, one entry per wallet posting. Each entry carries a `category` of `hold`, `debit`, `refund`, `purchase`, `grant`, `grant_reversal` or `adjustment`, a signed `availableDeltaUnits` and `reservedDeltaUnits`, and a `referenceType` and `referenceId` tying it to the generation or assembly that moved it. Page with `cursor` and `limit`.

Three figures answer three different questions, and conflating them misreports spend:

- the issued quote is **exposure**, what a customer approved;
- a generation's `settlement` block is what that one job **settled**;
- `/v1/usage` is the **ledger**, every posting against the wallet.

Report exposure and settled spend separately. Missing settlement evidence is unavailable, not zero. Provider USD is internal accounting and is never a second customer charge.

People add credits at `https://slop.cc/account#buy-credits`. Read `/v1/billing/packs` for the pack catalog and the live payment-rail readiness, and use a machine rail only where its `available` flag is true; a token holding `billing:purchase` can then buy through `POST /v1/billing/mpp/purchase?packId=…` with a durable `Idempotency-Key`. Funding a wallet and approving a generation stay separate decisions: an over-ceiling project is a stop, not a top-up.

## 15. Organizations, for resellers

An organization lets one account resell SLOPCANNON to its own end customers under one wallet. Each customer owns its own projects, assets, generations and workspaces; the organization owner's prepaid balance funds all of them; and a per-customer ceiling bounds what any one of them can spend. Branch on `contract.organizations.ready`.

**Create the organization with an interactive session.** `POST https://slop.cc/api/v1/organizations` accepts `{ "name": "Your organization" }` from the signed-in account session; a personal bearer token cannot bootstrap it. This is an authenticated API action, not a promise of an organization form in the account page: it is where an account accepts that its wallet funds the organization. It returns the organization and one administration credential, plaintext once. That credential carries `organizations:manage` and reaches the rest of the surface. Keep it on your server — it can mint credentials that spend your balance.

```sh
# Create an end customer, idempotent on your own reference for it.
curl -X POST "https://api.slop.cc/v1/organizations/$ORG_ID/customers" \
  -H "Authorization: Bearer $SLOPCANNON_ORG_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"externalRef":"acct-4417","displayName":"Northwind","spendCeilingUnits":5000}'

# Issue that customer a credential. The plaintext token is returned once.
curl -X POST "https://api.slop.cc/v1/organizations/$ORG_ID/customers/$CUSTOMER_USER_ID/tokens" \
  -H "Authorization: Bearer $SLOPCANNON_ORG_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Northwind production worker","expiresInDays":90}'

# Raise, lower or remove a ceiling; suspend a customer.
curl -X PATCH "https://api.slop.cc/v1/organizations/$ORG_ID/customers/$CUSTOMER_USER_ID" \
  -H "Authorization: Bearer $SLOPCANNON_ORG_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"spendCeilingUnits":12000}'

# Bill your customers from one call.
curl "https://api.slop.cc/v1/organizations/$ORG_ID/usage?customer=acct-4417" \
  -H "Authorization: Bearer $SLOPCANNON_ORG_TOKEN"
```

The full administration surface:

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/organizations` | `POST` | Create an organization and its first admin credential (browser session) |
| `/v1/organizations/{organizationId}` | `GET` | Read an organization you administer |
| `/v1/organizations/{organizationId}/customers` | `GET`, `POST` | List end customers; create one, idempotent on `externalRef` |
| `/v1/organizations/{organizationId}/customers/{userId}` | `GET`, `PATCH` | Read one; set `spendCeilingUnits` or `status` |
| `/v1/organizations/{organizationId}/customers/{userId}/tokens` | `POST` | Issue a customer credential |
| `/v1/organizations/{organizationId}/customers/{userId}/tokens/{tokenId}` | `DELETE` | Revoke one |
| `/v1/organizations/{organizationId}/usage` | `GET` | Per-customer metering (`customer`, `cursor`, `limit`) |

Every one of them admits only an administrator of that exact organization; anyone else is told the organization does not exist. A customer credential is refused `403 INSUFFICIENT_SCOPE` before the organization is even named.

**The ceiling.** Generation reservations are checked against `spendCeilingUnits` in the same database batch as the ledger write. Releases return headroom and capture leaves credits counted as spent. Set the ceiling to `null` to bound a customer by the organization balance; suspend the customer to reject its credentials. Included assembly does not consume this ceiling.

**Per-customer usage.** `GET /v1/organizations/{id}/usage` answers one row per customer, keyed by `userId` and carrying your own `externalRef`:

| Field | Meaning |
| --- | --- |
| `generations` | scene generations that customer ran |
| `assemblies` | server assemblies that customer submitted |
| `creditsHeld` | Cannon Credits it is holding right now |
| `creditsDebited` | Cannon Credits captured for its finished work |
| `creditsRefunded` | Cannon Credits returned after a stopped or failed job |
| `generationSeconds` | seconds requested for its generations |
| `providerCostMicros`, `usageEvents` | internal provider accounting |
| `spendCeilingUnits` | the ceiling you set, or `null` |
| `spendUsedUnits` | what that ceiling counts as spent |
| `spendRemainingUnits` | what the ceiling still admits, or `null` |

Those credits are the same ledger postings that customer reads at `/v1/usage`, so the two views agree to the unit. Your own funding, grants and adjustments belong to no customer and appear in no row.

**What a customer credential reads.** Its own position, never yours.

- `GET /v1/billing/balance` answers with `scope: "organization-customer"` and the `organizationId`. `availableCredits` is the smaller of that customer's remaining ceiling and your spendable balance — exactly what its next reservation may draw — and `reservedCredits` counts only the reservations it opened. A `null` ceiling leaves your balance as the only bound. Your total never appears.
- `GET /v1/usage` pages only the postings that customer is answerable for. One customer never sees another's spend, and your funding, grants and adjustments are shown to none of them.

Your administration credential and your personal tokens are unaffected: both read your wallet and your full ledger, unnarrowed.

## 16. Run it durably

- Accept a company-level request into your own queue and return your own production ID promptly. Do not hold an HTTP request open for a whole film.
- Run one CLI process per ledger. An exclusive lock rejects overlapping commands. After a crash, verify the process stopped before removing a stale lock; retain every key and recover uncertain jobs before authorizing new spend.
- Keep the master, derived scene audio and plans, the ledger, the clips and the final report on durable storage. Input fingerprints bind actual bytes and directions; changed inputs are a separate revision, never a relabelled paid job.
- `slopcannon video status --ledger …` returns aggregate counts, budget exposure and per-scene IDs as JSON for your own UI. Download counts reflect saved receipts; the runner rehashes files before reuse.
- Exit `0` is success. Exit `2` carries a machine-readable `needs` — `rights`, `approval`, `first_scene_review`, `budget`, `new_revision` or `review`. Exit `1` is an operational error: preserve its ledger and do not start a second project automatically.
- After partial success, repeat the same `run`. Completed generations are not resubmitted and verified downloads are reused. A slow or uncertain scene does not license a replacement paid call.

The whole-project driver does all of this for you:

```sh
slopcannon video run --production production.json --ledger jobs/campaign-001.json \
  --rights-accepted "$ACCEPTED_POLICY_VERSION" --approve all --max-credits 4800 --concurrency 8
```

`4800` is an example customer-approved ceiling, not a default. The first delivered scene creates a quality checkpoint before the rest submit; review that artifact and resume with `--review-first <its exact SHA-256>`. Build that checkpoint into your own approval UI rather than fabricating review to unlock bulk work. Read `contract.productionWorkflow.maximumScenes` and `maximumDurationMs` plus `contract.workspace.maximumScenes` and `maximumBytes`: the managed workflow currently allows 120 scenes and 30 minutes, with 50 takes per scene and a 512 KiB workspace. The portable format has wider bounds; those do not enlarge hosted capacity. Renderer admission may be tighter. `--concurrency` defaults to 4 and takes 1–16 (`contract.productionWorkflow.concurrency`); 4 is only the default, not an account limit. Raising it is safe: a scene that cannot start right away waits its turn. An integration submitting scenes itself reads `contract.generation.inFlight` for how many it may keep in flight.

The song is decoded once and exact PCM ranges are copied out of that decode: on the server where `contract.generation.serverSideSlicing` is reported, locally where it is not. The whole song is never decoded once per scene.

Each provider operation has its own scene quote, while the whole film stays in one project. Upload the master and references once, request server scene chunks, and quote each scene against its chunk with original absolute times. Check persistence and workspace placement, then request included server assembly. Your worker keeps the production ledger and the final verified deliverable; SLOPCANNON performs the media slicing and finishing.

This is **client-managed batch orchestration**. Your worker drives the scenes and holds the ledger. There is no hosted whole-project batch endpoint and no completion webhook, and a successful generation status alone is not proof that a customer received a film. A worker that explicitly chooses local assembly must retain its media directory too. This changes only finishing, not project ownership or scene-audio preparation.

For a confirmed terminal failure, `slopcannon video retry-failed --scene sc13 --ledger …` stages only that scene for a fresh quote and approval. It retains the old attempt, refuses pending, unknown and successful jobs, and submits nothing. The budget conservatively includes previous failed and uncertain attempts rather than assuming a refund. Editing creative input is a separate revision, not a silent retry.

Keep company tokens scoped, isolate each customer tenant's identity and budget, and establish retention, cancellation, queue monitoring and spend reconciliation before exposing unattended large batches.


Where the manifest advertises tracked render requests, `video run` records a complete film request before its first paid scene and keeps all unsubmitted siblings through review and reconnect. `contract.renderRequests` reports mode and storage/admission readiness; declaration alone does not spend, execute the batch or start assembly. Never replace a timed-out request with another key. For tracked members, retry staging additionally reads the exact settled failed execution and saves its predecessor. The newly approved execution remains in the original film; one successor is enforced at atomic admission. Unsettled failures and uncertain submissions must be recovered, never replaced. See [render requests](hosted-api.md#complete-render-requests).

For a new tracked film using server assembly, the CLI requires
`contract.assembly.trackedFilmReady` from the app that actually serves assembly
before purchasing scenes. It attaches the original film ID automatically,
verifies the selected scene revisions and final delivery receipt, and returns
`renderRequestId` and the original `filmCompletedAt` with the verified output.
A missing readiness signal returns `needs: "origin"`; keep the ledger and resume
when the deployment is ready. Saved assembly attempts retain their original
request and key even if new tracking becomes unavailable. Local assembly is
still supported explicitly, but does not yet report a server film-completion
receipt.
