// The one list of every environment variable the shop reads. The doctor checks
// a deployment against it, the pack records it, .env.example is written from it
// (npm run env:example), and a variable that is not here is a bug in this file.
//
// required: the shop cannot do its job without it.
// secret:   never printed, encrypted in packs, blanked in a rehearsal.
// outbound: talks to the outside world; a rehearsal blanks these so a restored
//           copy can never charge, email, message or write to a game server.

const VARS = [
  // ---- Core -----------------------------------------------------------------
  { name: 'BASE_URL', group: 'Core', required: true, doc: 'Public origin, no trailing slash. Steam sign-in, PayPal return URLs and the PayPal webhook are all registered against it.', example: 'https://reforgedz.net' },
  { name: 'PORT', group: 'Core', doc: 'Listen port. Default 3000.', example: '3000' },
  { name: 'DATA_DIR', group: 'Core', doc: 'Where the database, sessions, uploads and backups live. Default: the app directory (the Pterodactyl layout). Docker sets it to the mounted volume.', example: '' },
  { name: 'SESSION_SECRET', group: 'Core', required: true, secret: true, doc: 'Signs login sessions and the console lock cookie. Losing it signs everyone out; a weak or default one makes console accounts forgeable.', example: '' },
  { name: 'ADMIN_STEAM_IDS', group: 'Core', required: true, doc: 'Comma-separated Steam64 ids that get the admin role, decided on every request.', example: '' },
  { name: 'STEAM_API_KEY', group: 'Core', required: true, secret: true, doc: 'Steam Web API key for OpenID sign-in (steamcommunity.com/dev/apikey).', example: '' },
  { name: 'NODE_ENV', group: 'Core', doc: 'Leave unset. Its only remaining effect is the origin HSTS header, which Cloudflare handles.', example: '' },

  // ---- PayPal ---------------------------------------------------------------
  { name: 'PAYPAL_CLIENT_ID', group: 'PayPal', required: true, secret: true, outbound: true, doc: 'Live app credentials (developer.paypal.com, My Apps & Credentials, Live).', example: '' },
  { name: 'PAYPAL_SECRET', group: 'PayPal', required: true, secret: true, outbound: true, doc: '', example: '' },
  { name: 'PAYPAL_TEST_CLIENT_ID', group: 'PayPal', secret: true, outbound: true, doc: 'Sandbox app credentials, used for admin test-mode purchases only.', example: '' },
  { name: 'PAYPAL_TEST_SECRET', group: 'PayPal', secret: true, outbound: true, doc: '', example: '' },
  { name: 'PAYPAL_WEBHOOK_ID', group: 'PayPal', doc: 'Normally left blank: the webhook is found by URL and registered on boot. Set only to pin one managed in the dashboard.', example: '' },
  { name: 'PAYPAL_TEST_WEBHOOK_ID', group: 'PayPal', doc: '', example: '' },

  // ---- Billing email --------------------------------------------------------
  { name: 'SMTP_HOST', group: 'Email', required: true, outbound: true, doc: 'SMTP server for receipts and billing notices. mailcow today; any relay works with the same five variables.', example: 'mail.reforgedz.net' },
  { name: 'SMTP_PORT', group: 'Email', doc: 'Default 587.', example: '587' },
  { name: 'SMTP_SECURE', group: 'Email', doc: 'true for implicit TLS on 465, false for STARTTLS on 587.', example: 'false' },
  { name: 'SMTP_USER', group: 'Email', required: true, doc: '', example: 'billing@reforgedz.net' },
  { name: 'SMTP_PASS', group: 'Email', required: true, secret: true, doc: '', example: '' },
  { name: 'INVOICE_FROM', group: 'Email', doc: 'From header on every email.', example: 'ReforgedZ Billing <billing@reforgedz.net>' },

  // ---- Discord --------------------------------------------------------------
  { name: 'DISCORD_BOT_TOKEN', group: 'Discord', required: true, secret: true, outbound: true, doc: 'Bot token (shared with the ticket bot application) used to grant and remove entitlement roles.', example: '' },
  { name: 'DISCORD_GUILD_ID', group: 'Discord', doc: 'The ReforgedZ guild. Defaults to the live guild in code.', example: '1352364195211120660' },
  { name: 'DISCORD_WEBHOOK_URL', group: 'Discord', required: true, secret: true, outbound: true, doc: 'The "ReforgedZ Payments" webhook into #Payment-Processor. Purchase, refund and subscription cards go through it.', example: '' },
  { name: 'DISCORD_PAYMENT_CHANNEL_ID', group: 'Discord', doc: 'Channel for billing alerts posted as the bot. Defaults to #Payment-Processor in code; point it at a test channel on a non-production copy.', example: '' },
  { name: 'DISCORD_CLIENT_ID', group: 'Discord', doc: 'Application id of the bot application (Discord developer portal, OAuth2). With the secret below, players link Discord with a Connect button instead of pasting a user id. Add BASE_URL/auth/discord/callback to the application\'s OAuth2 redirects.', example: '' },
  { name: 'DISCORD_CLIENT_SECRET', group: 'Discord', secret: true, doc: 'OAuth2 client secret of the same application. Unset = the Connect Discord button is hidden and the paste box remains.', example: '' },
  { name: 'STAFF_DISCORD_ROLE_IDS', group: 'Discord', doc: 'Comma-separated role ids of staff (Founder, admins, Gamemasters). A player holding one is never removed from a server\'s game.admins by the shop, even after their priority queue lapses. Defaults to the ticket bot\'s staff roles in code.', example: '' },

  // ---- Game servers ---------------------------------------------------------
  { name: 'SSH_PRIVATE_KEY_B64', group: 'Game servers', required: true, secret: true, outbound: true, doc: 'base64 of the private key that logs in as GAME_SERVER_EU_USER on GAME_SERVER_EU_HOST. Its public half must be in that user\'s authorized_keys. NA is reached from the EU host with the EU host\'s own key.', example: '' },
  { name: 'GAME_SERVER_EU_HOST', group: 'Game servers', required: true, doc: 'SSH entry host. Every server write starts here.', example: '162.19.127.130' },
  { name: 'GAME_SERVER_EU_PORT', group: 'Game servers', doc: 'Default 22.', example: '22' },
  { name: 'GAME_SERVER_EU_USER', group: 'Game servers', doc: 'Default root. Must be able to write the Pterodactyl volumes.', example: 'root' },
  { name: 'GAME_SERVER_EU_PATHS', group: 'Game servers', required: true, doc: 'Comma-separated shop paths for EU1,EU2: <volume>/profile/profile/eiry/reforgedz-dotnet-shop. The volume uuids change on a new panel.', example: '' },
  { name: 'GAME_SERVER_NA_HOST', group: 'Game servers', required: true, doc: 'Reached by a nested ssh from the EU host as GAME_SERVER_NA_USER.', example: '51.222.254.40' },
  { name: 'GAME_SERVER_NA_PORT', group: 'Game servers', doc: '', example: '22' },
  { name: 'GAME_SERVER_NA_USER', group: 'Game servers', doc: '', example: 'root' },
  { name: 'GAME_SERVER_NA_PATHS', group: 'Game servers', required: true, doc: 'Comma-separated shop paths for NA1,NA2.', example: '' },
  { name: 'GAME_SERVER_NA_DEV_PATH', group: 'Game servers', doc: 'Shop path of the NA Dev server (dev1). Optional.', example: '' },
  { name: 'GAME_SERVER_EU3_HOST', group: 'Game servers', doc: 'EU Dev (eu3): reachable for the save inspector, never sold or synced. All four optional.', example: '' },
  { name: 'GAME_SERVER_EU3_PORT', group: 'Game servers', doc: '', example: '' },
  { name: 'GAME_SERVER_EU3_USER', group: 'Game servers', doc: '', example: '' },
  { name: 'GAME_SERVER_EU3_PATHS', group: 'Game servers', doc: '', example: '' },
  { name: 'GAME_SERVER_HOST_FINGERPRINTS', group: 'Game servers', recommended: true, doc: 'Comma-separated SHA256 host-key fingerprints (without the SHA256: prefix) the entry host must present. Unset = accept and log (the doctor warns).', example: '' },
  { name: 'GAME_SERVER_STRICT_HOSTKEYS', group: 'Game servers', doc: '1 to make the nested NA hop refuse unknown host keys instead of recording them on first use.', example: '' },
  { name: 'ADMIN_CEILING', group: 'Game servers', doc: 'Maximum size of game.admins per server. Priority queue stock is ceiling minus the GMs already listed. Default 50.', example: '' },

  // ---- Panel and BattleMetrics ---------------------------------------------
  { name: 'PTERODACTYL_PANEL_URL', group: 'Panel', required: true, doc: 'Panel origin for the homepage status tiles and the restart helper.', example: 'https://panel.reforgedz.net' },
  { name: 'PTERODACTYL_CLIENT_API_KEY', group: 'Panel', required: true, secret: true, doc: 'A client API key (Account, API Credentials) that can see the game servers.', example: '' },
  { name: 'BATTLEMETRICS_TOKEN', group: 'Panel', required: true, secret: true, doc: 'BattleMetrics API token: player counts and the console gamertag lookup.', example: '' },
  { name: 'REFORGEDZ_BM_SERVER_IDS', group: 'Panel', doc: 'Comma-separated BattleMetrics server ids, numbers only, searched FIRST for a console gamertag until the panel has verified its own records (for example while the panel is unreachable). Trusted as given; records the panel discovers are checked against the organisation instead.', example: '' },
  { name: 'REFORGEDZ_BM_ORG_ID', group: 'Panel', doc: 'BattleMetrics organisation searched when today\'s servers find nobody, so players whose history sits on an older server record can still sign in. A number; anything else is ignored and the default 112993 (ReforgedZ) is used. Lookups are never unscoped.', example: '' },

  // ---- Staff integrations ---------------------------------------------------
  { name: 'SHOP_ADMIN_API_KEY', group: 'Staff', required: true, secret: true, doc: 'Shared bearer for /api/shop/admin/* from the admin page and the ticket bot. Must match SHOP_ADMIN_API_KEY in the ticket bot\'s .env.', example: '' },
  { name: 'PUBLIC_BASE_URL', group: 'Staff', doc: 'Origin used in console re-link links. Defaults to https://reforgedz.net; set it if BASE_URL differs from what players type.', example: '' },
  { name: 'CUSTOM_FLAG_TUTORIAL_URL', group: 'Staff', doc: 'Tutorial link shown after a Custom Flag purchase. Blank shows a placeholder.', example: '' },

  // ---- Backups --------------------------------------------------------------
  { name: 'BACKUP_OFFSITE', group: 'Backups', doc: 'Where the nightly snapshot is copied, comma-separated: na (the NA box over the existing SSH hop), r2 (Cloudflare R2). Blank keeps backups on this box only, which the doctor flags.', example: 'na,r2' },
  { name: 'BACKUP_NA_DIR', group: 'Backups', doc: 'Directory on the NA box for copies. Default /root/reforgedz-shop-backups.', example: '' },
  { name: 'R2_ACCOUNT_ID', group: 'Backups', doc: 'Cloudflare account id (R2 overview page).', example: '' },
  { name: 'R2_BUCKET', group: 'Backups', doc: 'Bucket name, e.g. reforgedz-shop-backups.', example: '' },
  { name: 'R2_ACCESS_KEY_ID', group: 'Backups', secret: true, doc: 'From R2, Manage R2 API Tokens: a token with Object Read & Write on that bucket only.', example: '' },
  { name: 'R2_SECRET_ACCESS_KEY', group: 'Backups', secret: true, doc: '', example: '' },
  { name: 'R2_PREFIX', group: 'Backups', doc: 'Key prefix inside the bucket. Default shop/.', example: '' },

  // ---- Rehearsal ------------------------------------------------------------
  { name: 'SHOP_REHEARSAL', group: 'Rehearsal', doc: 'Set to 1 on a restored copy. The doctor then treats blanked outbound credentials as intended rather than missing. Never set on production.', example: '' }
];

