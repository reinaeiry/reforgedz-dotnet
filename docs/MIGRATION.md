# Moving the shop to another server

This is the runbook for standing reforgedz.net's shop up on a different host. It covers
the shop: the Node app, its database, its secrets and every outside thing it talks to.
The other systems on the same box (panel, game servers, mail, bots) get a line each at
the end so nothing is forgotten, not their own runbooks.

The tools it relies on live in `tools/` and run with `npm run <name>`:

| Command | Does |
|---|---|
| `npm run doctor` | Checks every integration read-only. `-- --deep` also compares each game server's files with the database and every owed Discord role. `-- --offline` checks only config, database, files and backups (for a fresh restore). Exit 1 on any FAIL. Also `GET /api/shop/admin/doctor`. |
| `npm run backup` | Takes a snapshot now. The app takes one itself every night at 03:30 UTC and copies it to `BACKUP_OFFSITE` (`na`, `r2`). |
| `npm run pack` | One `.tar.gz` with everything a new host needs. `.env` goes in encrypted only when a passphrase is given (`PACK_PASSPHRASE` or `-- --passphrase-file`). |
| `npm run restore -- <pack>` | Puts a pack back. `--rehearsal` makes a copy that cannot charge, email, message or touch a game server. |
| `npm run env:example` | Regenerates `.env.example` from `tools/lib/envManifest.js`, the one list of every variable. |

## 1. Any day before: be ready to move

1. `npm run doctor -- --deep` on the live shop is green, or every WARN is understood.
2. The nightly backup ran last night and both offsite copies are fresh: the `backup.local`
   and `backup.offsite` lines of the doctor.
3. You hold the pack passphrase in your password manager. Without it a pack restores
   everything except the secrets, and the secrets are the slow part to recreate.
4. A rehearsal has been done at least once (section 4). That, not this document, is what
   "we can move it" rests on.

### R2, one-time setup

Cloudflare dashboard, the account that owns the zone:

1. **R2 Object Storage → Create bucket** → name `reforgedz-shop-backups`, location automatic.
2. **R2 → Manage R2 API Tokens → Create API token** → permission **Object Read & Write**,
   scoped to that one bucket, TTL forever. Copy the Access Key ID and Secret Access Key
   once; they are not shown again.
3. The Account ID is on the R2 overview page.
4. In the shop's `.env`: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, and `BACKUP_OFFSITE=na,r2`. Restart, then
   `npm run backup` and `npm run doctor -- --deep` should show `r2 ... ago`.

## 2. What travels

Everything the pack carries, and where it goes on the new host:

| Item | In the pack as | Goes to |
|---|---|---|
| `shop.db` | consistent snapshot, integrity-checked | `DATA_DIR/shop.db` |
| `sessions-store.db` | snapshot | `DATA_DIR/` (nobody is signed out by the move) |
| `uploads/` | copy | `DATA_DIR/uploads/` |
| `radio-stats.json`, `nattiiguard-stats.json` | copy | `DATA_DIR/` |
| `.env` | `env.enc.json` (AES-256-GCM, scrypt) | the app directory, decrypted by `restore` |
| variable names | `env.names.json` | read by `restore` to say what is missing |
| `MANIFEST.json` | commit, node, counts, sha256 per file, servers, whether host keys are pinned | compared by `restore` |

Not in the pack, because it is in git: the code, `radio/` (883 MB), `public/downloads`,
`public/map`. Not in the pack and not needed: `node_modules` (`npm ci` rebuilds it),
`backups/` (the new host starts its own; the old ones are in R2).

## 3. The new host

Two ways to run it. Both use the same code and the same pack.

### 3a. Plain Docker host (recommended)

```bash
# as a normal user with docker access
git clone https://github.com/reinaeiry/reforgedz-dotnet.git shop && cd shop
mkdir -p data && sudo chown -R 1000:1000 data          # uid 1000 = "node" in the image
# copy the pack here, then:
node tools/restore.js shop-pack-....tar.gz --into ./data --passphrase-file /path/to/passphrase
sudo chown -R 1000:1000 data
# .env was written by restore. Edit the lines that change with the host (section 5).
GIT_SHA=$(git rev-parse HEAD) TUNNEL_TOKEN='<token>' docker compose up -d --build
docker compose exec shop npm run doctor
```

`restore` needs Node on the host for the one command (`better-sqlite3` reads the pack's
database). If the host has no Node, run it inside the image instead:

```bash
docker compose run --rm -v "$PWD:/restore" shop node tools/restore.js /restore/shop-pack-....tar.gz --into /data --passphrase-file /restore/passphrase --env-out /restore/.env
```

