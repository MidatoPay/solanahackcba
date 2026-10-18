import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PlatformError, units } from '../../../../src/platform/money.js';

const resourceId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function onepaySettings(env = process.env) {
  if (!/^sk_test_[A-Za-z0-9_-]+$/.test(env.ONEPAY_API_KEY || '')) throw new PlatformError('onepay_test_key_required', 503);
  return { token: env.ONEPAY_API_KEY };
}
export function unwrap(body) { return body?.data && !Array.isArray(body.data) ? body.data : body; }
export function createOnepay({ env = process.env, request = fetch } = {}) {
  async function call(path, { method = 'GET', body, key } = {}) {
    if (!/^\/(charges|cashouts|customers|accounts|balance|webhooks)(?:\/[^?#]*)?$/.test(path)) throw new Error('invalid_onepay_path');
    const { token } = onepaySettings(env);
    let response, payload;
    try {
      response = await request(`https://api.onepay.la/v1${path}`, { method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'x-idempotency': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      payload = await response.json();
    } catch { throw new PlatformError('onepay_unavailable', 503); }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'onepay_credentials_or_permission' :
        response.status === 409 ? 'onepay_idempotency_pending' : response.status === 422 ? 'onepay_validation_failed' : 'onepay_unavailable';
      throw new PlatformError(code, response.status >= 500 ? 503 : 409);
    }
    if (!payload || typeof payload !== 'object') throw new PlatformError('onepay_invalid_response', 503);
    return unwrap(payload);
  }
  const idPath = id => { if (!resourceId(id)) throw new PlatformError('onepay_invalid_identity', 503); return encodeURIComponent(id); };
  return {
    validateCharge, validateCashout,
    call,
    createCharge: (body, key) => call('/charges/bre-b', { method: 'POST', body, key }),
    getCharge: id => call(`/charges/${idPath(id)}`),
    cancelCharge: id => call(`/charges/${idPath(id)}/cancel`, { method: 'POST' }),
    createCashout: (body, key) => call('/cashouts', { method: 'POST', body, key }),
    getCashout: id => call(`/cashouts/${idPath(id)}`),
    createCustomer: (body, key) => call('/customers', { method: 'POST', body, key }),
    createBankAccount: (body, key) => call('/accounts', { method: 'POST', body, key }),
    getBanks: () => call('/accounts/banks'),
    getBrebKey: key => call(`/accounts/bre-b/${encodeURIComponent(key)}`),
    getBalance: async () => {
      const value = await call('/balance');
      // Official /client/movimientos/balance.md: balance is in major COP units.
      if (!resourceId(value.id) || value.currency && value.currency !== 'COP' || !['number', 'string'].includes(typeof value.balance))
        throw new PlatformError('onepay_balance_contract_pending', 503);
      return units(String(value.balance));
    },
  };
}
export function validateCharge(value, op, { creation = false } = {}) {
  if (!resourceId(value.id) || op.provider_id && value.id !== op.provider_id || value.is_test !== true ||
      value.currency !== 'COP' || units(String(value.amount)) !== BigInt(op.fiat_minor) ||
      (creation || value.external_id != null) && value.external_id !== op.id)
    throw new PlatformError('onepay_charge_mismatch');
  const reason = Array.isArray(value.remarks) ? value.remarks.join(',') : value.remarks?.code || value.remarks || '';
  let status = String(value.status || '').toLowerCase();
  if (['created', 'processing', 'pending'].includes(status)) status = 'awaiting_payment';
  else if (status === 'paid') status = 'paid';
  else if (/CANCELLED_BY_MERCHANT/.test(String(reason))) status = 'canceled';
  else if (/expired/i.test(String(reason)) || status === 'expired') status = 'expired';
  else if (['failed', 'declined', 'rejected'].includes(status)) status = 'failed';
  else if (['refunded', 'reversed'].includes(status)) status = 'refunded';
  else throw new PlatformError('onepay_unknown_charge_status');
  return { status, id: value.id, qr: typeof value.qr?.string === 'string' ? value.qr.string : null,
    paidAt: value.paid_at || null, expiresAt: value.expires_at || null };
}
export function validateCashout(value, op, destination) {
  if (!resourceId(value.id) || op.provider_id && value.id !== op.provider_id || value.is_test !== true ||
    units(String(value.amount)) !== BigInt(op.fiat_minor) || value.account_id !== destination.provider_account_id ||
    value.customer_id !== destination.provider_customer_id || value.currency && value.currency !== 'COP' ||
    value.external_id != null && value.external_id !== op.id ||
    (destination.kind === 'breb' ? !['BREB','BRE-B'].includes(value.method) : value.method !== 'ACH')) throw new PlatformError('onepay_cashout_mismatch');
  const state = String(value.status || '').toLowerCase();
  if (!['pending', 'processing', 'processed', 'failed', 'rejected', 'canceled'].includes(state)) throw new PlatformError('onepay_unknown_cashout_status');
  return { id: value.id, status: state === 'processed' ? 'completed' : ['failed', 'rejected', 'canceled'].includes(state) ? 'failed' : 'pending' };
}
function safeEqual(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyOnepayWebhook(event, env = process.env) {
  if (!env.ONEPAY_WEBHOOK_SECRET || !env.ONEPAY_WEBHOOK_TOKEN) throw new PlatformError('onepay_webhook_not_configured', 503);
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const raw = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
  if (raw.byteLength > 262144) throw new PlatformError('payload_too_large', 413);
  const signature = createHmac('sha256', env.ONEPAY_WEBHOOK_SECRET).update(raw).digest('hex');
  if (!safeEqual(headers['x-webhook-token'], env.ONEPAY_WEBHOOK_TOKEN) || !safeEqual(headers.signature, signature))
    throw new PlatformError('invalid_signature', 401);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new PlatformError('invalid_json', 400); }
  const type = typeof payload.event === 'string' ? payload.event : payload.event?.type;
  const resource = payload.data || (type?.startsWith('charge.') ? payload.charge : payload.cashout);
  if (!/^(charge|cashout)\.[a-z_]+$/.test(type || '') || !resourceId(resource?.id)) throw new PlatformError('unsupported_event', 400);
  return { key: createHash('sha256').update(raw).digest('hex'), type, resourceId: resource.id, payload };
}