// Variables that used to exist and are read by nothing. Present = stale .env.
const DEAD = [
  'STRIPE_PUBLISHABLE_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_TEST_PUBLISHABLE_KEY',
  'STRIPE_TEST_SECRET_KEY', 'STRIPE_TEST_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET',
  'GAME_SERVER_NA_KEY_PATH'
];

// Blanked on a rehearsal copy: everything outbound, plus the read-only
// integrations that would still reach third parties or the real staff channel.
// restore.js writes the copy's .env from this; the doctor judges it by it.
const REHEARSAL_BLANK = [
  ...VARS.filter(v => v.outbound).map(v => v.name),
  'PTERODACTYL_CLIENT_API_KEY', 'PTERODACTYL_PANEL_URL', 'BATTLEMETRICS_TOKEN',
  'DISCORD_PAYMENT_CHANNEL_ID', 'BACKUP_OFFSITE', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'
];

const byName = new Map(VARS.map(v => [v.name, v]));

function isSecret(name) { const v = byName.get(name); return !!(v && v.secret); }
function isOutbound(name) { const v = byName.get(name); return !!(v && v.outbound); }

// Parse a .env file the way dotenv does for the simple cases we write: KEY=value,
// optional double quotes, # comments. Returns an ordered array of [key, value].
function parseEnvFile(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out.push([key, val]);
  }
  return out;
}

