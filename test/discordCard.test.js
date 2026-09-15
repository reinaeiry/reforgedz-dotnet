// Tests for the staff card layout and poster (tools/lib/discordCard.js) and the
// shop's card builders (paymentCards.js). A fake fetch stands in for Discord:
// nothing is posted anywhere and no database is opened.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.PAYMENTS_ALERT_ROLE_ID;
delete process.env.BASE_URL;
delete process.env.DISCORD_WEBHOOK_URL;

const dc = require('../tools/lib/discordCard');
const cards = require('../paymentCards');

// Shaped like a real webhook URL; the token part must never reach a log.
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/TOKENabcDEF-secret_part';
const ROLE = '112233445566778899';
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const HEX32_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const UNTIL = 1800000000;

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const embedOf = (body) => body.embeds[0];

function reply(status, json, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => { if (json === undefined) throw new SyntaxError('Unexpected end of JSON input'); return json; }
  };
}

function fakeDiscord(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(url, init) : r;
  };
  return { calls, fetchImpl };
}

function logSink() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(' '));
  return { lines, logger: { error: push, warn: push, log: push } };
}

// Every piece of text a staff reader sees on a card.
function cardTexts(body) {
  const e = embedOf(body);
  return [e.title, e.description, e.footer && e.footer.text, body.content,
    ...(e.fields || []).flatMap(f => [f.name, f.value])].filter(s => s != null);
}

// ---- Realistic rows, carrying everything a card must NOT show -------------------

const STEAM_ROW = {
  id: 721, order_id: 721, steam_id: '76561198000000001', persona: 'TestPlayer', platform: 'steam',
  gamertag: null, bm_player_id: null, bi_uid: '41b8ec0d-f0bd-4c41-b2a9-8213ebe04aac', bi_uid_name: 'TestPlayer',
  payer_email: 'buyer.name+shop@example.com', product_title: 'Priority Queue', type: 'subscription',
  server_id: 'eu1', server_specific: 1, amount_cents: 1500, currency: 'usd', test_mode: 0,
  paypal_subscription_id: 'I-TEST0000CARD1', paypal_capture_id: '3C679366HH908993F', effective_until: UNTIL,
  discord_id: '123456789012345678', discord_role_id: '223456789012345678', status: 'completed'
};
const CONSOLE_ROW = {
  ...STEAM_ROW, id: 722, order_id: 722, steam_id: 'console:900001', persona: null, platform: 'xbox',
  gamertag: 'Grim Reaper 77', bm_player_id: '900001', bi_uid: '{9F86D081-884C-4D63-9B2F-0B822CD15D6C}',
  payer_email: 'someone@example.invalid', server_id: 'na2'
};
const WEB_ROW = {
  ...STEAM_ROW, id: 723, order_id: 723, steam_id: 'web:0123456789abcdef01234567', persona: 'Player', platform: 'web',
  bi_uid: null, payer_email: 'a@b.io', server_id: null, server_specific: 0, test_mode: 1, product_title: 'ReforgedZ Supporter',
  paypal_subscription_id: null, type: 'one_time'
};

// ---- buildCard ------------------------------------------------------------------

test('the title joins what, product and server label, skips missing parts, and marks sandbox orders', () => {
  const t = (spec) => embedOf(dc.buildCard({ kind: 'info', ...spec })).title;
  assert.equal(t({ what: 'Subscription renewed', product: 'Priority Queue', server: 'eu1' }), 'Subscription renewed · Priority Queue · EU1 (Chernarus)');
  assert.equal(t({ what: 'Subscription renewed', server: 'na2' }), 'Subscription renewed · NA2 (Faircroft)');
  assert.equal(t({ what: 'Shop health: all clear', product: '', server: null }), 'Shop health: all clear');
  assert.equal(t({ what: 'Moved', server: 'every server' }), 'Moved · every server');
  assert.equal(t({ what: 'Payment completed', product: 'Supporter', testMode: true }), '[TEST] Payment completed · Supporter');
  assert.equal(t({}), 'Shop event');
});

