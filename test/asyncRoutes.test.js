// Tests for lib/async-routes.js (audit 2026-10-01): an async route that throws on a crafted request answers 500 JSON
// through the catch-all handler, instead of leaving the request without an answer. The app below uses the shop's own
// Express 4, query parser and JSON parser, so ?order[toString]=1 and {"productId":{"toString":1}} arrive the way they
// do in production, and its handlers have the shapes of the real ones in routes/shop.js. It is a small app rather than
// server.js, because loading routes/shop.js starts the timers that sync to the game servers.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { routeAsyncRejections } = require('../lib/async-routes');

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));

const db = new Database(':memory:');
db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT)');
db.prepare("INSERT INTO products (id, title) VALUES (1, 'Supporter')").run();

const app = express();
app.use(express.json());
const router = express.Router();
// paypal/return: parseInt on the query before anything else.
router.get('/api/shop/paypal/return', async (req, res) => {
  const orderId = parseInt(req.query.order, 10);
  res.json({ orderId });
});
// checkout: the product id goes straight to SQLite.
router.post('/api/shop/checkout', async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.body.productId);
  res.json({ product: product ? product.title : null });
});
// set-discord-id: the throw comes after an await.
router.post('/api/shop/set-discord-id', async (req, res) => {
  await Promise.resolve();
  res.json({ cleaned: String(req.body.discordId).trim() });
});
// A rejection after the answer was sent.
router.get('/late', async (req, res) => {
  res.json({ ok: true });
  await Promise.resolve();
  throw new Error('after the answer');
});
// A plain handler: Express 4 already catches its throw.
router.get('/sync', (req, res) => {
  res.json({ n: parseInt(req.query.n, 10) });
});
app.use(router);
// An async route on the app itself, not in a router.
app.get('/top', async (req, res) => {
  res.json({ n: parseInt(req.query.n, 10) });
});
const wrapped = routeAsyncRejections(app._router.stack);
// The same two handlers server.js ends with.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

let server;
let base;
const logged = [];
const realError = console.error;

test.before(async () => {
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  console.error = realError;
  server.closeAllConnections();
  server.close();
  db.close();
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : body,
    signal: AbortSignal.timeout(3000) // a hang shows up as a TimeoutError
  });
  return { status: res.status, json: await res.json() };
}

const FAILED = { error: 'Something went wrong. Please try again.' };

test('every async route handler is wrapped, plain ones are not, and a second pass wraps nothing', () => {
  assert.equal(wrapped, 5);
  assert.equal(routeAsyncRejections(app._router.stack), 0);
});

test('?order[toString]=1 on an async route answers 500 instead of hanging', async () => {
  assert.deepEqual(await call('GET', '/api/shop/paypal/return?order[toString]=1'), { status: 500, json: FAILED });
});

test('{"productId":{"toString":1}} bound by SQLite answers 500', async () => {
  assert.deepEqual(await call('POST', '/api/shop/checkout', '{"productId":{"toString":1}}'), { status: 500, json: FAILED });
});

test('a throw after an await answers 500', async () => {
  assert.deepEqual(await call('POST', '/api/shop/set-discord-id', '{"discordId":{"toString":1}}'), { status: 500, json: FAILED });
});

test('an async route on the app itself answers 500', async () => {
  assert.deepEqual(await call('GET', '/top?n[toString]=1'), { status: 500, json: FAILED });
});

test('a plain handler still answers 500 through Express itself', async () => {
  assert.deepEqual(await call('GET', '/sync?n[toString]=1'), { status: 500, json: FAILED });
});

test('normal input gets the same answers as before', async () => {
  assert.deepEqual(await call('GET', '/api/shop/paypal/return?order=42'), { status: 200, json: { orderId: 42 } });
  assert.deepEqual(await call('POST', '/api/shop/checkout', '{"productId":1}'), { status: 200, json: { product: 'Supporter' } });
  assert.deepEqual(await call('POST', '/api/shop/checkout', '{"productId":"1"}'), { status: 200, json: { product: 'Supporter' } });
  assert.deepEqual(await call('POST', '/api/shop/set-discord-id', '{"discordId":" 123 "}'), { status: 200, json: { cleaned: '123' } });
  assert.deepEqual(await call('GET', '/top?n=7'), { status: 200, json: { n: 7 } });
});

test('a rejection after the answer is logged, and the answer is intact', async () => {
  assert.deepEqual(await call('GET', '/late'), { status: 200, json: { ok: true } });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(logged.some((l) => l.includes('route failed after answering') && l.includes('after the answer')), logged.join('\n'));
});

test('no rejection went unhandled', async () => {
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rejections.length, 0, rejections.map(String).join('\n'));
});
