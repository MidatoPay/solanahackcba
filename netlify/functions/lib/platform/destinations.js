import { randomUUID } from 'node:crypto';
import { PlatformError } from '../../../../src/platform/money.js';
import { atomic, merchant, hashInput, idempotency } from './store.js';
import { requireAcceptance } from './service.js';
import { withdrawalService } from './providers.js';
import { providerCustomer } from './beneficiaries.js';

function text(value, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new PlatformError('invalid_beneficiary', 400);
  return value.trim();
}
export async function registerCustomer(service, userId, input) {
  const { db, config: c, deps } = service;
  const { providerId } = withdrawalService(c, input.kind);
  const provider = deps.providerFor(providerId);
  const body = { user_type: 'natural', first_name: text(input.firstName), last_name: text(input.lastName),
    email: text(input.email, 200), phone: text(input.phone, 20), document_type: text(input.documentType, 5),
    document_number: text(input.documentNumber, 30), nationality: 'CO', birthdate: text(input.birthdate, 10), enable_notifications: false };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || !/^\+57\d{10}$/.test(body.phone) ||
    !['CC', 'CE', 'PP'].includes(body.document_type) || !/^\d{4}-\d{2}-\d{2}$/.test(body.birthdate) ||
    !Number.isFinite(Date.parse(body.birthdate)) || new Date(body.birthdate).toISOString().slice(0, 10) !== body.birthdate ||
    new Date(body.birthdate) >= deps.now()) throw new PlatformError('invalid_beneficiary', 400);
  const m = await atomic(db, c.scope, async tx => {
    await requireAcceptance(tx, c, userId);
    await merchant(tx, c.scope, userId);
    const current = await providerCustomer(tx, c.scope, userId, providerId);
    const hash = hashInput(body);
    if (current.customer_input_hash && current.customer_input_hash !== hash) throw new PlatformError('beneficiary_identity_already_saved');
    await tx.query('UPDATE platform_provider_customers SET customer_body=$4,customer_input_hash=$5 WHERE scope=$1 AND user_id=$2 AND provider=$3', [c.scope, userId, providerId, JSON.stringify(body), hash]);
    return { ...current, customer_body: body };
  });
  if (m.customer_id) return { ready: true };
  const result = await provider.createCustomer(m.customer_body, m.customer_key);
  if (typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(result.id) || result.is_test === false ||
    result.document_number != null && String(result.document_number) !== body.document_number)
    throw new PlatformError('onepay_customer_mismatch');
  await atomic(db, c.scope, async tx => {
    const fresh = await providerCustomer(tx, c.scope, userId, providerId);
    if (fresh.customer_id && fresh.customer_id !== result.id) throw new PlatformError('onepay_customer_mismatch');
    await tx.query('UPDATE platform_provider_customers SET customer_id=$4 WHERE scope=$1 AND user_id=$2 AND provider=$3', [c.scope, userId, providerId, result.id]);
  });
  return { ready: true };
}
export async function inspectBrebKey(service, userId, key) {
  const { db, config: c, deps } = service;
  const { providerId } = withdrawalService(c, 'breb');
  await requireAcceptance(db, c, userId);
  text(key);
  const m = await providerCustomer(db, c.scope, userId, providerId);
  if (!m.customer_id) throw new PlatformError('beneficiary_required');
  const found = await deps.providerFor(providerId).getBrebKey(key);
  if (found.status !== 'ACTIVE' || String(found.document_number) !== m.customer_body?.document_number || found.document_type !== m.customer_body?.document_type)
    throw new PlatformError('breb_key_owner_mismatch');
  return { active: true, bank: found.bank?.name || '', key: `${key.slice(0, 2)}••••${key.slice(-3)}` };
}
export async function registerDestination(service, userId, input, key) {
  const { db, config: c, deps } = service;
  idempotency(key);
  if (!['bank', 'breb'].includes(input.kind)) throw new PlatformError('invalid_destination', 400);
  const normalized = input.kind === 'bank'
    ? { kind: 'bank', bankId: text(input.bankId), subtype: text(input.subtype), accountNumber: text(input.accountNumber, 30) }
    : { kind: 'breb', key: text(input.key) };
  if (input.kind === 'bank' && (!['SAVINGS', 'CHECKING'].includes(normalized.subtype) || !/^\d{4,30}$/.test(normalized.accountNumber))) throw new PlatformError('invalid_destination', 400);
  const { providerId } = withdrawalService(c, input.kind);
  const provider = deps.providerFor(providerId);
  await requireAcceptance(db, c, userId);
  const fingerprint = hashInput(normalized);
  const previous = (await db.query('SELECT * FROM platform_destinations WHERE scope=$1 AND user_id=$2 AND idempotency_key=$3', [c.scope, userId, key])).rows[0];
  if (previous && previous.provider !== providerId) throw new PlatformError('destination_provider_changed');
  if (previous && previous.input_hash !== fingerprint) throw new PlatformError('idempotency_conflict');
  if (previous?.status === 'ready') return { id: previous.id, kind: previous.kind, label: previous.label, status: previous.status };
  const m = await providerCustomer(db, c.scope, userId, providerId);
  if (!m.customer_id) throw new PlatformError('beneficiary_required');
  if (input.kind === 'breb') await inspectBrebKey(service, userId, normalized.key);
  const dest = await atomic(db, c.scope, async tx => {
    const existing = (await tx.query('SELECT * FROM platform_destinations WHERE scope=$1 AND user_id=$2 AND idempotency_key=$3', [c.scope, userId, key])).rows[0];
    if (existing) {
      if (existing.provider !== providerId) throw new PlatformError('destination_provider_changed');
      if (existing.input_hash !== fingerprint) throw new PlatformError('idempotency_conflict'); return existing;
    }
    if ((await tx.query('SELECT 1 FROM platform_closed_attempts WHERE scope=$1 AND user_id=$2 AND idempotency_key=$3', [c.scope, userId, key])).rows.length) throw new PlatformError('attempt_closed');
    const id = randomUUID();
    const body = input.kind === 'breb'
      ? { subtype: 'KEY', account_number: normalized.key, customer_id: m.customer_id, external_id: id }
      : { subtype: normalized.subtype, account_number: normalized.accountNumber, bank_id: normalized.bankId, customer_id: m.customer_id, external_id: id };
    const label = input.kind === 'breb' ? `Bre-B •••${normalized.key.slice(-4)}` : `Cuenta •••${normalized.accountNumber.slice(-4)}`;
    return (await tx.query(`INSERT INTO platform_destinations(id,scope,user_id,kind,label,provider_customer_id,idempotency_key,input_hash,provider_body,provider)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [id, c.scope, userId, input.kind, label, m.customer_id, key, fingerprint, JSON.stringify(body), providerId])).rows[0];
  });
  const account = await provider.createBankAccount(dest.provider_body, dest.idempotency_key);
  if (typeof account.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(account.id) || account.customer_id !== m.customer_id || account.customer?.is_test === false || account.is_test === false)
    throw new PlatformError('onepay_destination_mismatch');
  await db.query("UPDATE platform_destinations SET provider_account_id=$2,status='ready',last_error=NULL WHERE id=$1", [dest.id, account.id]);
  return { id: dest.id, kind: dest.kind, label: dest.label, status: 'ready' };
}