test('the title links to the order on the admin page, and the footer names it', () => {
  const e = embedOf(dc.buildCard({ kind: 'money_in', what: 'Renewed', orderId: 721, now: NOW }));
  assert.equal(e.url, 'https://reforgedz.net/admin/orders?q=%23721');
  assert.equal(e.footer.text, 'Order #721');
  assert.equal(e.timestamp, '2026-09-14T12:00:00.000Z');

  assert.equal(embedOf(dc.buildCard({ kind: 'info', orderId: 721, testMode: true })).footer.text, 'Order #721 · TEST');
  assert.equal(embedOf(dc.buildCard({ kind: 'info', orderId: '721', testMode: true, footerExtra: 'Revoke with refund cancels it' })).footer.text,
    'Order #721 · TEST · Revoke with refund cancels it');

  withEnv({ BASE_URL: 'https://staging.example.org/' }, () => {
    assert.equal(embedOf(dc.buildCard({ kind: 'info', orderId: 9 })).url, 'https://staging.example.org/admin/orders?q=%239');
  });

  for (const bad of [null, undefined, 'abc', -3, 0, 1.5, '12; DROP']) {
    const b = embedOf(dc.buildCard({ kind: 'info', what: 'x', orderId: bad }));
    assert.equal(b.url, undefined, `no link for ${bad}`);
    assert.equal(b.footer, undefined, `no footer for ${bad}`);
  }
  assert.equal(embedOf(dc.buildCard({ kind: 'info', footerExtra: 'npm run backup to retry' })).footer.text, 'npm run backup to retry');
  assert.equal(dc.adminOrderUrl(44), 'https://reforgedz.net/admin/orders?q=%2344');
});

test('colours follow the documented key, and ended and refunds are never red', () => {
  const expected = { money_in: 0x4ade80, info: 0x6b7280, attention: 0xf59e0b, action: 0xf87171, ended: 0x60a5fa, refund_out: 0xc084fc };
  assert.deepEqual([...dc.KINDS].sort(), Object.keys(expected).sort());
  for (const [kind, color] of Object.entries(expected)) {
    assert.equal(embedOf(dc.buildCard({ kind, what: 'x' })).color, color, kind);
  }
  assert.notEqual(dc.KIND_COLORS.ended, dc.KIND_COLORS.action);
  assert.notEqual(dc.KIND_COLORS.refund_out, dc.KIND_COLORS.action);
  assert.equal(new Set(Object.values(dc.KIND_COLORS)).size, 6, 'every kind has its own colour');
  assert.throws(() => dc.buildCard({ kind: 'red', what: 'x' }), TypeError);
  assert.throws(() => dc.buildCard({ what: 'x' }), TypeError);
});

test('only routine cards arrive silently', () => {
  const flags = (spec) => dc.buildCard({ what: 'x', ...spec }).flags;
  assert.equal(dc.SUPPRESS_NOTIFICATIONS, 4096);
  assert.equal(flags({ kind: 'money_in' }), 4096);
  assert.equal(flags({ kind: 'info' }), 4096);
  assert.equal(flags({ kind: 'ended' }), 4096);
  assert.equal(flags({ kind: 'refund_out', byStaff: true }), 4096);
  assert.equal(flags({ kind: 'refund_out' }), undefined, 'a refund staff did not make notifies');
  assert.equal(flags({ kind: 'attention' }), undefined);
  assert.equal(flags({ kind: 'action' }), undefined);
  assert.equal(flags({ kind: 'attention', testMode: true }), 4096, 'sandbox never notifies');
  assert.equal(flags({ kind: 'action', testMode: true }), 4096);
});

test('only action cards mention the alert role, and only when it is set', () => {
  withEnv({ PAYMENTS_ALERT_ROLE_ID: ROLE }, () => {
    const action = dc.buildCard({ kind: 'action', what: 'Payment reversed' });
    assert.equal(action.content, `<@&${ROLE}> Action needed`);
    assert.deepEqual(action.allowed_mentions, { roles: [ROLE] });
    for (const kind of ['money_in', 'info', 'attention', 'ended', 'refund_out']) {
      const b = dc.buildCard({ kind, what: 'x' });
      assert.equal(b.content, undefined, kind);
      assert.deepEqual(b.allowed_mentions, { parse: [] }, kind);
    }
    const sandbox = dc.buildCard({ kind: 'action', what: 'x', testMode: true });
    assert.equal(sandbox.content, undefined);
    assert.deepEqual(sandbox.allowed_mentions, { parse: [] });
  });
  withEnv({ PAYMENTS_ALERT_ROLE_ID: null }, () => {
    const b = dc.buildCard({ kind: 'action', what: 'x' });
    assert.equal(b.content, undefined);
    assert.deepEqual(b.allowed_mentions, { parse: [] });
  });
  for (const bad of ['', 'everyone', '@here', '<@&112233445566778899>', '12']) {
    withEnv({ PAYMENTS_ALERT_ROLE_ID: bad }, () => {
      const b = dc.buildCard({ kind: 'action', what: 'x' });
      assert.equal(b.content, undefined, `no mention for "${bad}"`);
      assert.deepEqual(b.allowed_mentions, { parse: [] });
    });
  }
});