// Render an .env.example: every variable, grouped, documented, no values.
function renderExample() {
  const lines = [
    '# ReforgedZ shop, environment template. Copy to .env and fill in.',
    '# .env is gitignored and never committed. This file is generated from',
    '# tools/lib/envManifest.js (npm run env:example); edit the manifest, not this.',
    '#',
    '# The doctor (npm run doctor) checks a deployment against the same list.',
    ''
  ];
  let group = null;
  for (const v of VARS) {
    if (v.group !== group) {
      group = v.group;
      lines.push(`# ---- ${group} ${'-'.repeat(Math.max(0, 70 - group.length))}`);
    }
    const flags = [v.required ? 'required' : null, v.secret ? 'secret' : null, v.recommended ? 'recommended' : null].filter(Boolean);
    if (v.doc) lines.push(`# ${v.doc}`);
    if (flags.length) lines.push(`# (${flags.join(', ')})`);
    lines.push(`${v.name}=${v.example || ''}`);
    lines.push('');
  }
  lines.push('# ---- Retired (delete these from an old .env) ---------------------------------');
  lines.push(`# ${DEAD.join(', ')}`);
  return lines.join('\n') + '\n';
}

module.exports = { VARS, DEAD, REHEARSAL_BLANK, byName, isSecret, isOutbound, parseEnvFile, renderExample };
