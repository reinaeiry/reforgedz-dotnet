// The request bodies the shop sends PayPal (paypal.js orderRequest and
// subscriptionRequest), read without any call being made. Decision A1 (2026-10-20):
// a one-time order asks for the card form first; subscriptions are unchanged.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const paypal = require('../paypal');

test('a one-time order asks PayPal for the guest card form first, no shipping, pay now, and never the deprecated application_context', () => {
  const body = paypal.orderRequest({
    amountCents: 500, currency: 'usd', description: 'Winter Armband', customId: 42,
    returnUrl: 'https://shop.example.test/api/shop/paypal/return?order=42', cancelUrl: 'https://shop.example.test/shop?cancelled=1'
  });
  assert.equal(body.intent, 'CAPTURE');
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'USD', value: '5.00' });
  assert.equal(body.purchase_units[0].custom_id, '42');
  assert.equal(body.purchase_units[0].description, 'Winter Armband');
  const ctx = body.payment_source.paypal.experience_context;
  assert.equal(ctx.landing_page, 'GUEST_CHECKOUT', 'the card form first (Orders v2 schema 2.36: LOGIN, GUEST_CHECKOUT, NO_PREFERENCE, BILLING)');
  assert.equal(ctx.payment_method_preference, 'IMMEDIATE_PAYMENT_REQUIRED', 'no capture can sit pending (an eCheck); the same rule as subscriptions');
  assert.equal(ctx.shipping_preference, 'NO_SHIPPING');
  assert.equal(ctx.user_action, 'PAY_NOW');
  assert.equal(ctx.brand_name, 'ReforgedZ');
  assert.equal(ctx.return_url, 'https://shop.example.test/api/shop/paypal/return?order=42');
  assert.equal(ctx.cancel_url, 'https://shop.example.test/shop?cancelled=1');
  assert.equal(body.application_context, undefined, 'application_context.landing_page is deprecated since 2.9');
});

test('a long description is cut to 127 characters and a missing custom id is left out', () => {
  const body = paypal.orderRequest({ amountCents: 1234, description: 'x'.repeat(200), returnUrl: 'r', cancelUrl: 'c' });
  assert.equal(body.purchase_units[0].description.length, 127);
  assert.equal(body.purchase_units[0].custom_id, undefined);
  assert.equal(body.purchase_units[0].amount.value, '12.34');
});

test('a subscription is unchanged: paid from a PayPal account, payment required at once, no landing page set', () => {
  const body = paypal.subscriptionRequest({ planId: 'P-1', customId: 7, returnUrl: 'https://x/return-sub?order=7', cancelUrl: 'https://x/cancel-sub?order=7' });
  assert.equal(body.plan_id, 'P-1');
  assert.equal(body.custom_id, '7');
  const ctx = body.application_context;
  assert.deepEqual(ctx.payment_method, { payer_selected: 'PAYPAL', payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED' });
  assert.equal(ctx.user_action, 'SUBSCRIBE_NOW');
  assert.equal(ctx.shipping_preference, 'NO_SHIPPING');
  assert.equal(ctx.landing_page, undefined);
  assert.equal(ctx.brand_name, 'ReforgedZ');
  assert.equal(body.payment_source, undefined);
});