test('every card carries allowed_mentions, so no text in it can ping anyone', () => {
  for (const role of [null, ROLE]) {
    withEnv({ PAYMENTS_ALERT_ROLE_ID: role }, () => {
      for (const kind of dc.KINDS) {
        for (const testMode of [false, true]) {
          for (const byStaff of [false, true]) {
            const b = dc.buildCard({ kind, testMode, byStaff, what: '@everyone', description: '<@&1> @here', fields: [{ name: 'Player', value: '@everyone' }] });
            assert.ok(b.allowed_mentions, `${kind} ${testMode} ${byStaff}`);
            if (!(role && kind === 'action' && !testMode)) assert.deepEqual(b.allowed_mentions, { parse: [] });
            else assert.deepEqual(b.allowed_mentions, { roles: [role] });
          }
        }
      }
    });
  }
});

test('money, dates and the standard fields use plain labels', () => {
  assert.equal(dc.money(1500), '$15.00');
  assert.equal(dc.money(1500, 'USD'), '$15.00');
  assert.equal(dc.money(1250, 'eur'), '12.50 EUR');
  assert.equal(dc.money(-1500), '-$15.00');
  assert.equal(dc.money(0), '$0.00');
  assert.equal(dc.money(null), null);
  assert.equal(dc.money('abc'), null);
  assert.equal(dc.discordDate(UNTIL), `<t:${UNTIL}:D>`);
  assert.equal(dc.discordDate(null), null);
  assert.equal(dc.discordDate(0), null);
  assert.equal(dc.shortId('41b8ec0d-f0bd-4c41-b2a9-8213ebe04aac'), '41b8ec0d...');
  assert.equal(dc.shortId(null), null);
  assert.equal(dc.serverLabel('eu2'), 'EU2 (Faircroft)');

  const e = embedOf(dc.buildCard({
    kind: 'money_in', what: 'Renewed', amountCents: 1500, accessUntil: UNTIL, nextCharge: UNTIL + 86400,
    fields: [{ name: 'Player', value: 'TestPlayer', inline: true }, { name: 'Empty', value: '' }, { name: '', value: 'dropped' }, null]
  }));
  assert.deepEqual(e.fields.map(f => f.name), ['Amount', 'Access until', 'Next charge', 'Player', 'Empty']);
  assert.equal(e.fields[0].value, '$15.00');
  assert.equal(e.fields[1].value, `<t:${UNTIL}:D>`);
  assert.equal(e.fields[2].value, `<t:${UNTIL + 86400}:D>`);
  assert.equal(e.fields[4].value, '-');
  assert.equal(e.fields[3].inline, true);
  assert.equal(e.fields[4].inline, false);
  assert.equal(embedOf(dc.buildCard({ kind: 'money_in', amountCents: 999, currency: 'EUR' })).fields[0].value, '9.99 EUR');
  assert.deepEqual(embedOf(dc.buildCard({ kind: 'info', amountCents: null })).fields, []);
});

test('text is cut to Discord limits', () => {
  const e = embedOf(dc.buildCard({
    kind: 'info', what: 'W'.repeat(400), description: 'D'.repeat(5000),
    fields: Array.from({ length: 30 }, (_, i) => ({ name: 'N'.repeat(300) + i, value: 'V'.repeat(2000) })),
    footerExtra: 'F'.repeat(3000)
  }));
  assert.ok(e.title.length <= 256);
  assert.ok(!e.description || e.description.length <= 4096);
  assert.ok(e.fields.length <= 25);
  for (const f of e.fields) { assert.ok(f.name.length <= 256); assert.ok(f.value.length <= 1024); }
  assert.ok(e.footer.text.length <= 2048);
  const total = e.title.length + (e.description || '').length + e.footer.text.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `total ${total}`);

  const small = embedOf(dc.buildCard({ kind: 'info', what: 'ok', description: 'short', fields: [{ name: 'a', value: 'b' }] }));
  assert.equal(small.description, 'short');
  assert.equal(small.fields.length, 1);
});

