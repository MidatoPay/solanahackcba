import { randomUUID } from 'node:crypto';
import { PlatformError } from '../../../../src/platform/money.js';
import { TERMINAL_STATUSES } from '../../../../src/platform/countries.js';
import { tokenAddress } from '../transferChain.js';
import { validateCharge, validateCashout } from './onepay.js';
import { atomic, operation, updateOperation, journal, copLine, userAccount, releaseCop } from './store.js';
import { insertOperation } from './service.js';

async function lockOperation(service, id, fn) {
  const { db: pool, config: c } = service, db = await pool.connect();
  let locked = false;
  try {
    locked = (await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`platform-op:${c.scope}:${id}`])).rows[0].locked;
    if (!locked) return;
    const op = (await db.query('SELECT * FROM platform_operations WHERE id=$1 AND scope=$2', [id, c.scope])).rows[0];
    if (op) await fn(op);
  } finally {
    let discard = false;
    try { if (locked) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`platform-op:${c.scope}:${id}`]); }
    catch { discard = true; }
    db.release(discard);
  }
}
export async function verifyChainTransfer(op, tx, network) {
  if (!tx || !tx.meta || tx.meta.err) throw new PlatformError('chain_proof_unavailable', 503);
  const from = op.kind === 'buy' ? op.treasury_address : op.wallet_address;
  const to = op.kind === 'buy' ? op.wallet_address : op.metadata.to;
  const [source, destination] = await Promise.all([tokenAddress(from, network), tokenAddress(to, network)]);
  const matching = tx.transaction?.message?.instructions?.filter(ix => ix.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && ix.parsed?.type === 'transferChecked');
  const info = matching?.[0]?.parsed?.info;
  if (matching?.length !== 1 || info?.source !== source || info?.destination !== destination || info?.authority !== from ||
      info?.mint !== network.mint || info?.tokenAmount?.decimals !== 6 || String(info?.tokenAmount?.amount) !== String(op.usdc_raw))
    throw new PlatformError('chain_proof_mismatch');
}
async function markFailure(service, op, status, code = null) {
  const { db, config: c } = service;
  await atomic(db, c.scope, async tx => {
    const fresh = await operation(tx, c.scope, op.user_id, op.id);
    await releaseCop(tx, c.scope, fresh);
    await updateOperation(tx, op.id, { status, reserve_raw: '0', reserve_minor: '0', last_error: code });
    if (fresh.parent_id) await updateOperation(tx, fresh.parent_id, { status: 'completed', last_error: 'conversion_failed_cop_returned' });
  });
}
async function acceptCollection(service, op, canonical) {
  const { db, config: c } = service;
  const line = (account, raw) => copLine(account, raw, c.country.currency);
  await atomic(db, c.scope, async tx => {
    const fresh = await operation(tx, c.scope, op.user_id, op.id);
    if (fresh.paid_at) return;
    const converted = BigInt(fresh.metadata.convertedMinor), retained = BigInt(fresh.retained_minor);
    await journal(tx, c.scope, fresh.id, `collection:${fresh.id}`, [line('provider:receipts', -BigInt(fresh.fiat_minor)),
      line(userAccount(fresh.user_id), retained), line(userAccount(fresh.user_id, 'reserved'), converted)]);
    if (converted > 0n) await insertOperation(tx, c, {
      user_id: fresh.user_id, kind: 'buy', provider: fresh.metadata.rampProvider || 'treasury', parent_id: fresh.id, status: 'pending', idempotency_key: randomUUID(), input_hash: fresh.input_hash,
      fiat_minor: String(converted), fee_minor: fresh.fee_minor, usdc_raw: fresh.usdc_raw, reserve_raw: fresh.reserve_raw,
      reserve_minor: String(converted), wallet_address: fresh.wallet_address, treasury_address: fresh.treasury_address, quote: fresh.quote,
    });
    await updateOperation(tx, fresh.id, { status: converted > 0n ? 'paid' : 'completed', paid_at: canonical.paidAt || new Date(),
      ...(converted === 0n ? { completed_at: new Date() } : {}), reserve_raw: '0', last_error: null });
  });
}
async function processCollection(service, original) {
  const { db, deps, config: c } = service;
  const provider = deps.providerFor(original.provider);
  const validate = provider.validateCharge || validateCharge;
  let op = original;
  if (!op.provider_id) {
    if (!op.metadata.creationAttempted) {
      if (['cancel_pending', 'canceled', 'expired'].includes(op.status)) return markFailure(service, op, 'canceled');
      if (new Date(op.expires_at) <= deps.now()) return markFailure(service, op, 'expired');
    }
    if (!c.enabled) return;
    op = await updateOperation(db, op.id, { metadata: { ...op.metadata, creationAttempted: true } });
    const response = await provider.createCharge(op.provider_body, op.idempotency_key);
    const canonical = validate(response, op, { creation: true });
    op = await atomic(db, c.scope, async tx => {
      const fresh = await operation(tx, c.scope, op.user_id, op.id);
      return updateOperation(tx, op.id, { provider_id: canonical.id, qr_data: canonical.qr,
        status: fresh.status === 'cancel_pending' ? 'cancel_pending' : 'awaiting_payment' });
    });
  }
  let value = await provider.getCharge(op.provider_id), canonical = validate(value, op);
  if (canonical.qr && !op.qr_data) op = await updateOperation(db, op.id, { qr_data: canonical.qr });
  if (canonical.status === 'awaiting_payment' && (op.status === 'cancel_pending' || new Date(op.expires_at) <= deps.now())) {
    try { await provider.cancelCharge(op.provider_id); } catch { /* A GET must settle cancellation/payment races. */ }
    value = await provider.getCharge(op.provider_id); canonical = validate(value, op);
  }
  if (canonical.status === 'paid') {
    if (['failed', 'expired', 'canceled'].includes(op.status)) throw new PlatformError('payment_after_terminal_state');
    await acceptCollection(service, op, canonical);
  } else if (['failed', 'expired', 'canceled', 'refunded'].includes(canonical.status)) {
    if (op.paid_at) throw new PlatformError('onepay_charge_reversed');
    await markFailure(service, op, canonical.status === 'refunded' ? 'failed' : canonical.status);
  }
}
async function finalizeChain(service, op) {
  const { db, config: c } = service;
  const line = (account, raw) => copLine(account, raw, c.country.currency);
  await atomic(db, c.scope, async tx => {
    const fresh = await operation(tx, c.scope, op.user_id, op.id);
    if (fresh.status === 'completed') return;
    const lines = [];
    if (op.kind === 'buy') {
      lines.push(line(userAccount(op.user_id, 'reserved'), -BigInt(op.fiat_minor)),
        line('platform:conversion_principal', BigInt(op.fiat_minor) - BigInt(op.fee_minor)), line('platform:conversion_fee', op.fee_minor));
    } else if (op.kind === 'sell') {
      lines.push(line(userAccount(op.user_id), op.fiat_minor), line('platform:conversion_fee', op.fee_minor),
        line('platform:conversion_principal', -(BigInt(op.fiat_minor) + BigInt(op.fee_minor))));
    }
    const from = op.kind === 'buy' ? op.treasury_address : op.wallet_address;
    const to = op.kind === 'buy' ? op.wallet_address : op.metadata.to;
    lines.push({ account: `wallet:${from}`, asset: 'USDC', raw: String(-BigInt(op.usdc_raw)) },
      { account: `wallet:${to}`, asset: 'USDC', raw: String(op.usdc_raw) });
    await journal(tx, c.scope, op.id, `chain:${op.id}`, lines);
    await updateOperation(tx, op.id, { status: 'completed', completed_at: new Date(), reserve_minor: '0', reserve_raw: '0', last_error: null });
    if (op.parent_id) await updateOperation(tx, op.parent_id, { status: 'completed', completed_at: new Date(), last_error: null });
  });
}
async function processChain(service, original) {
  const { db, config: c, deps } = service;
  let op = original;
  if (TERMINAL_STATUSES.has(op.status)) return;
  if (!op.signature && ['sell', 'transfer'].includes(op.kind)) {
    if (new Date(op.expires_at) <= deps.now()) await markFailure(service, op, 'expired');
    return;
  }
  if (await deps.rpc('getGenesisHash', []) !== c.network.genesis) throw new PlatformError('solana_rpc_network_mismatch', 503);
  if (!op.signature) {
    if (!c.enabled || op.status === 'manual_review') return;
    const ramp = deps.rampFor(op.provider);
    const liquidity = await ramp.liquidity(deps);
    if (liquidity.owner !== op.treasury_address) throw new PlatformError('treasury_account_changed');
    if (BigInt(liquidity.raw) < BigInt(op.usdc_raw)) throw new PlatformError('insufficient_treasury');
    const prepared = await ramp.prepareBuy(op, c, deps);
    op = await updateOperation(db, op.id, { signature: prepared.hash, signed_wire: prepared.wire,
      last_valid_block_height: prepared.lastValidBlockHeight, status: 'broadcasting' });
  }
  const result = await deps.rpc('getSignatureStatuses', [[op.signature], { searchTransactionHistory: true }]);
  const status = result.value?.[0];
  if (status?.confirmationStatus === 'finalized') {
    if (status.err) return markFailure(service, op, 'failed', 'transfer_onchain_failed');
    const tx = await deps.rpc('getTransaction', [op.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
    await (deps.verifyChain || verifyChainTransfer)(op, tx, c.network);
    return finalizeChain(service, op);
  }
  if (status?.confirmationStatus === 'confirmed') {
    await updateOperation(db, op.id, { status: 'confirmed', last_error: status.err ? 'waiting_chain_finality' : null });
    return;
  }
  const height = await deps.rpc('getBlockHeight', [{ commitment: 'finalized' }]);
  if (BigInt(height) > BigInt(op.last_valid_block_height)) {
    if (!status) throw new PlatformError('transfer_expired_requires_review');
    return;
  }
  // The only broadcast path uses bytes that have already been committed.
  if (c.enabled && op.status !== 'manual_review') await deps.rpc('sendTransaction', [op.signed_wire, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]);
}
async function processWithdrawal(service, original) {
  const { db, config: c, deps } = service;
  const provider = deps.providerFor(original.provider);
  const validate = provider.validateCashout || validateCashout;
  let op = original;
  const dest = (await db.query('SELECT * FROM platform_destinations WHERE id=$1 AND scope=$2 AND user_id=$3', [op.destination_id, c.scope, op.user_id])).rows[0];
  if (!dest?.provider_account_id) throw new PlatformError('destination_not_ready');
  if (dest.provider !== op.provider) throw new PlatformError('destination_provider_mismatch');
  if (!op.provider_id) {
    if (!c.enabled || op.status === 'manual_review') return;
    const result = await provider.createCashout(op.provider_body, op.idempotency_key);
    const canonical = validate(result, op, dest);
    op = await updateOperation(db, op.id, { provider_id: canonical.id, status: 'pending' });
  }
  const result = validate(await provider.getCashout(op.provider_id), op, dest);
  if (result.status === 'completed') {
    await atomic(db, c.scope, async tx => {
      const fresh = await operation(tx, c.scope, op.user_id, op.id);
      if (fresh.status === 'completed') return;
      if (fresh.status === 'failed') throw new PlatformError('cashout_after_terminal_state');
      await journal(tx, c.scope, op.id, `withdrawal:${op.id}`, [copLine(userAccount(op.user_id, 'reserved'), -BigInt(op.fiat_minor), c.country.currency), copLine('provider:withdrawals', op.fiat_minor, c.country.currency)]);
      await updateOperation(tx, op.id, { status: 'completed', completed_at: new Date(), reserve_minor: '0', last_error: null });
    });
  } else if (result.status === 'failed') {
    if (op.status === 'completed') throw new PlatformError('cashout_reversed_requires_review');
    await markFailure(service, op, 'failed', 'onepay_cashout_failed');
  }
}
const reviewCodes = new Set(['onepay_charge_mismatch', 'onepay_cashout_mismatch', 'onepay_unknown_charge_status', 'onepay_unknown_cashout_status',
  'chain_proof_mismatch', 'transfer_expired_requires_review', 'onepay_charge_reversed', 'payment_after_terminal_state',
  'cashout_after_terminal_state', 'cashout_reversed_requires_review', 'treasury_account_changed', 'destination_provider_mismatch']);
export async function processOperation(service, id) {
  const { db, config: c } = service;
  return lockOperation(service, id, async op => {
    try {
      if (op.kind === 'collection') await processCollection(service, op);
      else if (op.kind === 'withdrawal') await processWithdrawal(service, op);
      else await processChain(service, op);
      await db.query("UPDATE platform_operations SET next_attempt_at=now()+interval '5 seconds',attempts=attempts+1 WHERE id=$1", [op.id]);
    } catch (error) {
      const code = error instanceof PlatformError ? error.code : 'operation_tracking_unavailable';
      await db.query(`UPDATE platform_operations SET last_error=$2,attempts=attempts+1,next_attempt_at=now()+interval '30 seconds',
        status=CASE WHEN $3::boolean THEN 'manual_review' ELSE status END WHERE id=$1 AND scope=$4`, [op.id, code, reviewCodes.has(code), c.scope]);
    }
  });
}
export async function runPlatformWorker(service, { budgetMs = 45000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { db, config: c } = service, deadline = Date.now() + budgetMs;
  const lease = await db.connect(); let locked = false, checked = 0;
  try {
    locked = (await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`platform-worker:${c.scope}`])).rows[0].locked;
    if (!locked) return { checked };
    while (Date.now() < deadline) {
      const inbox = (await db.query('SELECT id,resource_id,provider FROM platform_inbox WHERE scope=$1 AND processed_at IS NULL ORDER BY created_at LIMIT 25', [c.scope])).rows;
      for (const event of inbox) {
        const matches = (await db.query('SELECT id FROM platform_operations WHERE scope=$1 AND provider_id=$2 AND provider=$3', [c.scope, event.resource_id, event.provider])).rows;
        if (matches.length) {
          for (const op of matches) { await processOperation(service, op.id); checked++; }
          await db.query('UPDATE platform_inbox SET processed_at=now() WHERE id=$1', [event.id]);
        } else await db.query("UPDATE platform_inbox SET last_error='resource_not_registered' WHERE id=$1", [event.id]);
      }
      const due = (await db.query(`SELECT id FROM platform_operations WHERE scope=$1 AND next_attempt_at<=now()
        AND status NOT IN ('completed','failed','canceled','expired') ORDER BY next_attempt_at LIMIT 20`, [c.scope])).rows;
      for (const op of due) { if (Date.now() >= deadline) break; await processOperation(service, op.id); checked++; }
      if (!due.length) break;
      if (Date.now() + 1800 < deadline) await wait(1800); else break;
    }
    return { checked };
  } finally {
    let discard = false;
    try { if (locked) await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`platform-worker:${c.scope}`]); }
    catch { discard = true; }
    lease.release(discard);
  }
}
