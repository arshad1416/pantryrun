# Deploying the hosted PantryRun relay (`wss://relay.pantryrun.app`)

New installs of the app sync through `wss://relay.pantryrun.app` (port 443) by
default (`src/config/settings.ts` → `HOSTED_RELAY_URL`). This is the same
open-source relay self-hosters run (`relay-server/`), published through a
**Cloudflare Tunnel** so the Raspberry Pi needs no public IP, no router port
forwarding and no certificate of its own. Later it can move to an Oracle Cloud
Always Free VM under the same hostname (last section).

Nothing here was executed; these are the steps to run.

```
phone ──wss/https──▶ Cloudflare edge (TLS, relay.pantryrun.app)
                        │  outbound-only tunnel
                        ▼
Pi: docker compose ─ cloudflared ──http://relay:8080──▶ relay (Node)
                                                    ├─▶ Turso (stophop DB, read-only)
                                                    └─▶ Ollama on the Pi host  or  DashScope (Qwen-VL)
```

Files involved (repo root unless noted):

| File | Role |
|---|---|
| `docker-compose.yml` | `relay` service (self-host defaults) + `cloudflared` service under the `hosted` profile |
| `.env.hosted.example` | Every hosted setting, commented. Copy to `.env` (gitignored) |
| `relay-server/keys/` | Blind-token issuer keypair, generated on the Pi, gitignored, mounted read-only |
| volume `groceryapp-relay-data` | All relay state (`/data`): enrollments, spent tokens, encrypted updates (30-day TTL) |

---

## 1. Prerequisites on the Pi

64-bit Raspberry Pi OS (the image is built for `linux/arm64`), Docker Engine with
the compose plugin:

```sh
uname -m                      # aarch64
docker --version && docker compose version
# If missing:
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker
```

Clone (or update) the repo:

```sh
cd ~ && git clone https://github.com/arshad1416/pantryrun.git   # first time
cd ~/pantryrun && git pull                                       # later
```

## 2. Generate the blind-token issuer keys (once)

Token issuance and the anonymous price pool fail closed without them. Generated
on the Pi, never committed, never baked into the image:

```sh
cd ~/pantryrun
docker compose build relay   # the keygen needs the relay's npm dependencies
mkdir -p relay-server/keys
docker run --rm --user 1000:1000 -v "$PWD/relay-server/keys:/app/keys" \
  groceryapp-relay:latest node tokens/blind-rsa-keygen.js
chmod 600 relay-server/keys/issuer-private-key.pem
ls -l relay-server/keys/      # issuer-private-key.pem, issuer-public-key.pem
```

(The keygen runs inside the built relay image because a bare `node` image
lacks `@cloudflare/blindrsa-ts`. `--user 1000:1000` makes the files owned by the
uid the container's `node` user runs as, so the read-only mount is readable. If
Node is installed on the Pi, `cd relay-server && npm install && node
tokens/blind-rsa-keygen.js` is equivalent.)
Rotating this pair invalidates outstanding blind tokens — see
`relay-server/KEY-ROTATION.md`. Back it up with the data volume (§9).

## 3. Read-only Turso token for live prices

Both tables the relay reads live in the **StopHop** database
`https://stophop-arshad1416.aws-us-east-1.turso.io`: `flipp_deals` is written by
`hermes-scripts/weekly_flipp_scrape.py` (via `flippscrape.write_turso(…,
turso_url=STOPHOP_TURSO_URL)`), and `store_prices` by
`hermes-scripts/store_prices_scrape.py` (`STOPHOP_TURSO_URL`). The relay only
ever runs `SELECT`s, so give it a **read-only** token. On the machine with the
Turso CLI logged in:

```sh
turso db list                                   # confirm the db name (expected: stophop)
turso db tokens create stophop --read-only      # prints the token
```

Do not reuse `~/.hermes/stophop_turso_token.txt` — that one can write.

## 4. Create the Cloudflare Tunnel and public hostname

In the Cloudflare dashboard (account that owns `pantryrun.app`):

1. **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**.
2. Connector type **Cloudflared** → Next. Name it `pantryrun-relay` → Save tunnel.
3. "Choose your environment": pick **Docker**. The page shows
   `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJh…`.
   Copy **only the token** (the long `eyJ…` string) — it goes in `.env` as
   `TUNNEL_TOKEN`. Don't run that command; compose runs cloudflared. Next.