test('a card never shows an email address or a full in-game ID, even when handed one', () => {
  const e = embedOf(dc.buildCard({
    kind: 'attention', what: 'Mail buyer.name@example.com',
    description: 'IDs {41B8EC0D-F0BD-4C41-B2A9-8213EBE04AAC} and 41b8ec0df0bd4c41b2a98213ebe04aac, discord <@123456789012345678>',
    fields: [{ name: 'PayPal email', value: 'x.y@mail.example.co.uk' }, { name: 'Sale', value: '`1JU08902781691411`' }],
    footerExtra: 'guid 9f86d081-884c-4d63-9b2f-0b822cd15d6c'
  }));
  for (const s of [e.title, e.description, e.footer.text, ...e.fields.flatMap(f => [f.name, f.value])]) {
    assert.doesNotMatch(s, EMAIL_RE, s);
    assert.doesNotMatch(s, HEX32_RE, s);
  }
  assert.match(e.description, /41B8EC0D\.\.\./);
  assert.match(e.description, /<@123456789012345678>/, 'a Discord mention is not an address');
  assert.equal(e.fields[1].value, '`1JU08902781691411`', 'PayPal ids are left alone');
  assert.equal(dc.scrubText('plain text'), 'plain text');
});

test('no card built from realistic rows carries an email address or a full in-game ID', () => {
  const specs = [];
  for (const row of [STEAM_ROW, CONSOLE_ROW, WEB_ROW]) {
    for (const event of Object.keys(cards.ORDER_EVENTS)) {
      specs.push(cards.orderEventCard(event, row, { accessUntil: UNTIL, nextCharge: UNTIL, fields: [{ name: 'Cancelled via', value: 'Cancelled by customer' }] }));
    }
    specs.push(cards.unpaidEndedCard({ ctx: row, subscriptionId: 'I-TEST0000CARD1', cancel: { outcome: 'cancelled' }, failedCount: 2, outstandingCents: 3000, currency: 'USD', accessUntil: UNTIL, source: 'webhook' }));
    specs.push(cards.unpaidEndedCard({ ctx: row, cancel: { outcome: 'failed', status: 422 }, failedCount: 1, source: 'reconcile' }));
    specs.push(cards.refusedPaymentCard({ ctx: row, subscriptionId: 'I-TEST0000CARD1', saleId: '1JU08902781691411', amountCents: 1500, currency: 'USD', reason: 'no_slot', serverId: 'eu1', slot: { limit: 24, used: 24, reserved: 0 }, refund: { outcome: 'refunded', refundId: '5RF00000000000000', refundStatus: 'COMPLETED' }, cancel: { outcome: 'cancelled' } }));
    specs.push(cards.refusedPaymentCard({ ctx: row, saleId: '1JU08902781691411', amountCents: 1500, reason: 'ended_unpaid', refund: { outcome: 'failed', status: 422 }, cancel: { outcome: 'already_ended' } }));
    specs.push(cards.refusedPaymentCard({ ctx: row, saleId: '1JU08902781691411', amountCents: 1500, reason: 'revoked', refund: { outcome: 'refunded' }, cancel: { outcome: 'failed', status: 400 } }));
    specs.push(cards.refusedActivationCard({ order: row, serverId: 'eu1', slot: { limit: 24, used: 24, reserved: 1 }, cancel: { outcome: 'cancelled' } }));
    specs.push(cards.customFlagCard({ orderId: row.id, order: { ...row, product_title: 'Custom Flag' }, customFields: { playerName: 'TestPlayer', inGameName: 'Nat', guid: 'A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D', discordId: '123456789012345678' }, imageName: '1757000000000-abcdef012345.png' }));
    specs.push(cards.staffQueueMoveCard({ order: row, from: 'eu2', to: 'eu1', orderIds: [700, row.id], reason: 'Player asked in a ticket' }));
    specs.push(cards.adminCeilingCard({ serverId: row.server_id || 'eu1', planned: 51, ceiling: 50, current: 50, shopOwned: 36, others: 15 }));
    specs.push(cards.revokedRenewalCard({ subId: 'I-TEST0000CARD1', saleId: '1JU08902781691411', orders: [{ id: 1, status: 'refunded', steam_id: row.steam_id, test_mode: 0 }], amountCents: 1500, currency: 'USD', context: row }));
    specs.push(cards.revokedRenewalCard({ subId: 'I-TEST0000CARD1', saleId: '1JU08902781691411', orders: [], amountCents: null }));
    specs.push(cards.renewalAfterRefundCard({ subId: 'I-TEST0000CARD1', saleId: '1JU08902781691411', refundedOrderId: 700, newOrderId: 721, original: row, amountCents: 1500 }));
    specs.push(cards.duplicateSubscriptionCard(row, { ...row, id: 590, paypal_subscription_id: 'I-OTHER1234567' }));
  }
  assert.ok(specs.length > 40);
  for (const spec of specs) {
    const body = dc.buildCard(spec);
    for (const s of cardTexts(body)) {
      assert.doesNotMatch(s, EMAIL_RE, `${embedOf(body).title}: ${s}`);
      assert.doesNotMatch(s, HEX32_RE, `${embedOf(body).title}: ${s}`);
    }
    assert.doesNotMatch(JSON.stringify(spec), /@example\.com|@outlook|a@b\.io/, 'builders never read payer_email');
  }
});

