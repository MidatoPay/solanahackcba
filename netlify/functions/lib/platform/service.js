import { randomUUID } from 'node:crypto';
import { isAddress } from '@solana/kit';
import { PlatformError, units, decimal, fiatAmount, conversionPolicy, conversionQuote, splitQuote } from '../../../../src/platform/money.js';
import { TERMINAL_STATUSES, bankContactsAvailable } from '../../../../src/platform/countries.js';
import { normalizeContact } from '../../../../src/platform/contacts.js';
import { primarySolanaWallet } from '../../../../src/primaryWallet.js';
import { getPaymentPrivy } from '../paymentRuntime.js';
import { treasuryLiquidity, getTreasuryAddress } from '../treasuryPayout.js';
import { prepareTransfer, sourceBalance, validateUserSignature, signSponsoredTransfer, transferRpc } from '../transferChain.js';
import { getPlatformDb, platformConfig, assertService } from './config.js';
import { legalDocuments } from './legal.js';
import { countryProviders, withdrawalService } from './providers.js';
import { atomic, merchant, operation, existingOperation, hashInput, idempotency, balances, publicOperation,
  updateOperation, reserveCop, releaseCop } from './store.js';

export async function accepted(db, c, userId) {
  const { rows } = await db.query('SELECT document_id,version,document_hash FROM platform_acceptances WHERE scope=$1 AND user_id=$2', [c.scope, userId]);
  return legalDocuments(c.country.code).every(doc => rows.some(row => row.document_id === doc.id && row.version === doc.version && row.document_hash === doc.hash));
}
export async function requireAcceptance(db, c, userId) {
  if (!await accepted(db, c, userId)) throw new PlatformError('legal_acceptance_required', 403);
}
export async function insertOperation(db, c, data) {
  const value = { id: randomUUID(), scope: c.scope, country: c.country.code, currency: c.country.currency,
    environment: c.environment, network: c.network.cluster, provider: 'treasury', ...data };
  const keys = Object.keys(value);
  return (await db.query(`INSERT INTO platform_operations(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    keys.map(key => ['metadata', 'quote', 'policy', 'provider_body'].includes(key) && value[key] != null ? JSON.stringify(value[key]) : value[key]))).rows[0];
}
export async function reserveTreasury(db, c, raw, deps, rampId = c.services.onRamp?.provider) {
  if (BigInt(raw) === 0n) return null;
  const liquidity = await deps.rampFor(rampId).liquidity(deps);
  if (!isAddress(liquidity.owner || '')) throw new PlatformError('invalid_treasury');
  const { rows } = await db.query('SELECT COALESCE(SUM(reserve_raw),0)::text AS raw FROM platform_operations WHERE scope=$1 AND treasury_address=$2', [c.scope, liquidity.owner]);
  if (BigInt(liquidity.raw) - BigInt(rows[0].raw) < BigInt(raw)) throw new PlatformError('insufficient_treasury');
  if (BigInt(liquidity.solLamports) < 3000000n) throw new PlatformError('treasury_sol_unavailable');
  return liquidity.owner;
}
export async function reserveFiatLiquidity(db, c, extra, deps, provider = deps.provider) {
  const external = await provider.getBalance();
  const { rows: [liabilities] } = await db.query(`SELECT COALESCE(SUM((e->>'raw')::numeric),0)::text AS raw
    FROM platform_journals j CROSS JOIN LATERAL jsonb_array_elements(j.entries) e
    WHERE j.scope=$1 AND e->>'asset'=$2 AND e->>'account' LIKE 'user:%'`, [c.scope, c.country.currency]);
  const { rows: [pending] } = await db.query(`SELECT COALESCE(SUM(reserve_minor),0)::text AS raw
    FROM platform_operations WHERE scope=$1 AND kind='sell'`, [c.scope]);
  if (external < BigInt(liabilities.raw) + BigInt(pending.raw) + BigInt(extra)) throw new PlatformError('insufficient_onepay_liquidity');
}
export function sponsorDay(now = new Date(), timeZone = 'America/Bogota') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function createPlatformService(overrides = {}) {
  const env = overrides.env || process.env, config = overrides.config || platformConfig(env);
  if (config.country.legacy) throw new PlatformError('service_unavailable', 403);
  const db = overrides.db || getPlatformDb(env);
  const registered = countryProviders(config, env);
  const deps = {
    ...registered, liquidity: treasuryLiquidity,
    primary: async userId => primarySolanaWallet(await getPaymentPrivy().getUser(userId))?.address || null,
    treasury: getTreasuryAddress, prepareTransfer, sourceBalance, validateUserSignature, signSponsoredTransfer,
    rpc: transferRpc, now: () => new Date(), ...overrides,
  };
  if (overrides.provider) { deps.collectionProvider = overrides.collectionProvider || overrides.provider; deps.providerFor = overrides.providerFor || (() => overrides.provider); }
  const c = config;
  async function ownWallet(userId, wallet) {
    const address = await deps.primary(userId);
    if (!isAddress(wallet || '') || !address || address !== wallet) throw new PlatformError('primary_wallet_required', 403);
    return wallet;
  }
  async function replay(userId, key, input) {
    idempotency(key);
    return existingOperation(db, c.scope, userId, key, hashInput(input));
  }
  async function newIntent(userId, kind, key, input, build) {
    const existing = await replay(userId, key, { kind, ...input });
    if (existing) return existing;
    return atomic(db, c.scope, async tx => {
      const duplicate = await existingOperation(tx, c.scope, userId, key, hashInput({ kind, ...input }));
      if (duplicate) return duplicate;
      const closed = await tx.query('SELECT 1 FROM platform_closed_attempts WHERE scope=$1 AND user_id=$2 AND idempotency_key=$3', [c.scope, userId, key]);
      if (closed.rows.length) throw new PlatformError('attempt_closed');
      await requireAcceptance(tx, c, userId);
      const blocked = await tx.query(`SELECT id FROM platform_operations WHERE scope=$1 AND user_id=$2 AND status='manual_review'
        AND last_error IN ('onepay_charge_reversed','cashout_after_terminal_state','cashout_reversed_requires_review','payment_after_terminal_state') LIMIT 1`, [c.scope, userId]);
      if (blocked.rows.length) throw new PlatformError('account_requires_reconciliation');
      return build(tx, { user_id: userId, kind, idempotency_key: key, input_hash: hashInput({ kind, ...input }) });
    });
  }
  async function getSavedQuote(tx, userId, quoteId, direction) {
    const { rows: [saved] } = await tx.query('SELECT * FROM platform_quotes WHERE id=$1 AND scope=$2 AND user_id=$3 AND direction=$4', [quoteId, c.scope, userId, direction]);
    if (!saved || new Date(saved.expires_at) <= deps.now()) throw new PlatformError('quote_expired');
    return saved;
  }
  const api = {
    db, config: c, deps,
    async me(userId) {
      const m = await merchant(db, c.scope, userId);
      const wallet = await deps.primary(userId);
      if (wallet && wallet !== m.wallet_address) await atomic(db, c.scope, async tx => {
        const fresh = await merchant(tx, c.scope, userId);
        if (wallet !== fresh.wallet_address) {
          await tx.query('INSERT INTO platform_wallet_audit(id,scope,user_id,previous_address,primary_address) VALUES($1,$2,$3,$4,$5)', [randomUUID(), c.scope, userId, fresh.wallet_address, wallet]);
          await tx.query('UPDATE platform_merchants SET wallet_address=$3,sync_signature=NULL,sync_before=NULL,sync_head=NULL WHERE scope=$1 AND user_id=$2', [c.scope, userId, wallet]);
        }
      });
      const dest = await db.query(`SELECT id,kind,label,status,last_error,provider FROM platform_destinations WHERE scope=$1 AND user_id=$2 ORDER BY created_at DESC`, [c.scope, userId]);
      const identities = (await db.query('SELECT provider FROM platform_provider_customers WHERE scope=$1 AND user_id=$2 AND customer_id IS NOT NULL', [c.scope, userId])).rows;
      const customers = Object.fromEntries(['bank', 'breb'].map(kind => [kind, identities.some(identity => identity.provider === c.services[kind === 'bank' ? 'bankWithdrawal' : 'brebWithdrawal']?.provider)]));
      const destinations = dest.rows.map(destination => ({ ...destination,
        ...(destination.provider !== c.services[destination.kind === 'breb' ? 'brebWithdrawal' : 'bankWithdrawal']?.provider
          ? { status: 'provider_changed', last_error: 'destination_provider_changed' } : {}),
      }));
      const bankEnabled = bankContactsAvailable(c);
      const contacts = (await db.query('SELECT id,name,alias,address,bank_accounts FROM platform_contacts WHERE scope=$1 AND user_id=$2 ORDER BY name,id', [c.scope, userId])).rows
        .filter(contact => bankEnabled || contact.address)
        .map(({ bank_accounts, ...contact }) => ({ ...contact, ...(bankEnabled ? { bankAccounts: bank_accounts } : {}) }));
      return { merchant: { businessName: m.business_name, policy: m.policy, customers, customerReady: c.services.bankWithdrawal?.available ? customers.bank : customers.breb },
        balances: await balances(db, c.scope, userId, c.country.currency), wallet, accepted: await accepted(db, c, userId), destinations, contacts };
    },
    async saveContact(userId, input) {
      if (input?.id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)) throw new PlatformError('contact_not_found', 404);
      return atomic(db, c.scope, async tx => {
        const previous = input?.id ? (await tx.query('SELECT * FROM platform_contacts WHERE id=$1 AND scope=$2 AND user_id=$3', [input.id, c.scope, userId])).rows[0] : null;
        if (input?.id && !previous) throw new PlatformError('contact_not_found', 404);
        const value = normalizeContact(input, c, previous);
        const duplicate = await tx.query('SELECT id FROM platform_contacts WHERE scope=$1 AND user_id=$2 AND alias=$3', [c.scope, userId, value.alias]);
        if (duplicate.rows.some(row => row.id !== previous?.id)) throw new PlatformError('contact_alias_exists', 409);
        const id = previous?.id || randomUUID();
        if (previous) await tx.query('UPDATE platform_contacts SET name=$4,alias=$5,address=$6,bank_accounts=$7 WHERE id=$1 AND scope=$2 AND user_id=$3',
          [id, c.scope, userId, value.name, value.alias, value.address, JSON.stringify(value.bankAccounts)]);
        else await tx.query('INSERT INTO platform_contacts(id,scope,user_id,name,alias,address,bank_accounts) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [id, c.scope, userId, value.name, value.alias, value.address, JSON.stringify(value.bankAccounts)]);
        return { saved: true, id };
      });
    },
    async deleteContact(userId, id) {
      await db.query('DELETE FROM platform_contacts WHERE id=$1 AND scope=$2 AND user_id=$3', [id, c.scope, userId]);
      return { removed: true };
    },
    async accept(userId, body) {
      const docs = legalDocuments(c.country.code);
      if (!Array.isArray(body.documents) || body.documents.length !== docs.length ||
        !docs.every(doc => body.documents.some(d => d.id === doc.id && d.version === doc.version && d.hash === doc.hash)))
        throw new PlatformError('legal_documents_changed', 409);
      await atomic(db, c.scope, async tx => {
        for (const doc of docs) await tx.query(`INSERT INTO platform_acceptances(scope,user_id,country,document_id,version,document_hash)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [c.scope, userId, c.country.code, doc.id, doc.version, doc.hash]);
      });
      return { accepted: true };
    },
    async settings(userId, input) {
      if (typeof input.businessName !== 'string' || input.businessName.trim().length > 100 || /[\u0000-\u001f]/.test(input.businessName))
        throw new PlatformError('invalid_business_name', 400);
      const policy = conversionPolicy(input.policy);
      return atomic(db, c.scope, async tx => {
        await merchant(tx, c.scope, userId);
        await tx.query('UPDATE platform_merchants SET business_name=$3,policy=$4,updated_at=now() WHERE scope=$1 AND user_id=$2',
          [c.scope, userId, input.businessName.trim(), JSON.stringify(policy)]);
        return { businessName: input.businessName.trim(), policy };
      });
    },
    async quote(userId, input) {
      const direction = input.direction;
      if (!['buy', 'sell'].includes(direction)) throw new PlatformError('invalid_direction', 400);
      const raw = direction === 'buy' ? fiatAmount(input.amount, 1n) : String(units(input.amount, 6));
      if (BigInt(raw) <= 0n) throw new PlatformError('invalid_amount', 400);
      const quote = await deps.quote(), calculation = conversionQuote(raw, quote[direction], direction);
      if (BigInt(calculation.usdcRaw) < 10000n || BigInt(calculation.fiatMinor) <= 0n || BigInt(calculation.fiatMinor) > 100000000n)
        throw new PlatformError('amount_out_of_range', 400);
      const id = randomUUID(), expiresAt = new Date(deps.now().getTime() + 300000);
      await db.query('INSERT INTO platform_quotes(id,scope,user_id,direction,input_amount,quote,calculation,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, c.scope, userId, direction, input.amount, JSON.stringify(quote), JSON.stringify(calculation), expiresAt]);
      return { id, direction, amount: input.amount, quote, fiatAmount: decimal(calculation.fiatMinor), feeFiat: decimal(calculation.feeMinor), usdcAmount: decimal(calculation.usdcRaw, 6), expiresAt };
    },
    async createCollection(userId, input, key) {
      const normalized = { amount: decimal(fiatAmount(input.amount)), wallet: input.wallet };
      const previous = await replay(userId, key, { kind: 'collection', ...normalized });
      if (previous) return previous;
      assertService(c, 'qrCollection'); await ownWallet(userId, input.wallet);
      const profile = await merchant(db, c.scope, userId);
      const requiresFx = units(profile.policy.value) > 0n;
      const quote = requiresFx ? await deps.quote() : null;
      return newIntent(userId, 'collection', key, normalized, async (tx, base) => {
        const m = await merchant(tx, c.scope, userId);
        const amount = units(normalized.amount), split = splitQuote(amount, m.policy, quote?.buy);
        if (BigInt(split.usdcRaw) > 0n) assertService(c, 'onRamp');
        const treasury = await reserveTreasury(tx, c, split.usdcRaw, deps);
        const id = randomUUID();
        return insertOperation(tx, c, { ...base, id, provider: c.services.qrCollection.provider, fiat_minor: String(amount), fee_minor: split.feeMinor,
          usdc_raw: split.usdcRaw, retained_minor: split.retainedMinor, reserve_raw: split.usdcRaw,
          wallet_address: normalized.wallet, treasury_address: treasury, quote, policy: m.policy,
          metadata: { convertedMinor: split.convertedMinor, splitSkipped: split.skipped, rampProvider: BigInt(split.usdcRaw) > 0n ? c.services.onRamp.provider : null },
          provider_body: { amount: Number(normalized.amount), title: m.business_name || 'Cobro MidatoPay', external_id: id, expires_in: 15 },
          expires_at: new Date(deps.now().getTime() + 900000) });
      });
    },
    async createBuy(userId, input, key) {
      const normalized = { quoteId: input.quoteId, wallet: input.wallet };
      const previous = await replay(userId, key, { kind: 'buy', ...normalized }); if (previous) return previous;
      assertService(c, 'onRamp'); await ownWallet(userId, input.wallet);
      return newIntent(userId, 'buy', key, normalized, async (tx, base) => {
        const saved = await getSavedQuote(tx, userId, input.quoteId, 'buy'), q = saved.calculation;
        const treasury = await reserveTreasury(tx, c, q.usdcRaw, deps);
        const op = await insertOperation(tx, c, { ...base, provider: c.services.onRamp.provider, status: 'pending', fiat_minor: q.fiatMinor, fee_minor: q.feeMinor,
          usdc_raw: q.usdcRaw, reserve_raw: q.usdcRaw, reserve_minor: q.fiatMinor, wallet_address: input.wallet,
          treasury_address: treasury, quote: saved.quote });
        await reserveCop(tx, c.scope, op, q.fiatMinor); return op;
      });
    },
    async createSell(userId, input, key) {
      const normalized = { quoteId: input.quoteId, wallet: input.wallet };
      const previous = await replay(userId, key, { kind: 'sell', ...normalized }); if (previous) return previous;
      assertService(c, 'offRamp'); await ownWallet(userId, input.wallet);
      return newIntent(userId, 'sell', key, normalized, async (tx, base) => {
        const saved = await getSavedQuote(tx, userId, input.quoteId, 'sell'), q = saved.calculation;
        const rampId = c.services.offRamp.provider;
        const treasury = await deps.rampFor(rampId).sellDestination(deps);
        if (!isAddress(treasury || '') || treasury === input.wallet) throw new PlatformError('invalid_treasury');
        if (await deps.sourceBalance(input.wallet) < BigInt(q.usdcRaw)) throw new PlatformError('insufficient_usdc');
        const fiatProvider = c.services.offRamp.fiatProvider || c.services.bankWithdrawal?.provider || c.services.brebWithdrawal?.provider;
        await reserveFiatLiquidity(tx, c, q.fiatMinor, deps, deps.providerFor(fiatProvider));
        const id = randomUUID(), memo = `MIDATO|v1|inv:${id}|kind:sell|cur:${c.country.currency}|usdc:${decimal(q.usdcRaw, 6)}`;
        const prepared = await deps.prepareTransfer({ from: input.wallet, to: treasury, raw: q.usdcRaw, memo });
        return insertOperation(tx, c, { ...base, id, provider: rampId, status: 'awaiting_signature', fiat_minor: q.fiatMinor, fee_minor: q.feeMinor,
          usdc_raw: q.usdcRaw, reserve_minor: q.fiatMinor, wallet_address: input.wallet, treasury_address: treasury,
          quote: saved.quote, expires_at: saved.expires_at, ...prepared, metadata: { to: treasury, memo, fiatProvider } });
      });
    },
    async createTransfer(userId, input, key) {
      const normalized = { wallet: input.wallet, to: input.to, amount: decimal(units(input.amount, 6), 6) };
      const previous = await replay(userId, key, { kind: 'transfer', ...normalized }); if (previous) return previous;
      assertService(c, 'cryptoTransfer'); await ownWallet(userId, input.wallet);
      if (!isAddress(input.to || '') || input.to === input.wallet || units(input.amount, 6) <= 0n) throw new PlatformError('invalid_destination', 400);
      return newIntent(userId, 'transfer', key, normalized, async (tx, base) => {
        const raw = String(units(input.amount, 6)), id = randomUUID();
        if (await deps.sourceBalance(input.wallet) < BigInt(raw)) throw new PlatformError('insufficient_usdc');
        const memo = `MIDATO|v1|inv:${id}|kind:transfer|usdc:${normalized.amount}`;
        const prepared = await deps.prepareTransfer({ from: input.wallet, to: input.to, raw, memo });
        return insertOperation(tx, c, { ...base, id, status: 'awaiting_signature', provider: 'solana', usdc_raw: raw,
          wallet_address: input.wallet, ...prepared, expires_at: new Date(deps.now().getTime() + 300000), metadata: { to: input.to, memo } });
      });
    },
    async submit(userId, id, wire) {
      return atomic(db, c.scope, async tx => {
        const op = await operation(tx, c.scope, userId, id);
        if (op.signature) return op;
        assertService(c, op.kind === 'sell' ? 'offRamp' : 'cryptoTransfer');
        await requireAcceptance(tx, c, userId); await ownWallet(userId, op.wallet_address);
        if (!['sell', 'transfer'].includes(op.kind) || op.status !== 'awaiting_signature' || new Date(op.expires_at) <= deps.now()) throw new PlatformError('operation_not_signable');
        if (BigInt(await deps.rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > BigInt(op.last_valid_block_height)) throw new PlatformError('transfer_blockhash_expired');
        const prepared = { ...op, from_address: op.wallet_address }, signedByUser = await deps.validateUserSignature(prepared, wire);
        const pending = await tx.query(`SELECT COALESCE(SUM(usdc_raw),0)::text AS raw FROM platform_operations
          WHERE scope=$1 AND user_id=$2 AND kind IN ('sell','transfer') AND signature IS NOT NULL AND status IN ('broadcasting','confirmed','manual_review')`, [c.scope, userId]);
        if (await deps.sourceBalance(op.wallet_address) - BigInt(pending.rows[0].raw) < BigInt(op.usdc_raw)) throw new PlatformError('insufficient_usdc');
        const day = sponsorDay(deps.now(), c.country.timeZone);
        const usage = (await tx.query(`SELECT COUNT(*)::int AS count FROM platform_operations WHERE scope=$1 AND user_id=$2 AND sponsor_day=$3 AND signature IS NOT NULL AND kind IN ('sell','transfer')`, [c.scope, userId, day])).rows[0];
        if (Number(usage.count) >= 2) throw new PlatformError('transfer_daily_limit', 429);
        const total = (await tx.query(`SELECT COALESCE(SUM(cost_lamports),0)::text AS raw FROM platform_operations WHERE scope=$1 AND sponsor_day=$2 AND signature IS NOT NULL`, [c.scope, day])).rows[0];
        if (BigInt(op.cost_lamports) > units(env.TRANSFER_MAX_SOL_COST || '0.003', 9) || BigInt(total.raw) + BigInt(op.cost_lamports) > units(env.TRANSFER_DAILY_SOL_BUDGET || '0.05', 9))
          throw new PlatformError('transfer_budget_exhausted', 429);
        const costs = (await tx.query(`SELECT COALESCE(SUM(cost_lamports),0)::text AS raw FROM platform_operations
          WHERE scope=$1 AND fee_payer=$2 AND signature IS NOT NULL AND status IN ('broadcasting','confirmed','manual_review')`, [c.scope, op.fee_payer])).rows[0];
        const sol = await deps.rpc('getBalance', [op.fee_payer, { commitment: 'finalized' }]);
        if (BigInt(sol.value) - BigInt(costs.raw) < BigInt(op.cost_lamports)) throw new PlatformError('treasury_sol_unavailable');
        if (op.kind === 'sell') await reserveFiatLiquidity(tx, c, '0', deps, op.metadata.fiatProvider ? deps.providerFor(op.metadata.fiatProvider) : deps.provider);
        const simulation = await deps.rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
        if (simulation.value?.err) throw new PlatformError('transfer_simulation_failed');
        const signed = await deps.signSponsoredTransfer(prepared, signedByUser);
        // Complete wire is committed before any RPC can see its treasury signature.
        return updateOperation(tx, id, { ...signed, sponsor_day: day, status: 'broadcasting', next_attempt_at: deps.now() });
      });
    },
    async createWithdrawal(userId, input, key) {
      const normalized = { amount: decimal(fiatAmount(input.amount)), destinationId: input.destinationId };
      const previous = await replay(userId, key, { kind: 'withdrawal', ...normalized }); if (previous) return previous;
      return newIntent(userId, 'withdrawal', key, normalized, async (tx, base) => {
        const { rows: [dest] } = await tx.query('SELECT * FROM platform_destinations WHERE scope=$1 AND user_id=$2 AND id=$3', [c.scope, userId, input.destinationId]);
        if (!dest || dest.status !== 'ready') throw new PlatformError('destination_not_ready');
        const { providerId } = withdrawalService(c, dest.kind);
        if (dest.provider !== providerId) throw new PlatformError('destination_provider_changed');
        await reserveFiatLiquidity(tx, c, '0', deps, deps.providerFor(providerId));
        const id = randomUUID(), raw = fiatAmount(input.amount);
        const op = await insertOperation(tx, c, { ...base, id, provider: providerId, fiat_minor: raw, reserve_minor: raw, destination_id: dest.id,
          metadata: { destinationLabel: dest.label },
          provider_body: { amount: Number(normalized.amount), currency: c.country.currency, account_id: dest.provider_account_id,
            customer_id: dest.provider_customer_id, description: 'Retiro MidatoPay sandbox', reference: id, external_id: id, method: dest.kind === 'breb' ? 'BREB' : 'ACH' } });
        await reserveCop(tx, c.scope, op, raw); return op;
      });
    },
    async cancel(userId, id) {
      return atomic(db, c.scope, async tx => {
        const op = await operation(tx, c.scope, userId, id);
        if (TERMINAL_STATUSES.has(op.status)) return op;
        if (op.signature || op.paid_at || ['buy','withdrawal'].includes(op.kind)) throw new PlatformError('operation_not_cancelable');
        if (op.kind === 'collection') return updateOperation(tx, id, { status: 'cancel_pending', next_attempt_at: deps.now() });
        await releaseCop(tx, c.scope, op);
        return updateOperation(tx, id, { status: 'canceled' });
      });
    },
    async closeAttempt(userId, key, id = null) {
      idempotency(key);
      return atomic(db, c.scope, async tx => {
        const row = id
          ? (await tx.query('SELECT * FROM platform_operations WHERE scope=$1 AND user_id=$2 AND id=$3', [c.scope, userId, id])).rows[0]
          : (await tx.query('SELECT * FROM platform_operations WHERE scope=$1 AND user_id=$2 AND idempotency_key=$3', [c.scope, userId, key])).rows[0];
        if (row) {
          let fresh = row;
          if (!row.signature && row.status === 'awaiting_signature') {
            await releaseCop(tx, c.scope, row);
            fresh = await updateOperation(tx, row.id, { status: 'canceled' });
          } else if (row.kind === 'collection' && ['creating','awaiting_payment'].includes(row.status)) {
            fresh = await updateOperation(tx, row.id, { status: 'cancel_pending' });
          }
          return { closed: true, operation: publicOperation(fresh) };
        }
        // Serializes with creation: even a request still in flight cannot later
        // create a payment after the user has safely abandoned its key.
        await tx.query('INSERT INTO platform_closed_attempts(scope,user_id,idempotency_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [c.scope, userId, key]);
        return { closed: true };
      });
    },
    async list(userId, before = null) {
      let cursor = null;
      if (before) {
        try { cursor = JSON.parse(Buffer.from(before, 'base64url').toString()); } catch { throw new PlatformError('invalid_cursor', 400); }
        if (!Number.isFinite(Date.parse(cursor?.date)) || !/^[0-9a-f-]{36}$/i.test(cursor?.id || '')) throw new PlatformError('invalid_cursor', 400);
      }
      const { rows } = await db.query(`SELECT * FROM platform_operations WHERE scope=$1 AND user_id=$2 AND parent_id IS NULL
        AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`, [c.scope, userId, cursor?.date || null, cursor?.id || null]);
      const roots = rows.slice(0, 50), childRows = roots.length ? (await db.query('SELECT * FROM platform_operations WHERE scope=$1 AND user_id=$2 AND parent_id=ANY($3::uuid[]) ORDER BY created_at', [c.scope, userId, roots.map(row => row.id)])).rows : [];
      return { operations: roots.map(row => publicOperation(row, childRows.filter(child => child.parent_id === row.id))),
        nextCursor: rows.length > 50 ? Buffer.from(JSON.stringify({ date: roots.at(-1).created_at, id: roots.at(-1).id })).toString('base64url') : null };
    },
    async get(userId, id) {
      const op = await operation(db, c.scope, userId, id);
      const children = (await db.query('SELECT * FROM platform_operations WHERE scope=$1 AND user_id=$2 AND parent_id=$3 ORDER BY created_at', [c.scope, userId, id])).rows;
      return publicOperation(op, children);
    },
  };
  return api;
}
