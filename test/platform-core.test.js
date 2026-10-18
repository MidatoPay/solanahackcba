import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { units, decimal, splitQuote, conversionQuote, conversionPolicy } from '../src/platform/money.js';
import { platformConfig, publicConfig } from '../netlify/functions/lib/platform/config.js';
import { normalizeQuotes, fetchPlatformQuote, resetQuoteCache } from '../netlify/functions/lib/platform/fx.js';
import { verifyOnepayWebhook, createOnepay, validateCharge, validateCashout } from '../netlify/functions/lib/platform/onepay.js';
import { createPlatformHandler } from '../netlify/functions/platform.js';
import { createOnepayWebhook } from '../netlify/functions/onepay-webhook.js';
import { sponsorDay, createPlatformService } from '../netlify/functions/lib/platform/service.js';
import { countryProviders } from '../netlify/functions/lib/platform/providers.js';
import { rampAdapters, RAMP_FACTORIES } from '../netlify/functions/lib/platform/ramps.js';
import { PaymentError } from '../netlify/functions/lib/paymentCore.js';

test('country catalog controls independent services and forbids Colombia mainnet/live', () => {
  const config = publicConfig({ PLATFORM_ENABLED: 'true' });
  assert.equal(config.country.code, 'CO'); assert.equal(config.services.brebWithdrawal.enabled, true);
  assert.equal(config.services.cardIssuing.enabled, false);
  assert.equal(publicConfig({}).services.qrCollection.enabled, false);
  assert.throws(() => platformConfig({ VITE_SOLANA_CLUSTER: 'mainnet-beta' }), /sandbox_devnet/);
  assert.throws(() => platformConfig({ APP_ENVIRONMENT: 'production' }), /sandbox_devnet/);
  assert.equal(platformConfig({ APP_COUNTRY: 'AR' }).country.legacy, true);
  assert.throws(() => createPlatformService({ config: platformConfig({ APP_COUNTRY: 'AR' }) }), /service_unavailable/);
  assert.equal(countryProviders({ ...platformConfig({}), services: {} }).collectionProvider, null);
  assert.throws(() => rampAdapters({})('missing-ramp'), /ramp_provider_not_integrated/);
  RAMP_FACTORIES['unsupported-fixture'] = () => ({ settlement: 'api' });
  try { assert.throws(() => rampAdapters({})('unsupported-fixture'), /ramp_contract_not_integrated/); }
  finally { delete RAMP_FACTORIES['unsupported-fixture']; }
  assert.ok(config.documents.every(d => d.draft && d.hash.length === 64));
  assert.equal(sponsorDay(new Date('2026-10-18T04:59:00Z')), '2026-10-17');
  assert.equal(sponsorDay(new Date('2026-10-18T05:00:00Z')), '2026-10-18');
});
test('split and conversions conserve exact minor units, fees only apply to converted value', () => {
  const split = splitQuote('10000000', { mode: 'percentage', value: '30' }, '4000');
  assert.equal(split.retainedMinor, '7000000'); assert.equal(split.feeMinor, '15000'); assert.equal(split.usdcRaw, '7462500');
  assert.equal(splitQuote('10000000', { mode: 'fixed', value: '200000' }, '4000').convertedMinor, '10000000');
  assert.equal(splitQuote('10000000', { mode: 'percentage', value: '0' }, undefined).retainedMinor, '10000000');
  const dust = splitQuote('100000', { mode: 'fixed', value: '0.01' }, '4000');
  assert.equal(dust.skipped, true); assert.equal(dust.feeMinor, '0'); assert.equal(dust.retainedMinor, '100000');
  const sell = conversionQuote('1000000', '4000', 'sell');
  assert.equal(sell.fiatMinor, '398000'); assert.equal(sell.feeMinor, '2000');
  assert.equal(decimal(units('123456.78')), '123456.78');
  assert.throws(() => units(1), /invalid_amount/); assert.throws(() => units('1e3'), /invalid_amount/);
  assert.throws(() => conversionPolicy({ mode: 'percentage', value: '100.01' }), /invalid_conversion_policy/);
});
test('CriptoYa median rejects stale, crossed, zero and future data and shares a cached fetch', async () => {
  const time = 1000, body = { a: { totalAsk: 4000, totalBid: 3900, time }, b: { totalAsk: 4200, totalBid: 4000, time },
    stale: { totalAsk: 200, totalBid: 100, time: 1 }, crossed: { totalAsk: 3, totalBid: 4, time }, zero: { totalAsk: 0, totalBid: 1, time } };
  assert.equal(normalizeQuotes(body, { now: 1000000 }).buy, '4100.00000000');
  assert.equal(normalizeQuotes(body, { now: 1000000 }).sell, '3950.00000000');
  assert.throws(() => normalizeQuotes(body, { now: 2000000 }), /quote_unavailable/);
  resetQuoteCache(); let count = 0;
  const options = { now: () => 1000000, request: async () => { count++; return { ok: true, json: async () => body }; } };
  const values = await Promise.all([fetchPlatformQuote(options), fetchPlatformQuote(options)]);
  assert.equal(count, 1); assert.deepEqual(values[0], values[1]);
  await fetchPlatformQuote(options); assert.equal(count, 1); resetQuoteCache();
});
test('simultaneous FX requests keep currencies isolated and recover after a synchronous transport failure', async () => {
  resetQuoteCache();
  const options = { now: () => 1000000, request: async url => ({ ok: true, json: async () => ({
    a: { totalAsk: url.includes('/cop/') ? 4000 : 1500, totalBid: url.includes('/cop/') ? 3900 : 1400, time: 1000 },
    b: { totalAsk: url.includes('/cop/') ? 4000 : 1500, totalBid: url.includes('/cop/') ? 3900 : 1400, time: 1000 },
  }) }) };
  const [cop, ars] = await Promise.all([fetchPlatformQuote(options), fetchPlatformQuote({ ...options, currency: 'ARS' })]);
  assert.equal(cop.currency, 'COP'); assert.equal(cop.buy, '4000.00000000');
  assert.equal(ars.currency, 'ARS'); assert.equal(ars.buy, '1500.00000000');
  resetQuoteCache();
  await assert.rejects(() => fetchPlatformQuote({ ...options, request() { throw new Error('offline'); } }), /quote_unavailable/);
  assert.equal((await fetchPlatformQuote(options)).currency, 'COP'); resetQuoteCache();
});
test('OnePay uses test keys, correct idempotency, COP units and documented Bre-B method', async () => {
  const calls = [], provider = createOnepay({ env: { ONEPAY_API_KEY: 'sk_test_offline' }, request: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/balance') ? { id: 'test-balance', balance: 1234.56 } : { id: 'test' } };
  } });
  await provider.createBankAccount({ subtype: 'KEY', account_number: '@test' }, 'stable-key');
  assert.equal(calls[0].options.headers['x-idempotency'], 'stable-key');
  assert.equal(JSON.parse(calls[0].options.body).subtype, 'KEY');
  assert.equal(await provider.getBalance(), 123456n);
  await assert.rejects(() => createOnepay({ env: { ONEPAY_API_KEY: 'sk_live_forbidden' } }).getCharge('x'), /test_key_required/);
  const op = { id: 'op', fiat_minor: '100000', provider_id: 'provider' };
  assert.equal(validateCharge({ id: 'provider', amount: 1000, is_test: true, currency: 'COP', status: 'pending' }, op).status, 'awaiting_payment');
  assert.throws(() => validateCharge({ id: 'provider', amount: 100000, is_test: true, currency: 'COP', status: 'paid' }, op), /mismatch/);
  assert.equal(validateCashout({ id: 'provider', amount: 1000, is_test: true, currency: 'COP', status: 'processed', method: 'BRE-B', account_id: 'a', customer_id: 'c' }, op,
    { kind: 'breb', provider_account_id: 'a', provider_customer_id: 'c' }).status, 'completed');
});
test('webhook authenticates exact bytes, handles base64 and both documented payload shapes', () => {
  const env = { ONEPAY_WEBHOOK_TOKEN: 'test-token', ONEPAY_WEBHOOK_SECRET: 'test-secret' };
  for (const payload of [{ event: 'charge.paid', data: { id: 'charge-1' } }, { event: { type: 'charge.paid' }, charge: { id: 'charge-1' } }]) {
    const body = JSON.stringify(payload, null, 2), signature = createHmac('sha256', env.ONEPAY_WEBHOOK_SECRET).update(body).digest('hex');
    const event = { body: Buffer.from(body).toString('base64'), isBase64Encoded: true, headers: { Signature: signature, 'X-Webhook-Token': 'test-token' } };
    assert.equal(verifyOnepayWebhook(event, env).resourceId, 'charge-1');
    assert.throws(() => verifyOnepayWebhook({ ...event, body: Buffer.from(body + ' ').toString('base64') }, env), /invalid_signature/);
  }
});
test('new APIs reject unauthenticated requests before creating a database/service', async () => {
  let touched = false;
  const handler = createPlatformHandler({ authenticate: async () => { throw new PaymentError('unauthorized', 401); }, service: () => { touched = true; } });
  assert.equal((await handler({ httpMethod: 'POST', path: '/platform/charges', headers: {}, body: '{}' })).statusCode, 401);
  assert.equal(touched, false);
  const webhook = createOnepayWebhook({ env: { ONEPAY_WEBHOOK_TOKEN: 'x', ONEPAY_WEBHOOK_SECRET: 'y' }, db: { query: () => { touched = true; } } });
  assert.equal((await webhook({ httpMethod: 'POST', body: '{}', headers: {} })).statusCode, 401);
  assert.equal(touched, false);
});