test('order cards name the player, account, in-game ID and status in plain words', () => {
  const spec = cards.orderEventCard('subscription_renewed', STEAM_ROW, { nextCharge: UNTIL });
  assert.equal(spec.kind, 'money_in');
  const body = dc.buildCard(spec);
  const e = embedOf(body);
  assert.equal(e.title, 'Subscription renewed · Priority Queue · EU1 (Chernarus)');
  assert.equal(e.footer.text, 'Order #721');
  const f = Object.fromEntries(e.fields.map(x => [x.name, x.value]));
  assert.equal(f.Amount, '$15.00');
  assert.equal(f['Next charge'], `<t:${UNTIL}:D>`);
  assert.equal(f.Player, 'TestPlayer');
  assert.equal(f.Account, '76561198000000001');
  assert.equal(f.Platform, 'Steam');
  assert.equal(f['In-game ID'], '41b8ec0d...');
  assert.equal(f.Status, 'Completed');
  assert.equal(f.Subscription, '`I-TEST0000CARD1`');
  assert.equal(body.flags, 4096);

  const kinds = Object.fromEntries(Object.entries(cards.ORDER_EVENTS).map(([k, v]) => [k, v.kind]));
  assert.equal(kinds.subscription_cancelled, 'ended');
  assert.equal(kinds.order_refunded, 'refund_out');
  assert.equal(kinds.order_revoked, 'info');
  assert.equal(kinds.payment_reversed, 'action');
  assert.equal(kinds.payment_declined, 'attention');

  const staffRefund = dc.buildCard(cards.orderEventCard('order_refunded', STEAM_ROW, { amountCents: 1500, byStaff: true }));
  assert.equal(staffRefund.flags, 4096);
  assert.equal(dc.buildCard(cards.orderEventCard('order_refunded', STEAM_ROW)).flags, undefined);

  const noAmount = embedOf(dc.buildCard(cards.orderEventCard('order_revoked', STEAM_ROW, { amountCents: null, fields: [{ name: 'Refund', value: 'None' }] })));
  assert.ok(!noAmount.fields.some(x => x.name === 'Amount'));
  assert.equal(noAmount.title, 'Order revoked, no refund · Priority Queue · EU1 (Chernarus)');

  const consoleFields = Object.fromEntries(embedOf(dc.buildCard(cards.orderEventCard('payment_completed', CONSOLE_ROW))).fields.map(x => [x.name, x.value]));
  assert.equal(consoleFields.Player, 'Grim Reaper 77');
  assert.equal(consoleFields.Account, 'console:900001');
  assert.equal(consoleFields.Platform, 'Xbox');
  assert.equal(consoleFields['In-game ID'], '9F86D081...');

  const web = embedOf(dc.buildCard(cards.orderEventCard('payment_completed', WEB_ROW)));
  const webFields = Object.fromEntries(web.fields.map(x => [x.name, x.value]));
  assert.equal(web.title, '[TEST] Payment completed · ReforgedZ Supporter');
  assert.equal(webFields.Player, 'In-game name not known yet');
  assert.equal(webFields['In-game ID'], 'Not set yet');
  assert.equal(webFields.Subscription, undefined);

  const billing = embedOf(dc.buildCard(cards.unpaidEndedCard({ ctx: { ...STEAM_ROW, id: undefined }, cancel: { outcome: 'cancelled' }, failedCount: 1, outstandingCents: 1500, accessUntil: UNTIL, now: UNTIL - 86400 })));
  const bf = Object.fromEntries(billing.fields.map(x => [x.name, x.value]));
  assert.equal(billing.footer.text, 'Order #721', 'subscriptionContext rows carry order_id');
  assert.equal(billing.title, 'Subscription ended, payment not received · Priority Queue · EU1 (Chernarus)');
  assert.equal(bf.Outstanding, '$15.00');
  assert.equal(bf['PayPal subscription'], 'Cancelled at PayPal');
  assert.ok(!Object.keys(bf).some(k => /email/i.test(k)));

  assert.throws(() => cards.orderEventCard('order_teleported', STEAM_ROW), TypeError);
});