The tunnel: in Zero Trust → Networks → Tunnels → the tunnel → **Published application
routes**, point `reforgedz.net` and `wifi.reforgedz.net` at `http://shop:3000`. Either reuse
the existing tunnel's token on the new host (the old connector keeps working until you stop
it; two connectors on one tunnel is fine) or create a new tunnel and move the routes.

### 3b. Another Pterodactyl node

Create a server from the **Node.js** egg (`ghcr.io/ptero-eggs/yolks:nodejs_25` or newer),
memory 4096 MB, one allocation on the docker bridge (today `172.18.0.1:3000`). Variables:

| Variable | Value |
|---|---|
| `GIT_ADDRESS` | `https://github.com/reinaeiry/reforgedz-dotnet` |
| `BRANCH` | blank (main) |
| `AUTO_UPDATE` | `1` (a restart pulls `main` and is the deploy) |
| `MAIN_FILE` | `server.js` |
| `NODE_PACKAGES`, `UNNODE_PACKAGES`, `NODE_ARGS` | blank |

Start it once so it clones, then stop it and restore into the volume as root:

```bash
V=/var/lib/pterodactyl/volumes/<new-uuid>
cd $V && sudo node tools/restore.js /path/shop-pack-....tar.gz --into $V --passphrase-file /path/passphrase --force
sudo chown -R pterodactyl:pterodactyl $V     # or the uid:gid wings uses (999:987 today)
```

Leave `DATA_DIR` unset: the egg layout keeps data next to the code, as today. Start the
server; the boot log must show `ReforgedZ.net running on port 3000` and both
`[paypal] webhook ready` lines. Then `sudo docker exec <uuid> sh -lc 'cd /home/container && npm run doctor'`.

### 3c. Rehearsal (do this before you need it)

On any machine with Docker, using a real pack:

```bash
node tools/restore.js shop-pack-....tar.gz --into ./data-rehearsal --rehearsal --port 3010 \
  --passphrase-file /path/to/passphrase --env-out ./.env.rehearsal
docker compose -f compose.yaml -f compose.rehearsal.yaml up -d --build shop
docker compose -f compose.yaml -f compose.rehearsal.yaml exec shop npm run doctor
# open http://localhost:3010/shop  and  http://localhost:3010/account
docker compose -f compose.yaml -f compose.rehearsal.yaml down
```

The rehearsal copy has every outbound credential blanked and `SHOP_REHEARSAL=1`; the doctor
reports those as SKIP rather than FAIL. The products page, the account page and the admin
pages all work from the restored data. Nothing it does can reach PayPal, mail, Discord or a
game server. Delete `data-rehearsal/` and `.env.rehearsal` afterwards; they hold customer data.

## 4. The move itself

Order matters. Renewals arrive as PayPal webhooks at any hour, so the window where neither
copy is behind the domain should be minutes, and the old copy must not take a payment the new
one never sees.

1. **Announce** a short maintenance window (players see nothing but a pause in purchases).
2. **New host ready**: sections 3a or 3b done with yesterday's pack, `npm run doctor` green
   apart from `public` (the domain still points at the old copy) and `backup.*` (no run yet).
3. **Freeze the old copy**: stop it from the panel (power → stop). From now on PayPal's
   webhooks fail delivery and PayPal retries them for up to three days, so nothing is lost.
4. **Final pack** on the old volume: `node tools/pack.js --passphrase-file ...` (the app is
   stopped, so this is the complete final state). Copy it to the new host.
5. **Restore the final pack** on the new host with `--force`, then start it.
6. **Point the domain**: switch the tunnel route (or start the connector on the new host and
   stop the old one). `curl https://reforgedz.net/api/shop/version` must show the new host's
   commit.
7. **Doctor, full**: `npm run doctor -- --deep`. `public` must be OK, `paypal.live` must show
   the webhook bound with all events (the boot registered or reused it), `ssh.servers` exact.
8. **Prove money flows**: one admin test-mode purchase (sandbox PayPal) from the shop page;
   its card must land in #Payment-Processor; revoke it. Watch for the next live renewal card.
9. **Ticket bot**: nothing to change if the domain and `SHOP_ADMIN_API_KEY` stayed the same.
   Run `/billing list` once; it must answer.
10. **Old copy**: leave it stopped for a week, then delete. Its packs stay in R2.

**Rollback**: switch the tunnel route back and start the old copy. Anything sold on the new
copy in between: pack it there and restore onto the old one with `--force`.

## 5. Lines in .env that change with the host

Everything else in `.env` is the same on any host. These are not:

| Variable | Why it changes |
|---|---|
| `GAME_SERVER_EU_HOST`, `GAME_SERVER_NA_HOST` | the game hosts' addresses |
| `GAME_SERVER_EU_PATHS`, `GAME_SERVER_NA_PATHS`, `GAME_SERVER_NA_DEV_PATH`, `GAME_SERVER_EU3_*` | Pterodactyl volume uuids are generated per panel; read them from the new panel |
| `GAME_SERVER_HOST_FINGERPRINTS` | the new hosts' SSH host keys (`ssh-keyscan -t ed25519 <host> \| ssh-keygen -lf -`) |
| `SSH_PRIVATE_KEY_B64` | keep the key, but its **public** half must be in `root`'s `authorized_keys` on the new EU host, and the EU host's own `/root/.ssh/id_ed25519.pub` must be in `root`'s `authorized_keys` on the new NA host. The doctor's `ssh.servers` proves both hops. |
| `PTERODACTYL_PANEL_URL`, `PTERODACTYL_CLIENT_API_KEY` | if the panel moved |
| `SMTP_HOST` and friends | if mail moved (section 6) |
| `BASE_URL` | only if the domain changes. Then PayPal registers a **second** webhook for the new URL on boot; delete the old one in the PayPal dashboard (Apps & Credentials → the app → Webhooks), and add the new callback in the Steam API key settings if the domain differs. |
| `DATA_DIR` | `/data` in Docker, unset in Pterodactyl |

Things that do **not** change: PayPal credentials, Steam key, Discord bot token and webhook
URL, `SESSION_SECRET` (changing it signs everyone out), `SHOP_ADMIN_API_KEY` (shared with the
ticket bot), `ADMIN_STEAM_IDS`, R2 credentials.

## 6. Billing email

The shop sends through whatever `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` /
`SMTP_PASS` say. Today that is mailcow on the EU box (`mail.reforgedz.net:587`).

- **If mailcow moves with everything else**: mailcow's own `helper-scripts/backup_and_restore.sh`
  carries mailboxes and config. DNS to move: `A mail`, `MX`, `SPF` (the TXT on the apex),
  `DKIM` (export the key from mailcow, or a new selector), `DMARC`, `autoconfig`/`autodiscover`.
  Set the **reverse DNS** of the new IP to `mail.reforgedz.net` at the new provider before the
  first send; a fresh IP with no PTR lands in spam. The shop then needs no change.
- **If mail is not ready on move day**: point the five `SMTP_*` variables at a transactional
  relay (any provider that gives SMTP credentials; add its SPF include and DKIM record to the
  zone) and the shop keeps sending receipts and billing notices. Inbound mail to
  `billing@` is unaffected by this setting. Switch back when mailcow is up.

The doctor's `smtp` line logs in to whatever is configured, so a wrong password or a host
that is not there yet shows up before the first customer notices.

## 7. Neighbours on the same box

One line each, so the move of the box is planned with them in view. None of these are part
of the shop pack.

| System | Where it lives | What has to travel |
|---|---|---|
| Ticket bot + transcripts | Pterodactyl `592fec9c`, repo `reinaeiry/Ticket-Bot` | its `.env`, `prisma/tixbot.db`, `web/transcripts.db`; `SHOP_BASE_URL` and `SHOP_ADMIN_API_KEY` stay |
| Admin page | Pterodactyl `75ed62bc`, repo `reinaeiry/reforgedz-admin-page` | its `.env` (never committed keys), `events.ndjson` replay data |
| Auth SSO | Pterodactyl `a9278721`, repo `reinaeiry/reforgedz-auth` | the Ed25519 keypair generated at deploy; every app trusts its public-key URL, so copy the keys or re-key every consumer |
| Warden ingest | Pterodactyl `5709ed12` | its `.env` and data dir |
| ipban controller + listener | systemd on the host | units, its SQLite, the `rzblock` nft table script; see `reforgedz-ipban/docs/` |
| mailcow | 28 containers, owns :80/:443 | section 6 |
| Pterodactyl panel + wings | `/var/www/pterodactyl`, MariaDB, wings config | panel DB and `.env`, node config, every volume under `/var/lib/pterodactyl/volumes/` |
| Cloudflare tunnels | `cloudflared-pt.service` (token in `/etc/cloudflared-pt/token`), `cloudflared.service` | tokens from Zero Trust; routes are in the dashboard, not on the box |
| Game servers | EU1 `f9606936`, EU2 `452e336d`, EU Dev `f37a9a71`; NA1 `e717265b`, NA2 `89988c5f`, NA Dev `0ad28a6d` | each volume's `config.json` and `profile/profile/.save`; the shop's `GAME_SERVER_*_PATHS` are re-read from the new uuids |

## 8. After the move

- The first nightly backup on the new host runs at 03:30 UTC; the morning after,
  `npm run doctor` shows `backup.local` and `backup.offsite` OK.
- The old host's packs and the last snapshots stay in R2. Delete nothing there for a month.
- Update memory and `Server-Ops/` with the new addresses and uuids.
