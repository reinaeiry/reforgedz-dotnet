// Tests for the PayPal webhook event list and the decision that brings an
// existing webhook up to it (paypal.js). Pure: fetch is replaced before paypal.js
// loads, and the test fails if anything tries to reach PayPal.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { requests++; throw new Error('no network in tests'); };
const paypal = require('../paypal');

test.after(() => {
  globalThis.fetch = realFetch;
  assert.equal(requests, 0, 'nothing may call PayPal');
});

// The list a webhook registered before this release carries.
const BEFORE = [
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED',
  'CHECKOUT.ORDER.APPROVED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED', 'PAYMENT.SALE.COMPLETED'
];
const ADDED = ['PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED', 'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED', 'PAYMENT.REFUND.FAILED'];
const named = (list) => list.map(name => ({ name, description: `${name} happened` }));

test('the shop subscribes to refunds, reversals and disputes as well as everything it had', () => {
  for (const e of [...BEFORE, ...ADDED]) assert.ok(paypal.WEBHOOK_EVENTS.includes(e), e);
  assert.equal(paypal.WEBHOOK_EVENTS.length, BEFORE.length + ADDED.length);
  assert.equal(new Set(paypal.WEBHOOK_EVENTS).size, paypal.WEBHOOK_EVENTS.length, 'no event listed twice');
});

test('an existing webhook from before this release is missing exactly the new events, in list order', () => {
  assert.deepEqual(paypal.missingWebhookEvents(named(BEFORE)), ADDED);
});

test('nothing is missing when the webhook has every event, or subscribes to everything with *', () => {
  assert.deepEqual(paypal.missingWebhookEvents(named(paypal.WEBHOOK_EVENTS)), []);
  assert.deepEqual(paypal.missingWebhookEvents(named(['*'])), []);
  assert.equal(paypal.webhookEventsPatch(named(paypal.WEBHOOK_EVENTS)), null);
  assert.equal(paypal.webhookEventsPatch(named(['*'])), null);
});

test('an empty or unreadable event list is missing everything', () => {
  assert.deepEqual(paypal.missingWebhookEvents(undefined), paypal.WEBHOOK_EVENTS);
  assert.deepEqual(paypal.missingWebhookEvents(null), paypal.WEBHOOK_EVENTS);
  assert.deepEqual(paypal.missingWebhookEvents([{}, { name: '' }, 42]), paypal.WEBHOOK_EVENTS);
});

test('plain event names and a custom desired list work too', () => {
  assert.deepEqual(paypal.missingWebhookEvents(['A', 'C'], ['A', 'B', 'C', 'D']), ['B', 'D']);
});

test('the patch keeps the events already on the webhook and adds the missing ones after them', () => {
  const patch = paypal.webhookEventsPatch(
    [{ name: 'PAYMENT.CAPTURE.COMPLETED' }, { name: 'SOMETHING.ADDED.IN.THE.DASHBOARD' }, { name: 'PAYMENT.CAPTURE.COMPLETED' }],
    ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.SALE.REFUNDED']
  );
  assert.deepEqual(patch, [{
    op: 'replace',
    path: '/event_types',
    value: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }, { name: 'SOMETHING.ADDED.IN.THE.DASHBOARD' }, { name: 'PAYMENT.SALE.REFUNDED' }]
  }]);
});

test('patching an old webhook ends with every event the shop needs', () => {
  const patch = paypal.webhookEventsPatch(named(BEFORE));
  const names = patch[0].value.map(v => v.name);
  assert.deepEqual(paypal.missingWebhookEvents(names), []);
  assert.deepEqual(names, [...BEFORE, ...ADDED]);
});