// ---- postCard -------------------------------------------------------------------

test('?wait=true is added to the webhook URL, keeping any query it already has', async () => {
  const card = dc.buildCard({ kind: 'info', what: 'x', orderId: 5 });
  for (const [url, want] of [
    [HOOK, `${HOOK}?wait=true`],
    [`${HOOK}?thread_id=42`, `${HOOK}?thread_id=42&wait=true`],
    [`${HOOK}?wait=false`, `${HOOK}?wait=true`]
  ]) {
    const d = fakeDiscord(reply(200, { id: '999' }));
    const r = await dc.postCard(card, { url, fetchImpl: d.fetchImpl });
    assert.deepEqual(r, { ok: true, status: 200, messageId: '999' });
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0].url, want);
    assert.equal(d.calls[0].init.method, 'POST');
    assert.equal(d.calls[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(d.calls[0].init.body), card);
  }

  const d = fakeDiscord(reply(200, { id: '1' }));
  await withEnv({ DISCORD_WEBHOOK_URL: HOOK }, () => dc.postCard(card, { fetchImpl: d.fetchImpl }));
  assert.equal(d.calls[0].url, `${HOOK}?wait=true`, 'defaults to DISCORD_WEBHOOK_URL');
});

test('a 429 waits for retry_after and tries again, at most twice', async () => {
  const card = dc.buildCard({ kind: 'info', what: 'x' });

  let waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let d = fakeDiscord(reply(429, { message: 'You are being rate limited.', retry_after: 0.25, global: false }), reply(200, { id: '5' }));
  let r = await dc.postCard(card, { url: HOOK, fetchImpl: d.fetchImpl, sleep });
  assert.deepEqual(r, { ok: true, status: 200, messageId: '5' });
  assert.equal(d.calls.length, 2);
  assert.deepEqual(waits, [250]);

  waits = [];
  d = fakeDiscord(reply(429, undefined, { 'Retry-After': '2' }), reply(204, undefined));
  r = await dc.postCard(card, { url: HOOK, fetchImpl: d.fetchImpl, sleep });
  assert.deepEqual(r, { ok: true, status: 204, messageId: null });
  assert.deepEqual(waits, [2000]);

  waits = [];
  d = fakeDiscord(reply(429, { retry_after: 120 }), reply(200, { id: '6' }));
  await dc.postCard(card, { url: HOOK, fetchImpl: d.fetchImpl, sleep });
  assert.deepEqual(waits, [dc.MAX_RETRY_WAIT_MS], 'a long wait is capped');

  waits = [];
  const log = logSink();
  d = fakeDiscord(reply(429, { retry_after: 0.01 }));
  r = await dc.postCard(card, { url: HOOK, fetchImpl: d.fetchImpl, sleep, logger: log.logger });
  assert.deepEqual(r, { ok: false, status: 429, messageId: null });
  assert.equal(d.calls.length, 1 + dc.MAX_RETRIES);
  assert.equal(waits.length, dc.MAX_RETRIES);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /HTTP 429/);
});

