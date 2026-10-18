import { randomUUID, createHash } from 'node:crypto';
import { PlatformError, decimal } from '../../../../src/platform/money.js';

export const hashInput = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function idempotency(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || ''))
    throw new PlatformError('invalid_idempotency_key', 400);
  return value;
}
export async function atomic(pool, scope, fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`platform:${scope}`]);
    const result = await fn(db); await db.query('COMMIT'); return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
export async function merchant(db, scope, userId) {
  const { rows } = await db.query(`INSERT INTO platform_merchants(scope,user_id,customer_key) VALUES($1,$2,$3)
    ON CONFLICT(scope,user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING *`, [scope, userId, randomUUID()]);
  return rows[0];
}
export async function operation(db, scope, userId, id) {
  const { rows } = await db.query('SELECT * FROM platform_operations WHERE scope=$1 AND user_id=$2 AND id=$3', [scope, userId, id]);
  if (!rows[0]) throw new PlatformError('operation_not_found', 404);
  return rows[0];
}
export async function existingOperation(db, scope, userId, key, hash) {
  const { rows } = await db.query('SELECT * FROM platform_operations WHERE scope=$1 AND user_id=$2 AND idempotency_key=$3', [scope, userId, key]);
  if (rows[0] && rows[0].input_hash !== hash) throw new PlatformError('idempotency_conflict');
  return rows[0];
}
const mutable = new Set(['status', 'provider_id', 'qr_data', 'expires_at', 'paid_at', 'completed_at', 'last_error', 'signature',
  'signed_wire', 'unsigned_wire', 'last_valid_block_height', 'fee_payer', 'cost_lamports', 'sponsor_day',
  'reserve_raw', 'reserve_minor', 'next_attempt_at', 'metadata', 'attempts']);
export async function updateOperation(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length || keys.some(key => !mutable.has(key))) throw new Error('invalid_operation_update');
  const { rows } = await db.query(`UPDATE platform_operations SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(',')},updated_at=now() WHERE id=$1 RETURNING *`,
    [id, ...Object.values(fields)]);
  return rows[0];
}
export const userAccount = (userId, bucket = 'available') => `user:${userId}:${bucket}`;
export async function accountBalance(db, scope, account, asset = 'COP') {
  const { rows } = await db.query(`SELECT COALESCE(SUM((e->>'raw')::numeric),0)::text AS raw
    FROM platform_journals j CROSS JOIN LATERAL jsonb_array_elements(j.entries) e
    WHERE j.scope=$1 AND e->>'account'=$2 AND e->>'asset'=$3`, [scope, account, asset]);
  return BigInt(rows[0].raw);
}
export async function balances(db, scope, userId, currency = 'COP') {
  const available = await accountBalance(db, scope, userAccount(userId), currency);
  const reserved = await accountBalance(db, scope, userAccount(userId, 'reserved'), currency);
  return { currency, available: decimal(available), reserved: decimal(reserved) };
}
export async function journal(db, scope, operationId, eventKey, lines) {
  const entries = lines.filter(line => BigInt(line.raw) !== 0n).map(line => ({ ...line, raw: String(line.raw) }));
  const totals = new Map();
  for (const entry of entries) totals.set(entry.asset, (totals.get(entry.asset) || 0n) + BigInt(entry.raw));
  if (entries.length < 2 || [...totals.values()].some(total => total !== 0n)) throw new Error('unbalanced_journal');
  const result = await db.query(`INSERT INTO platform_journals(id,scope,event_key,operation_id,entries) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(scope,event_key) DO NOTHING RETURNING id`, [randomUUID(), scope, eventKey, operationId, JSON.stringify(entries)]);
  return result.rows.length === 1;
}
export function copLine(account, raw, currency = 'COP') { return { account, asset: currency, raw: String(raw) }; }
export async function reserveCop(db, scope, op, amount) {
  const raw = BigInt(amount);
  if (await accountBalance(db, scope, userAccount(op.user_id), op.currency) < raw) throw new PlatformError('insufficient_cop');
  return journal(db, scope, op.id, `reserve:${op.id}`, [copLine(userAccount(op.user_id), -raw, op.currency), copLine(userAccount(op.user_id, 'reserved'), raw, op.currency)]);
}
export async function releaseCop(db, scope, op) {
  const raw = BigInt(op.reserve_minor);
  if (raw > 0n && ['buy', 'withdrawal'].includes(op.kind)) await journal(db, scope, op.id, `release:${op.id}`, [copLine(userAccount(op.user_id, 'reserved'), -raw, op.currency), copLine(userAccount(op.user_id), raw, op.currency)]);
  await updateOperation(db, op.id, { reserve_minor: '0', reserve_raw: '0' });
}
export function publicOperation(op, children = []) {
  return { id: op.id, kind: op.kind, status: op.status, parentId: op.parent_id, country: op.country, currency: op.currency,
    provider: op.provider, providerId: op.provider_id, fiatAmount: decimal(op.fiat_minor), feeFiat: decimal(op.fee_minor),
    retainedFiat: decimal(op.retained_minor), usdcAmount: decimal(op.usdc_raw, 6), quote: op.quote, policy: op.policy,
    wallet: op.wallet_address, treasury: op.treasury_address, to: op.kind === 'buy' ? op.wallet_address : op.metadata?.to || null, destinationId: op.destination_id,
    destinationLabel: op.metadata?.destinationLabel || null,
    qrData: op.qr_data, signature: op.signature, network: op.network, expiresAt: op.expires_at,
    createdAt: op.created_at, paidAt: op.paid_at, completedAt: op.completed_at, lastError: op.last_error,
    splitSkipped: op.metadata?.splitSkipped === true, children: children.map(child => publicOperation(child)),
    ...(op.status === 'awaiting_signature' ? { transaction: op.unsigned_wire, feePayer: op.fee_payer } : {}) };
}
