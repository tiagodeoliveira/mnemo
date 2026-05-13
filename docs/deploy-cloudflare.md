# Deploying mnemo behind Cloudflare (TLS via Origin Certificate)

Public-internet deploy of `mnemo` fronted by Cloudflare, **without** a
Cloudflare Tunnel daemon. Cloudflare proxies traffic to your VPS over a
port-forwarded public IP and re-encrypts to the origin using a
**Cloudflare Origin Certificate** that you serve via Caddy.

```
[client] ──TLS (CF Universal cert)──▶ [Cloudflare edge] ──TLS (Origin cert)──▶ [router :443] ──port-fwd──▶ [VPS Caddy:2083] ──HTTP (docker net)──▶ [mnemo-server:8080]
```

Why this shape:

- **Universal cert** at the edge → publicly trusted; no per-device trust
  dance for CLI, extension, or auris.
- **Origin cert** on the VPS → trusted only by Cloudflare. Anyone who
  bypasses Cloudflare and hits the VPS IP directly will get a TLS
  validation failure. That's intentional.
- **No tunnel** → no `cloudflared` daemon, no extra moving part. Cost:
  you need a port reachable from Cloudflare's IP ranges (locked down
  at the router + VPS firewall).

This guide assumes the FQDN **`mnemo.tiago.tools`** as the running
example and mnemo on port **`2083`** (chosen because `8443` is conventionally
used for auris on the same VPS — see [Coexisting with auris](#coexisting-with-auris)
below). Substitute your own everywhere.

---

## 1. Cloudflare dashboard

Pick the zone that owns your apex (e.g. `tiago.tools`).

1. **DNS → Records → Add record**
   - Type: `A`
   - Name: `mnemo`
   - IPv4: your VPS **public** IP
   - Proxy status: **Proxied** (orange cloud)

2. **SSL/TLS → Overview**
   - Encryption mode: **Full (strict)**.
   - _Not_ "Flexible" (clear HTTP from CF to origin), _not_ plain
     "Full" (TLS to origin but cert not validated). Full (strict)
     validates the Origin Cert against CF's CA — that's what makes it
     bypass-resistant.

3. **SSL/TLS → Origin Server → Create Certificate**
   - If you already created a `*.tiago.tools` wildcard for auris, reuse
     it. Otherwise create one for `mnemo.tiago.tools` specifically.
   - Private key type: RSA (2048).
   - Validity: 15 years (the max).
   - Click **Create**. The certificate PEM and the private key PEM are
     shown **once**. Copy both into your password manager now.

4. **Rules → Origin Rules → Create rule** (required for the non-default port)
   - Name: `mnemo origin port`
   - When incoming requests match → **Hostname equals** `mnemo.tiago.tools`
   - Then → **Override origin destination port** → `2083`
   - Deploy.

   This tells CF's proxy: keep terminating user TLS on the public `:443`,
   but when forwarding to your origin, talk to `:2083`. The user still
   hits `https://mnemo.tiago.tools/` with no port in the URL.

5. **(Recommended) SSL/TLS → Edge Certificates → Always Use HTTPS**: On.

---

## 2. Drop the cert files on the VPS

```bash
cd /path/to/mnemo
mkdir -p certs && chmod 700 certs
$EDITOR certs/cert.pem    # paste the Origin Certificate PEM block
$EDITOR certs/key.pem     # paste the private key PEM
chmod 600 certs/cert.pem certs/key.pem
```

`certs/` is gitignored. If you already have these PEMs at `auris/certs/`
because you reused the wildcard, you can `cp` them across.

---

## 3. Wire up Caddyfile + env

```bash
cp Caddyfile.example Caddyfile
cp .env.deploy.example .env.deploy
$EDITOR .env.deploy
```

Required `.env.deploy` values (see file for the full annotated list):

```bash
GHCR_OWNER=tiagodeoliveira
SERVER_TAG=latest
POSTGRES_PASSWORD=<generate a strong one — `openssl rand -base64 32`>
PUBLIC_DOMAIN=mnemo.tiago.tools
PUBLIC_PORT=2083

AUTH0_DOMAIN=dev-jrva0wzk3qkdxcar.us.auth0.com
AUTH0_API_AUDIENCE=https://mnemo.tiago.tools

ANTHROPIC_API_KEY=sk-ant-...

# Optional, for daily-digest emails
SMTP_HOST=smtp.fastmail.com:587
SMTP_USER=you@your-domain.example
SMTP_PASS=<app password>
SMTP_FROM=mnemo@your-domain.example
```

The shipped `Caddyfile.example` reads `{$DOMAIN}` and `{$PORT}` from the
environment and bind-mounts the certs from `certs/`. No further edits
needed for the standard path.

---

## 4. Coexisting with auris

The compose default `PUBLIC_PORT` was chosen to **not collide with auris**:

| Service | Default port | Cloudflare hostname |
|---|---|---|
| auris  | `8443` | `auris.tiago.tools` |
| mnemo  | `2083` | `mnemo.tiago.tools` |

Both run their own Caddy and their own Postgres container. They're
independent — restarting mnemo doesn't touch auris.

Both ports must be in [Cloudflare's HTTPS origin-port allowlist](https://developers.cloudflare.com/fundamentals/reference/network-ports/#network-ports-compatible-with-cloudflares-proxy):

> `443, 2053, 2083, 2087, 2096, 8443`

If you ever flip to a different port, update `PUBLIC_PORT` in
`.env.deploy` **and** the Cloudflare Origin Rule.

---

## 5. Home router / firewall port-forwarding

Forward **TCP `:2083`** on the public WAN → VPS LAN IP `:2083`.

If you previously locked the firewall to Cloudflare IPs for auris on
`:8443`, repeat the same rules for `:2083`:

```bash
# Default-deny on 2083 first.
sudo ufw deny 2083/tcp

# Allow only Cloudflare IPv4 ranges.
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow from "$ip" to any port 2083 proto tcp
done

# Repeat for IPv6 if your router forwards IPv6.
for ip in $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow from "$ip" to any port 2083 proto tcp
done

sudo ufw status numbered
```

Cloudflare's IP list changes occasionally — a monthly cron that rebuilds
these rules keeps you current.

---

## 6. Auth0 setup

mnemo uses **one API** + **two applications** in the same Auth0 tenant
that auris uses (or its own tenant — both work):

1. **API** — Dashboard → Applications → APIs → Create API
   - Name: `mnemo`
   - Identifier (this becomes the audience): `https://mnemo.tiago.tools`
   - Signing algorithm: RS256
   - **Settings → Allow Offline Access: On** (needed so the CLI gets a
     refresh token in the device-flow response)

2. **Native application** (for CLI + Chrome extension) — Applications → Create
   - Type: **Native**
   - Name: `mnemo-cli`
   - Settings → Advanced → Grant Types:
     - ✅ `Device Code`
     - ✅ `Refresh Token`
     - everything else off
   - The `Client ID` here is what gets baked into the CLI and extension
     as the default. The CLI's `~/.mnemo/config.json` and the extension's
     options page can override it for users running their own tenant.

3. **Machine-to-Machine application** (for auris) — Applications → Create
   - Type: **Machine to Machine**
   - Name: `auris→mnemo`
   - Authorize for the `mnemo` API (selected scopes: leave empty — mnemo
     trusts any valid token from this M2M app)
   - The `Client ID` + `Client Secret` here go into auris's
     `.env.deploy` as `AURIS_MNEMO_M2M_CLIENT_ID` and
     `AURIS_MNEMO_M2M_CLIENT_SECRET`. **The secret never leaves that file.**

No callback URLs / web origins to configure — mnemo's clients use
device flow (CLI, extension) and client_credentials (auris), neither
of which involves a browser redirect to the API host.

---

## 7. Boot the stack

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u tiagodeoliveira --password-stdin
cd /path/to/mnemo
docker compose -f docker-compose.deploy.yml --env-file .env.deploy pull
docker compose -f docker-compose.deploy.yml --env-file .env.deploy up -d
```

Verify the three containers:

```bash
docker compose -f docker-compose.deploy.yml ps
# Expect: mnemo-postgres, mnemo-server, mnemo-caddy — all "running (healthy)"
```

Tail logs:

```bash
docker compose -f docker-compose.deploy.yml logs -f caddy mnemo
```

You should see Caddy boot with `serving initial configuration` and
`mnemo.tiago.tools` in its listeners list, plus the mnemo server's
`listening addr=:8080` and `migrations applied` lines.

---

## 8. Smoke test

From your laptop (**not** the VPS):

```bash
# 1. Health endpoint via Cloudflare → Caddy → mnemo
curl -i https://mnemo.tiago.tools/healthz
# Expect: 200 {"db":true,"ok":true}
```

```bash
# 2. CLI device-flow login
cd ~/src/github.com/tiagodeoliveira/mnemo/cli
npm run build && npm link
mnemo login
# Opens browser to Auth0 verification URL with the device code prefilled.
# Approve. Credentials land at ~/.mnemo/credentials.json (mode 0600).
```

```bash
# 3. Push an event, recall it
mnemo push --session "smoke-$(date +%s)" \
  --turns '[{"role":"user","content":"smoke test from $(hostname)"}]' \
  --source manual
sleep 10   # let the worker run extract_context
mnemo recall --about --visible=false
# Expect JSON containing a "dimension":"about" group with the extracted bio.
```

```bash
# 4. Meeting end-to-end (the most complex path)
TOKEN=$(jq -r .access_token ~/.mnemo/credentials.json)
curl -s -X POST https://mnemo.tiago.tools/events \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"session_id":"meeting-smoke","turns":[{"role":"user","content":"Speaker 1 hi"}],"attributes":{"meeting_id":"smoke","meeting_ended":true}}'
sleep 15
curl -s "https://mnemo.tiago.tools/recall?meeting=smoke&visible=false" \
  -H "Authorization: Bearer $TOKEN" | jq .
# Expect: 6 meeting category rows (summary, decisions, actions, questions, highlights, followups).
```

---

## 9. Provision the second actor

Your wife (or any second actor) runs `mnemo login` from her own
machine. Auth0 issues her a separate `sub` claim; the server auto-inserts
a row in `actors` on first request.

To enable daily digest delivery for her, edit her row via psql:

```bash
docker compose -f docker-compose.deploy.yml exec postgres \
  psql -U mnemo -d mnemo

# In the psql prompt:
SELECT actor_id, display_name, email, digest_enabled FROM actors;
# Find her actor_id (looks like auth0|abc123...)

UPDATE actors SET
  display_name = 'her-name',
  email        = 'her@example.com',
  timezone     = 'America/Los_Angeles',
  digest_enabled = true
WHERE actor_id = 'auth0|...';
```

---

## 10. Point auris at the new mnemo

On the VPS, edit `auris/.env.deploy`:

```bash
AURIS_MNEMO_URL=https://mnemo.tiago.tools
AURIS_MNEMO_M2M_CLIENT_ID=<from the Auth0 M2M app>
AURIS_MNEMO_M2M_CLIENT_SECRET=<from the Auth0 M2M app — secret-grade>

# Optional (defaults shown):
# AURIS_MNEMO_AUTH0_DOMAIN=dev-jrva0wzk3qkdxcar.us.auth0.com
# AURIS_MNEMO_AUDIENCE=https://mnemo.tiago.tools
```

Then:

```bash
cd ~/auris
docker compose -f docker-compose.deploy.yml up -d server
docker compose -f docker-compose.deploy.yml logs -f server | grep mnemo
# Look for: "mnemo client enabled (M2M)" and later "mnemo M2M token refreshed"
```

Open a meeting in auris and watch `~/mnemo/docker compose logs -f mnemo`:
events should arrive every few seconds while the meeting is active.

---

## 11. Update the Chrome extension

The mnemo Chrome extension's stored config still points at the old AWS
URL. On each machine where it's installed:

1. Open `chrome://extensions` → **Details** on mnemo capture → **Extension options**
2. Replace **mnemo API base URL** with `https://mnemo.tiago.tools`
3. Click **Sign in with Auth0** — a tab opens to the Auth0 device-code
   page; approve it.
4. Confirm the "Signed in" status indicator turns green.
5. Click **Test push** to verify the round-trip.

---

## 12. Cutover from the old AWS stack

Two checkpoints before tearing down AWS:

**T+0 (now)**: New mnemo is the source of truth. The old AWS stack is
still running but no client points at it.

**T+7 days**: Verify zero `failed` jobs:

```bash
docker compose -f docker-compose.deploy.yml exec postgres \
  psql -U mnemo -d mnemo -c \
  "SELECT job_id, kind, attempts, last_error FROM jobs WHERE state='failed' ORDER BY job_id DESC LIMIT 20;"
# Expect: 0 rows.
```

And scan the logs for `ERROR`:

```bash
docker compose -f docker-compose.deploy.yml logs --since 168h mnemo | grep -iE 'error|warn' | head -50
```

If both look clean, destroy the AWS stack:

```bash
cd ~/src/github.com/tiagodeoliveira/mnemo/infra
npx cdk destroy
```

Then remove `infra/` from the repo and rewrite the README to describe
the self-hosted shape:

```bash
cd ..
git checkout -b cleanup/remove-aws-stack
git rm -r infra/
$EDITOR README.md   # replace the AWS architecture section, refresh deploy steps
git commit -am "cleanup: remove AWS CDK stack and update README for self-hosted shape"
gh pr create --base main --title "mnemo Go rewrite: self-hosted, Postgres-backed"
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `curl https://mnemo.tiago.tools/healthz` returns `522` | Port-forward not working, or VPS firewall blocks CF's IPs on `:2083`. From a third-party VM (e.g. another cloud), try `nc -vz <your-public-ip> 2083` — if it hangs, the path is broken upstream of the VPS. |
| `525` from Cloudflare | TLS handshake to origin failed. Either Caddy isn't running, the cert hostname doesn't match `$DOMAIN`, or the cert PEM is malformed. `docker compose logs caddy`. |
| `526` from Cloudflare | Origin cert didn't validate against CF's CA. Most often: you pasted a Let's Encrypt cert into `certs/cert.pem` by mistake — it must be the **Origin Certificate** from CF's dashboard. |
| `530` / `1014` from Cloudflare | The Cloudflare Origin Rule for the port override is missing or has the wrong hostname. Re-check step 1.4. |
| `401 invalid token` on requests | Auth0 token rejected. Check `AUTH0_DOMAIN` and `AUTH0_API_AUDIENCE` in `.env.deploy` match the API audience configured in Auth0. The audience must include the trailing `/` only if Auth0 reports it that way — check the API's identifier in the Auth0 dashboard. |
| Jobs sit in `pending` / `running` forever | The worker pool isn't getting handler registrations. Check `docker compose logs mnemo` for `claim` errors. Most likely a missing env var (`ANTHROPIC_API_KEY` when `MNEMO_LLM_DISABLED` is unset) — the LLM client init exits the process with code 7. |
| Jobs end in `failed` with `consolidation hit max_tokens` | A single event's extraction has overflowed the model's response budget. Bump `MaxTokens` in the relevant handler (extract: 4096, meeting: 8192, digest: 8192 by default) or inspect the source event for an unusually long transcript. |
| Daily digest never fires | Check the actor's `timezone` (must be a valid IANA name, e.g. `America/Los_Angeles`) and `digest_enabled = true`. The scheduler only fires when local hour matches the hardcoded `DigestHour=19` (7pm) — if you want a different hour, change `digestHour` in `main.go`. |
| Daily digest stores but doesn't email | `SMTP_HOST`/`USER`/`PASS`/`FROM` not all set, or the actor's `email` column is `NULL`. The digest still succeeds; only delivery skips. |
| Auris logs `mnemo client disabled` | `AURIS_MNEMO_URL` or one of the M2M credential vars is missing in `auris/.env.deploy`. |
| Auris logs `auth0 token error` | The M2M client_secret is wrong, or the M2M app isn't authorized for the mnemo API audience. |
| `https://<vps-public-ip>:2083` (raw IP, no proxy) loads | Your firewall isn't blocking non-CF IPs. Re-check step 5. The Origin Cert will fail browser validation regardless, but the port shouldn't even be reachable. |

---

## Operational notes

- **Where to look first** when something seems wrong:
  ```bash
  # The single best dashboard:
  docker compose -f docker-compose.deploy.yml exec postgres \
    psql -U mnemo -d mnemo -c \
    "SELECT job_id, kind, state, attempts, last_error, run_after FROM jobs ORDER BY job_id DESC LIMIT 20;"
  ```
  `pending`/`running` jobs that aren't draining → worker pool issue. `failed`
  jobs → inspect `last_error`. Empty queue → the pipeline is healthy.

- **Cert rotation**: CF Origin Certs default to 15-year validity, so
  rotation is rare. When you do rotate: regenerate via the CF dashboard,
  replace `certs/cert.pem` and `certs/key.pem` on the VPS, then
  `docker compose -f docker-compose.deploy.yml restart caddy`.

- **The Origin Cert is meant to _only_ be valid via Cloudflare.** If
  you flip the DNS record from "Proxied" to "DNS only" (grey cloud),
  browsers will reject the TLS handshake. That's the feature, not a bug.

- **Backups**: the only stateful volume is `mnemo-pg-data`. Snapshot
  it (or `pg_dump`) on a cadence you're comfortable with. The
  `events` table is the source of truth — every memory can be
  recomputed by replaying events through the extractors (slow but
  doable), but the LLM costs would recur.
