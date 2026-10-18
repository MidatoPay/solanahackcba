import { randomUUID } from 'node:crypto';
import { PlatformError } from '../../../../src/platform/money.js';
import { tokenAddress } from '../transferChain.js';
import { atomic, hashInput, journal } from './store.js';
import { insertOperation } from './service.js';

export function incomingAmount(tx, ata, owner, mint) {
  if (!tx?.meta || tx.meta.err) return 0n;
  const keys = tx.transaction?.message?.accountKeys || [];
  const index = keys.findIndex(key => (typeof key === 'string' ? key : key.pubkey) === ata);
  if (index < 0) return 0n;
  const post = tx.meta.postTokenBalances?.find(value => value.accountIndex === index);
  const pre = tx.meta.preTokenBalances?.find(value => value.accountIndex === index);
  if (post?.mint !== mint || post.owner !== owner || post.uiTokenAmount?.decimals !== 6 ||
      pre && (pre.mint !== mint || pre.owner && pre.owner !== owner || pre.uiTokenAmount?.decimals !== 6)) return 0n;
  const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount?.amount || '0');
  return delta > 0n ? delta : 0n;
}
export async function reconcilePlatformWallet(service, userId, { deadline = Date.now() + 30000 } = {}) {
  const lease = await service.db.connect();
  const key = `platform-wallet:${service.config.scope}:${userId}`;
  let locked = false;
  try {
    locked = (await lease.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key])).rows[0].locked;
    if (!locked) return { checked: 0 };
    return await reconcileWallet(service, userId, deadline);
  } finally {
    let discard = false;
    try { if (locked) await lease.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
    catch { discard = true; }
    lease.release(discard);
  }
}
async function reconcileWallet(service, userId, deadline) {
  const { db, config: c, deps } = service;
  const m = (await db.query('SELECT * FROM platform_merchants WHERE scope=$1 AND user_id=$2', [c.scope, userId])).rows[0];
  if (!m?.wallet_address) return { checked: 0 };
  if (await deps.rpc('getGenesisHash', []) !== c.network.genesis) throw new PlatformError('solana_rpc_network_mismatch', 503);
  const ata = await tokenAddress(m.wallet_address, c.network);
  let before = m.sync_before || undefined, head = m.sync_head, complete = false, checked = 0;
  for (let page = 0; page < 4 && Date.now() < deadline; page++) {
    const list = await deps.rpc('getSignaturesForAddress', [ata, { commitment: 'finalized', limit: 25,
      ...(before ? { before } : {}), ...(m.sync_signature ? { until: m.sync_signature } : {}) }]);
    if (!Array.isArray(list)) throw new PlatformError('chain_proof_unavailable', 503);
    head ||= list[0]?.signature;
    if (!list.length) { complete = true; break; }
    let processed = 0;
    for (const row of list) {
      if (Date.now() >= deadline) break;
      const known = (await db.query('SELECT id,user_id,kind FROM platform_operations WHERE scope=$1 AND signature=$2', [c.scope, row.signature])).rows;
      if (!row.err && !known.some(op => op.user_id === userId)) {
        const tx = await deps.rpc('getTransaction', [row.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]);
        if (!tx) throw new PlatformError('chain_proof_unavailable', 503);
        const amount = incomingAmount(tx, ata, m.wallet_address, c.network.mint);
        if (amount > 0n) await atomic(db, c.scope, async sql => {
          if ((await sql.query('SELECT id FROM platform_operations WHERE scope=$1 AND user_id=$2 AND signature=$3', [c.scope, userId, row.signature])).rows.length) return;
          const created = await insertOperation(sql, c, { user_id: userId, kind: 'receive', provider: 'solana', status: 'completed',
            idempotency_key: randomUUID(), input_hash: hashInput({ signature: row.signature, userId }), usdc_raw: String(amount),
            wallet_address: m.wallet_address, signature: row.signature, completed_at: new Date((row.blockTime || Date.now() / 1000) * 1000),
            created_at: new Date((row.blockTime || Date.now() / 1000) * 1000) });
          // Managed outgoing transactions already own their chain journal.
          if (!known.some(op => op.kind !== 'receive')) await journal(sql, c.scope, created.id, `incoming:${userId}:${row.signature}`, [
            { account: 'external:solana', asset: 'USDC', raw: String(-amount) },
            { account: `wallet:${m.wallet_address}`, asset: 'USDC', raw: String(amount) },
          ]);
        });
      }
      before = row.signature; processed++; checked++;
    }
    if (processed === list.length && list.length < 25) { complete = true; break; }
    if (processed < list.length) break;
  }
  if (head) await db.query(`UPDATE platform_merchants SET sync_signature=$4,sync_before=$5,sync_head=$6
    WHERE scope=$1 AND user_id=$2 AND wallet_address=$3`, [c.scope, userId, m.wallet_address,
    complete ? head : m.sync_signature, complete ? null : before || null, complete ? null : head]);
  return { checked };
}
