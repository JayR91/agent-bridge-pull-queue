# Agent Bridge pull queue

Tiny public HTTPS host for **Agent Bridge** mobile-data command pull. The phone GETs this URL. Volga (the controller) PUTs a pending signed command. This host **does not** know the phone API token and **does not** verify HMAC — it only stores exact body bytes plus `X-Signature` and returns them once.

Repo: [github.com/JayR91/agent-bridge-pull-queue](https://github.com/JayR91/agent-bridge-pull-queue)

## Public pull URL

**Phone Desk → Agent Bridge “Command pull”:** `https://agent-bridge-pull-queue.vercel.app/pull/<PULL_PATH_SECRET>`

That is **GET `/pull/<PULL_PATH_SECRET>`** (the value of the `PULL_PATH_SECRET` env var, one path segment). Paste that exact HTTPS URL into Agent Bridge Settings. Do **not** use `/`, `/pull`, or `/health` for command pull. `GET /` and `GET /pull` are not pull paths.

Production is the Vercel project **`agent-bridge-pull-queue`** at `https://agent-bridge-pull-queue.vercel.app`. It is connected to this GitHub repo. A push to `main` redeploys that URL. A pull-request deploy is a preview and does not replace it.

Liveness (does **not** read the queue): `GET /health` or `GET /ok` → `{"ok":true,"service":"agent-bridge-pull-queue"}`.

Idle pull: `GET /pull/<PULL_PATH_SECRET>` → **204 No Content**.

Writes use `Authorization: Bearer <QUEUE_SECRET>`. HMAC for the command body uses the phone API token, not `QUEUE_SECRET`. The FIFO needs Upstash Redis; see **Deploy**.

## Contract

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `GET` | `/health` or `/ok` | none | **200** `{"ok":true,"service":"agent-bridge-pull-queue"}`. Does not read or clear the queue. |
| `GET` | `/pull/<PULL_PATH_SECRET>?limit=5` | path secret | **204** when empty. Otherwise **200** `{"commands":[{"id","body","signature"}]}` for the oldest pending commands (default 5, max 10). Those commands leave the FIFO. `X-Device` is stored on the pull log. |
| `GET` | `/` or `/pull` | none | **Not a pull.** Does not read the queue. |
| `PUT`/`POST` | `/pull/<PULL_PATH_SECRET>` | `Authorization: Bearer <QUEUE_SECRET>` | Append one command. **200** `{"ok":true,"id"}`. |
| `POST`/`PUT` | `/enqueue` | `Authorization: Bearer <QUEUE_SECRET>` | Same as put on the secret pull path. |
| `PUT`/`POST` | `/pull/<PULL_PATH_SECRET>` | bearer + `X-Signature` | Raw body is stored as-is (preferred). |
| `POST` | `/result/<id>` | `X-Signature` of the raw body, using the phone API token | Store the phone result. **404** if that id was never enqueued. |
| `GET` | `/result/<id>` | bearer | Poll `status`, `message` (includes a `ui.snapshot` tree), exact `body`, and `signature`. **404** until the phone posts. |
| `GET` | `/commands/<id>` | bearer | `state` is `pending`, `pulled`, or `done`. |
| `GET` | `/pull-log` | bearer | `{lastPullEpochMs, device}` from the last phone pull. |

Records live for 24 hours. CDN caching is disabled. A second enqueue does not overwrite the first.

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
ORIGIN='https://agent-bridge-pull-queue.vercel.app'
PULL_URL="$ORIGIN/pull/${PULL_PATH_SECRET}"
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
curl -sS -X POST "https://agent-bridge-pull-queue.vercel.app/enqueue" \
  -H "Authorization: Bearer $QUEUE_SECRET" \
  -H "Content-Type: application/json" \
  --data "$(jq -nc --arg body "$BODY" --arg signature "$SIG" '{body:$body,signature:$signature}')"
```

If `body` is a JSON object instead of a string, this host compact-`JSON.stringify`s it. That is only safe if that compact form is what you HMAC'd.

### Phone pull (empty vs waiting)

```bash
# 204 when idle
curl -sS -D - -o /dev/null "$PULL_URL"

# After enqueue: 200 {"commands":[{"id","body","signature"}]}
curl -sS "$PULL_URL?limit=5"

# Poll the result (Bearer is QUEUE_SECRET). Verify `body` with the phone token.
curl -sS "$ORIGIN/result/$ID" -H "Authorization: Bearer $QUEUE_SECRET"
curl -sS "$ORIGIN/pull-log" -H "Authorization: Bearer $QUEUE_SECRET"
```

Enqueue returns `{"ok":true,"id"}`. Companion 0.1.4 polls `$PULL_URL` about every 5 seconds and `POST`s `/result/<id>` itself. The bot never calls the phone's port 8765.

## Environment

| Name | Required | Purpose |
| --- | --- | --- |
| `QUEUE_SECRET` | yes (writes) | Bearer token for `PUT /pull/<PULL_PATH_SECRET>` and `POST /enqueue`. Generate a long random string. Never commit it. |
| `PULL_PATH_SECRET` | yes (phone pull) | Single URL path segment. The phone GETs `/pull/<PULL_PATH_SECRET>`. `GET /` is not a pull path. Generate a different long random string. Never commit it. |
| `UPSTASH_REDIS_REST_URL` | yes on Vercel | Upstash Redis REST URL. The Vercel Marketplace integration sets this. |
| `UPSTASH_REDIS_REST_TOKEN` | yes on Vercel | Upstash Redis REST token. Never commit it. |

Phone GET is unauthenticated beyond the unguessable path: each command is already HMAC'd with the phone API token. A pull removes the commands it returns from the FIFO. Those bytes still cannot be forged without the phone token. `GET /` does not read the queue.

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

Vercel serves this as Node.js Functions under `api/`. `vercel.json` rewrites `/pull/:secret` to `/api/pull/:secret`. The handler compares that segment with `PULL_PATH_SECRET`. On Vercel the FIFO and results are stored in Upstash Redis (`iad1`). Local `npm test` uses in-memory storage. A Vercel deploy without the Upstash env vars returns **503** on enqueue and pull instead of silently keeping one command in memory.

### Provision Upstash (required once)

The project already has `QUEUE_SECRET` and `PULL_PATH_SECRET`. It does not have Redis yet.

1. Open https://vercel.com/jayradbus-1275/agent-bridge-pull-queue/stores
2. **Create** → **Marketplace** → **Upstash Redis** (Hobby).
3. Connect the database to project **`agent-bridge-pull-queue`** for Production, Preview, and Development. That writes `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Do not rotate `QUEUE_SECRET` or `PULL_PATH_SECRET`.
4. Merging this repo's `main` redeploys production automatically (the project is connected to `JayR91/agent-bridge-pull-queue`). Until that merge, production keeps the one-slot runtime cache. A pull request deploy is a preview URL and does not replace `https://agent-bridge-pull-queue.vercel.app`.

To redeploy production by hand after the env vars exist: Vercel → project **agent-bridge-pull-queue** → Deployments → the `main` deployment → **Redeploy**.

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

Or in the Vercel dashboard: **Add New… → Project → Import** `JayR91/agent-bridge-pull-queue` → name it `agent-bridge-pull-queue` → add `QUEUE_SECRET` and `PULL_PATH_SECRET` → **Deploy**. Production Command-pull is then `https://agent-bridge-pull-queue.vercel.app/pull/<PULL_PATH_SECRET>`.