4. **Public Hostnames** tab → **Add a public hostname**:
   - Subdomain: `relay`
   - Domain: `pantryrun.app`
   - Path: *(empty)*
   - Service → Type: `HTTP`, URL: `relay:8080`
     (the compose service name; cloudflared and the relay share the
     `groceryapp-network` network)
   - Leave *Additional application settings* at defaults. WebSockets are proxied
     automatically over the tunnel; no TLS settings apply to an `http://` origin.
   - Save hostname. Cloudflare creates the proxied DNS record
     `relay.pantryrun.app CNAME <tunnel-id>.cfargotunnel.com`. If a
     `relay` record already exists in DNS, delete it first or the save fails.
5. In the **pantryrun.app** zone (not Zero Trust): **Network** → make sure
   **WebSockets** is **On** (default on all plans).
6. Do **not** put a Cloudflare Access application or a "Bot Fight"/challenge rule
   in front of `relay.pantryrun.app`: the app cannot answer an interactive
   challenge, so sync and enrollment would silently fail.

## 5. Configure `.env`

```sh
cd ~/pantryrun
cp .env.hosted.example .env && chmod 600 .env
nano .env
```

Fill in `TUNNEL_TOKEN` (step 4) and `TURSO_READ_TOKEN` (step 3). The rest is
pre-set for the hosted relay:

| Variable | Hosted value | Why |
|---|---|---|
| `RELAY_BIND` | `127.0.0.1` | Relay ports reachable only from the Pi itself; the tunnel uses the compose network |
| `TRUST_PROXY` / `TRUSTED_PROXY_HOPS` | `true` / `1` | Per-IP rate limits key on the client IP, not on cloudflared (see §8) |
| `POOL_PORT` | `8080` | Pool on the relay origin; the current app reads pool prices from the relay origin |
| `MAX_FAMILIES` | `500` | Capacity cap; the container is limited to 0.5 CPU / 256 MB |
| `TURSO_URL` | StopHop DB URL | Live deals / shelf prices |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Pi host Ollama | Flyer extraction, option A |
| `QWEN_API_KEY`, `QWEN_BASE_URL` | empty / intl endpoint | Flyer extraction, option B |

### Flyer extraction: choose one

**Option A — Ollama on the Pi (free, photos never leave the Pi).** Ollama must
listen on the docker bridge, not just loopback, and have a vision model:

```sh
sudo systemctl edit ollama
#   [Service]
#   Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl restart ollama
ollama pull qwen2.5-vl:7b          # or a smaller vision model (see caveat)
curl -s http://127.0.0.1:11434/api/tags | head -c 300
```

Caveats, measured against the code: the relay waits up to
`OLLAMA_TIMEOUT_MS` = 120 s for CPU inference, but **Cloudflare returns 524 if
the origin has not answered within 100 s**, so a slow Pi run fails at the edge
even when Ollama eventually succeeds. `qwen2.5-vl:7b` also needs ~6 GB of RAM on
a box that already runs Home Assistant and the other Pi services. Test one flyer
end to end (§7) before relying on this; if it is too slow, use a smaller vision
model via `OLLAMA_MODEL`, point `OLLAMA_URL` at a faster machine on the LAN, or
use option B. Port 11434 should stay firewalled from the internet.

**Option B — Alibaba Cloud Model Studio (DashScope, Qwen-VL).** Set
`QWEN_API_KEY` (an API key from the **international** Model Studio console, which
matches the pre-set `dashscope-intl` Singapore endpoint; a mainland-China key
needs the default endpoint instead — clear `QWEN_BASE_URL`). Flyer photos are
then sent to Alibaba Cloud; the privacy policy (§7) already discloses this. When
`QWEN_API_KEY` is set it is used for extraction; otherwise Ollama is.

## 6. Start it

```sh
cd ~/pantryrun
docker compose --profile hosted up -d --build
docker compose ps                       # relay: healthy, cloudflared: running
docker compose logs -f cloudflared      # "Registered tunnel connection" x4
```

`--profile hosted` is what starts `cloudflared`; a plain `docker compose up -d`
stays the self-host stack.

## 7. Verify

If port 8080 is already taken on the host, publish the relay on other host
ports in an untracked `docker-compose.override.yml` (for example
`127.0.0.1:18080:8080`) and use that port below. The tunnel reaches
`relay:8080` over the compose network, so it is unaffected.