test('a timeout, a network error or a refusal returns ok:false without throwing, and the log never has the URL', async () => {
  const card = dc.buildCard({ kind: 'action', what: 'x' });
  const clean = (lines) => {
    for (const l of lines) {
      assert.ok(!l.includes('discord.com'), l);
      assert.ok(!l.includes('TOKENabcDEF'), l);
      assert.ok(!l.includes('123456789012345678'), l);
    }
  };

  let log = logSink();
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException(`The operation was aborted: ${url}`, 'AbortError')));
  });
  let r = await dc.postCard(card, { url: HOOK, fetchImpl: hang, timeoutMs: 20, logger: log.logger });
  assert.deepEqual(r, { ok: false, status: 0, messageId: null });
  assert.match(log.lines.join('\n'), /timed out/);
  clean(log.lines);

  log = logSink();
  let d = fakeDiscord(new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${HOOK}`));
  r = await dc.postCard(card, { url: HOOK, fetchImpl: d.fetchImpl, logger: log.logger });
  assert.deepEqual(r, { ok: false, status: 0, messageId: null });
  assert.match(log.lines.join('\n'), /network error/);
  clean(log.lines);

  for (const status of [400, 401, 404, 500]) {
    log = logSink();
    d = fakeDiscord(reply(status, { message: `Invalid Webhook Token for ${HOOK}`, code: 50027 }));
    r = await dc.postCard(card, { url: HOOK, fetchImpl: d.fetchImpl, logger: log.logger });
    assert.deepEqual(r, { ok: false, status, messageId: null });
    assert.equal(d.calls.length, 1, 'only a 429 is retried');
    assert.deepEqual(log.lines, [`[discord-card] card not posted: HTTP ${status}`]);
  }

  log = logSink();
  d = fakeDiscord(reply(200, { id: '1' }));
  r = await dc.postCard(card, { url: 'not a url', fetchImpl: d.fetchImpl, logger: log.logger });
  assert.equal(r.ok, false);
  assert.equal(d.calls.length, 0);
  assert.ok(!log.lines.join('\n').includes('not a url'));

  log = logSink();
  for (const url of ['', null, undefined]) {
    r = await dc.postCard(card, { url, fetchImpl: d.fetchImpl, logger: log.logger });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'no webhook');
  }
  assert.equal(d.calls.length, 0);
  assert.deepEqual(log.lines, [], 'no webhook configured is not an error');
});

test('an attachment goes as multipart, with the card in payload_json', async () => {
  const card = dc.buildCard(cards.customFlagCard({ orderId: 12, order: STEAM_ROW, customFields: {}, imageName: 'flag.png' }));
  assert.equal(embedOf(card).image.url, 'attachment://flag.png');
  const d = fakeDiscord(reply(200, { id: '7' }));
  const r = await dc.postCard(card, { url: HOOK, fetchImpl: d.fetchImpl, files: [{ name: 'flag.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }] });
  assert.equal(r.ok, true);
  const body = d.calls[0].init.body;
  assert.ok(body instanceof FormData);
  assert.equal(d.calls[0].init.headers, undefined, 'fetch sets the multipart boundary itself');
  assert.deepEqual(JSON.parse(body.get('payload_json')), card);
  assert.equal(body.get('files[0]').name, 'flag.png');
  assert.equal(body.get('files[0]').size, 4);
});

test('sendCard builds and posts, and a card it cannot build is logged, never thrown', async () => {
  const d = fakeDiscord(reply(200, { id: '8' }));
  const r = await dc.sendCard(() => cards.orderEventCard('subscription_cancelled', STEAM_ROW, { accessUntil: UNTIL }), { url: HOOK, fetchImpl: d.fetchImpl });
  assert.deepEqual(r, { ok: true, status: 200, messageId: '8' });
  const posted = JSON.parse(d.calls[0].init.body);
  assert.equal(posted.embeds[0].title, 'Subscription cancelled · Priority Queue · EU1 (Chernarus)');
  assert.equal(posted.embeds[0].color, dc.KIND_COLORS.ended);
  assert.equal(posted.flags, 4096);

  const log = logSink();
  const d2 = fakeDiscord(reply(200, { id: '9' }));
  for (const bad of [() => { throw new Error('ctx missing'); }, { kind: 'nope' }, null]) {
    const out = await dc.sendCard(bad, { url: HOOK, fetchImpl: d2.fetchImpl, logger: log.logger });
    assert.deepEqual(out, { ok: false, status: 0, messageId: null });
  }
  assert.equal(d2.calls.length, 0);
  assert.equal(log.lines.length, 3);
  assert.match(log.lines[0], /card not built: ctx missing/);
});
