# Agent Bridge pull queue

Tiny public HTTPS host for **Agent Bridge** mobile-data command pull. The phone GETs this URL. Volga (the controller) PUTs a pending signed command. This host **does not** know the phone API token and **does not** verify HMAC — it only stores exact body bytes plus `X-Signature` and returns them once.

Repo: [github.com/JayR91/agent-bridge-pull-queue](https://github.com/JayR91/agent-bridge-pull-queue)

## Public pull URL

**Phone Desk → Agent Bridge “Command pull”:** `https://temporary-spry-fiddle-wofgonv.vercel.app/`

That is **GET /** (also `GET /pull`). Paste this exact HTTPS URL into Agent Bridge Settings. Do **not** use `/health` for command pull.

Liveness (does **not** consume a queued command):

- `GET https://temporary-spry-fiddle-wofgonv.vercel.app/health` → `{"ok":true,"service":"agent-bridge-pull-queue"}`
- `GET https://temporary-spry-fiddle-wofgonv.vercel.app/ok` → same JSON

Idle pull: `GET /` → **204 No Content**.

This host is a Vercel **anonymous production** deploy (`target: production`, project intended name `agent-bridge-pull-queue`). It **expires in about 60 minutes unless claimed**. The agent environment had no Vercel account login (`vercel whoami` → login required; Vercel MCP unauthenticated), so a durable named project could not be created from here. Claim it under JayR91 to keep the URL.

### Claim this host (do this now)

1. Open **https://vercel.com/claim-deployment?code=ebf70602-1928-483f-be74-fc5ace0484b4**
2. Sign in to Vercel with GitHub as **JayR91** (`jayradbus@gmail.com`).
3. Select your personal/Hobby team.
4. Set the project name to **`agent-bridge-pull-queue`** (exact slug).
5. Click **Transfer** / **Claim**.
6. After the dashboard opens the project: **Settings → Environment Variables**.
   - Key: `QUEUE_SECRET`
   - Environments: **Production**, **Preview**, and **Development**
   - Value: the hex already applied to this production deployment (runtime `-e`), or a new `openssl rand -hex 32` if you rotate. Never commit it. Never paste it in GitHub.
7. **Settings → Git → Connect Git Repository** → `JayR91/agent-bridge-pull-queue` → production branch `main`.
8. **Deployments → ⋮ on this production deploy → Redeploy**, or **Deploy** from `main`, so later pushes keep serving GET `/` on the same project.

If Vercel assigns `https://agent-bridge-pull-queue.vercel.app/` after the claim, use **that** as Command-pull (still GET `/`) and replace the temporary URL in this README.

Writes use `Authorization: Bearer <QUEUE_SECRET>`. HMAC for the command body uses the phone API token, not `QUEUE_SECRET`.

## Contract

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `GET` | `/health` or `/ok` | none | **200** `{"ok":true,"service":"agent-bridge-pull-queue"}`. Does not read or clear the queue. |
| `GET` | `/` or `/pull` | none | If empty: **204 No Content**. If a command is waiting: **200** with the exact stored JSON bytes and `X-Signature: <hmac hex>`, then **one-shot clear**. |
| `PUT` | `/` | `Authorization: Bearer <QUEUE_SECRET>` | Store body bytes + signature for the next phone GET. |
| `POST` | `/enqueue` | `Authorization: Bearer <QUEUE_SECRET>` | Same as `PUT /`. |
| `PUT`/`POST` | `/` | `Authorization: Bearer <QUEUE_SECRET>` + `X-Signature` | Raw body is stored as-is (preferred). |

Safety TTL is 10 minutes if nobody GETs the command. CDN caching is disabled.

### SignedCommandPayload

HMAC-SHA256 hex is computed by **Volga** over the **exact UTF-8 body bytes** using the Agent Bridge API token (not `QUEUE_SECRET`):

```json
{
  "actionId": "string",
  "params": { "k": "v" },
  "dryRun": true,
  "issuedAtEpochMs": 1730000000000,
  "nonce": "unique"
}
```

The phone verifies that HMAC, rejects payloads older than five minutes, and rejects reused nonces.

## Volga: set a command

Prefer **raw body + `X-Signature`** so the bytes the phone GETs are exactly the bytes you signed.

```bash
PULL_URL='https://temporary-spry-fiddle-wofgonv.vercel.app/'
QUEUE_SECRET='paste-from-Vercel-env'
TOKEN='paste-the-phone-api-token'   # Agent Bridge pairing token; used only for HMAC

BODY=$(jq -nc \
  --arg actionId 'arattai.clear_chat' \
  --arg chatName 'Nivetha' \
  --argjson dryRun true \
  --argjson issuedAtEpochMs "$(date +%s%3N)" \
  --arg nonce "$(openssl rand -hex 8)" \
  '{actionId:$actionId,params:{chatName:$chatName},dryRun:$dryRun,issuedAtEpochMs:$issuedAtEpochMs,nonce:$nonce}')

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$TOKEN" | awk '{print $2}')

curl -sS -X PUT "$PULL_URL" \
  -H "Authorization: Bearer $QUEUE_SECRET" \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG" \
  --data "$BODY"
```

Envelope form (same result). Send `body` as a **string** so serialization cannot change the signed bytes:

```bash
curl -sS -X POST "${PULL_URL%/}/enqueue" \
  -H "Authorization: Bearer $QUEUE_SECRET" \
  -H "Content-Type: application/json" \
  --data "$(jq -nc --arg body "$BODY" --arg signature "$SIG" '{body:$body,signature:$signature}')"
```

If `body` is a JSON object instead of a string, this host compact-`JSON.stringify`s it. That is only safe if that compact form is what you HMAC'd.

### Phone pull (empty vs waiting)

```bash
# 204 when idle
curl -sS -D - -o /dev/null "$PULL_URL"

# After Volga PUTs: 200 + JSON + X-Signature, then the slot is empty again
curl -sS -D - "$PULL_URL"
```

Point Agent Bridge Settings at `$PULL_URL`, then `POST /commands/pull` on the phone (Bearer = phone API token, not `QUEUE_SECRET`).

## Environment

| Name | Required | Purpose |
| --- | --- | --- |
| `QUEUE_SECRET` | yes (writes) | Bearer token for `PUT /` and `POST /enqueue`. Generate a long random string. Never commit it. |

Phone GET is unauthenticated on purpose: the command is already HMAC'd with the phone API token. Anyone who GETs first consumes the one-shot slot; they still cannot forge a command without the phone token.

```bash
openssl rand -hex 32
```

Set it on Vercel:

```bash
npx vercel env add QUEUE_SECRET
npx vercel --prod -e QUEUE_SECRET="$QUEUE_SECRET"
```

## Local run

```bash
cp .env.example .env
# edit .env and set QUEUE_SECRET
npm start
# listens on http://127.0.0.1:43177
npm test
```

## Deploy

This is a single Vercel Node.js Function (`api/index.js`). Pending commands live in the Vercel Runtime Cache (plus in-process memory as a fallback), one region (`iad1`).

Authenticated durable project (preferred, once JayR91 is logged in):

```bash
npx vercel login
npx vercel link --yes --project agent-bridge-pull-queue
printf '%s' "$QUEUE_SECRET" | npx vercel env add QUEUE_SECRET production preview development
npx vercel --prod --yes
```

Anonymous / agent fallback (1-hour URL + claim link):

```bash
npx vercel deploy --temporary --yes --prod --project agent-bridge-pull-queue -e QUEUE_SECRET="$QUEUE_SECRET"
```

Or in the Vercel dashboard: **Add New… → Project → Import** `JayR91/agent-bridge-pull-queue` → name it `agent-bridge-pull-queue` → add `QUEUE_SECRET` → **Deploy**. Production Command-pull is then `https://agent-bridge-pull-queue.vercel.app/` (GET `/`).