```sh
# On the Pi, straight to the relay:
curl -s http://127.0.0.1:8080/health          # {"status":"ok","version":"2.0"}

# Through Cloudflare, from anywhere:
curl -s https://relay.pantryrun.app/health    # {"status":"ok","version":"2.0"}

# WebSocket upgrade through the tunnel (expect "HTTP/1.1 101 Switching Protocols"):
curl -si --http1.1 -N --max-time 5 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://relay.pantryrun.app/ | head -1

# Price routes are wired (401 = auth required, which is correct without a token):
curl -s -o /dev/null -w "%{http_code}\n" "https://relay.pantryrun.app/api/prices/deals?fsa=L0R"

# Turso read token works (row counts, from inside the container):
docker compose exec relay node -e "
const t=require('./prices/turso-reader');
Promise.all(['flipp_deals','store_prices'].map(n=>t.query('SELECT COUNT(*) AS n FROM '+n)))
 .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exit(1)})"

# Rate-limit keying (should print nothing after a few real requests):
docker compose logs relay | grep '\[rate-limit\]'
```

Then in the app (fresh install, or one that still had the old `ws://localhost`
default — it migrates once): Settings → Sync Server shows **PantryRun (Free)**;
**Test Connection** → "Connection Successful". Create an invite on one phone,
join on a second, edit a list on each. Scan one flyer to check extraction.

## 8. Client IPs and rate limiting behind Cloudflare

`relay-server/server.js` (`clientIp`) never reads `CF-Connecting-IP`. With
`TRUST_PROXY=true` it takes the X-Forwarded-For entry `TRUSTED_PROXY_HOPS` from
the **right**. Cloudflare's edge *appends* the connecting client's IP to any
X-Forwarded-For the client sent, and cloudflared forwards that header to the
origin unchanged, so with `TRUSTED_PROXY_HOPS=1` the relay keys on the real
client IP and a forged leading entry is ignored. That works with **no code
change**. Two caveats to know:

- The relay must not be reachable except through the tunnel, or a direct caller
  could send any X-Forwarded-For. `RELAY_BIND=127.0.0.1` handles that on the Pi;
  on a cloud VM keep 8080/8081 closed in the security list (§10).
- It relies on Cloudflare's append behaviour. A more robust follow-up (not done
  here — `server.js` is outside this change) is an opt-in such as
  `TRUST_CF_CONNECTING_IP=true` that keys on `CF-Connecting-IP`, which Cloudflare
  always overwrites. If the `[rate-limit]` warnings in §7 ever appear, or all
  families start sharing one budget, make that change.

## 9. Operating it

```sh
# Update to the latest code:
cd ~/pantryrun && git pull && docker compose --profile hosted up -d --build

# Back up state + keys (run regularly; keep off the Pi):
docker run --rm -v groceryapp-relay-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/relay-data-$(date +%F).tgz -C /data .
tar czf relay-keys-$(date +%F).tgz relay-server/keys .env

# Logs / restart:
docker compose logs --tail=200 relay
docker compose --profile hosted restart
```

To delete a family's relayed data on request (privacy policy §10), stop the relay
and remove that family's entries from `data/encrypted-updates.json` in the
volume, or wait for the 30-day expiry.

## 10. Moving to Oracle Cloud Always Free later

Same compose file, same hostname, same tunnel; only the machine changes.

1. Create an **Ampere A1** (arm64) VM — Always Free allows up to 4 OCPU / 24 GB —
   with Ubuntu 24.04. No ingress rules are needed beyond SSH: the tunnel is
   outbound-only. Keep 8080/8081 closed.
2. On the VM: install Docker (§1), clone the repo, copy over `.env`,
   `relay-server/keys/` and the latest `relay-data-*.tgz` from §9.
3. Restore state **before** first start so enrollments and pending updates carry
   over:
   ```sh
   docker volume create groceryapp-relay-data
   docker run --rm -v groceryapp-relay-data:/data -v "$PWD":/backup alpine \
     tar xzf /backup/relay-data-YYYY-MM-DD.tgz -C /data
   ```
4. Cut over: on the Pi `docker compose --profile hosted down`, take a final
   backup and restore it on the VM, then on the VM
   `docker compose --profile hosted up -d --build`. Reusing the same
   `TUNNEL_TOKEN` means **no DNS change** — `relay.pantryrun.app` follows the
   tunnel to wherever cloudflared runs. Never run both at once: the tunnel
   would load-balance between two relays with different state.
5. Verify with §7, then update privacy policy §13 ("Where data goes") with the
   provider and region before or when you switch.

If Ollama extraction was on the Pi, either keep `OLLAMA_URL` pointing at a
machine you control or switch to option B; the VM's 24 GB makes running Ollama
there an option too.
