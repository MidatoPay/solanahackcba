import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { platformConfig } from '../netlify/functions/lib/platform/config.js';
import { legalDocuments } from '../netlify/functions/lib/platform/legal.js';
import { createPlatformService, insertOperation } from '../netlify/functions/lib/platform/service.js';
import { balances, journal, copLine, hashInput } from '../netlify/functions/lib/platform/store.js';
import { processOperation, verifyChainTransfer, runPlatformWorker } from '../netlify/functions/lib/platform/worker.js';
import { PROVIDER_FACTORIES } from '../netlify/functions/lib/platform/providers.js';
import { RAMP_FACTORIES } from '../netlify/functions/lib/platform/ramps.js';
import { createOnepayWebhook } from '../netlify/functions/onepay-webhook.js';
import { createHmac } from 'node:crypto';
import { reconcilePlatformWallet, incomingAmount } from '../netlify/functions/lib/platform/receipts.js';
import { tokenAddress } from '../netlify/functions/lib/transferChain.js';
import { registerCustomer, registerDestination } from '../netlify/functions/lib/platform/destinations.js';

test('country ledger: immutable batches, split, conversions, withdrawals and durable retries', async t => {
  const engine = new PGlite(); await engine.waitReady; t.after(() => engine.close());
  const migration = await readFile(new URL('../db/migrations/20261018_country_platform.sql', import.meta.url), 'utf8');
  await engine.exec(migration); await engine.exec(migration);
  const query = async (sql, params = []) => engine.query(sql, params);
  let tail = Promise.resolve();
  const pool = { query, connect: async () => {
    let unlock;
    return { query: async (sql, params = []) => {
      if (sql === 'BEGIN') { const before = tail; tail = new Promise(resolve => { unlock = resolve; }); await before; }
      try { return await query(sql, params); } finally { if (['COMMIT', 'ROLLBACK'].includes(sql)) { unlock?.(); unlock = null; } }
    }, release: () => { unlock?.(); } };
  } };
  const env = { PLATFORM_ENABLED: 'true' }, c = platformConfig(env);
  const wallet = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const treasury = '11111111111111111111111111111111';
  const charges = new Map(), cashouts = new Map(), signatureStatuses = new Map();
  let created = 0, broadcasts = 0, cashoutPosts = 0, now = new Date('2026-10-18T08:00:00Z'), bankLastBody;
  const provider = {
    getBalance: async () => 1000000000n,
    createCharge: async body => { created++; const value = { ...body, id: `provider-${body.external_id}`, is_test: true, currency: 'COP', status: 'pending', qr: { string: 'qr-data' } }; charges.set(value.id, charges.get(value.id) || value); return charges.get(value.id); },
    getCharge: async id => charges.get(id), cancelCharge: async id => { charges.get(id).status = 'failed'; charges.get(id).remarks = ['CANCELLED_BY_MERCHANT']; },
    createCashout: async body => { cashoutPosts++; const value = { ...body, id: `cashout-${body.external_id}`, is_test: true, status: 'processing' }; cashouts.set(value.id, cashouts.get(value.id) || value); return cashouts.get(value.id); },
    getCashout: async id => cashouts.get(id), createCustomer: async body => ({ id: 'customer-1', ...body }),
    createBankAccount: async body => { bankLastBody = body; return { id: `account-${body.external_id}`, customer_id: body.customer_id, is_test: true }; },
    getBrebKey: async () => ({ status: 'ACTIVE', document_type: 'CC', document_number: '123456789', bank: { name: 'Test bank' } }),
  };
  const service = createPlatformService({ db: pool, env, config: c, provider, now: () => now,
    primary: async () => wallet, treasury: async () => treasury,
    liquidity: async () => ({ owner: treasury, raw: '1000000000', solLamports: '100000000' }),
    quote: async () => ({ buy: '4000', sell: '4000', source: 'offline-fixture', updatedAt: now.toISOString() }),
    sourceBalance: async () => 1000000000n,
    prepareTransfer: async () => ({ unsigned_wire: 'unsigned', last_valid_block_height: '100', fee_payer: treasury, cost_lamports: '1000000' }),
    validateUserSignature: async (_op, wire) => { if (wire !== 'user-signed') throw new Error('bad-signature'); return {}; },
    signSponsoredTransfer: async op => ({ signature: `signature-${op.id}`, signed_wire: 'complete-signed-wire' }),
    preparePayout: async op => ({ hash: `signature-${op.factura}`, wire: 'payout-wire', lastValidBlockHeight: '100' }),
    verifyChain: async () => {}, rpc: async (method, params) => {
      if (method === 'getGenesisHash') return c.network.genesis;
      if (method === 'getBlockHeight') return 10;
      if (method === 'getBalance') return { value: '100000000' };
      if (method === 'getSignatureStatuses') return { value: [signatureStatuses.get(params[0][0]) || null] };
      if (method === 'sendTransaction') { broadcasts++; assert.ok(['complete-signed-wire','payout-wire'].includes(params[0])); return 'ok'; }
      if (method === 'simulateTransaction') return { value: { err: null } };
      if (method === 'getTransaction') return { meta: { err: null } };
      throw new Error(`Unexpected RPC: ${method}`);
    },
  });
  let charge, child, destination;
  const accept = user => service.accept(user, { documents: legalDocuments().map(({ id, version, hash }) => ({ id, version, hash })) });
  await t.test('agenda accepts bank-only, wallet-only and combined contacts without creating payout destinations', async () => {
    const account = { country: 'CO', currency: 'COP', bankName: 'Banco de prueba', holderName: 'Ana Prueba', accountType: 'SAVINGS', accountNumber: '001234567890' };
    const bank = await service.saveContact('agenda-user', { name: 'Ana', alias: 'ana', bankAccounts: [account] });
    const crypto = await service.saveContact('agenda-user', { name: 'Luis', alias: 'luis', address: wallet });
    let model = await service.me('agenda-user');
    assert.equal(model.contacts.length, 2); assert.equal(model.destinations.length, 0);
    assert.equal(model.contacts.find(c => c.id === bank.id).address, null);
    assert.equal(model.contacts.find(c => c.id === bank.id).bankAccounts[0].accountNumber, '001234567890');
    assert.deepEqual(model.contacts.find(c => c.id === crypto.id).bankAccounts, []);
    await service.saveContact('agenda-user', { id: bank.id, name: 'Ana editada', alias: 'ana-nueva', address: wallet, bankAccounts: [account, { ...account, accountNumber: '009876543210', accountType: 'CHECKING' }] });
    model = await service.me('agenda-user');
    assert.equal(model.contacts.find(c => c.id === bank.id).bankAccounts.length, 2);
    await assert.rejects(() => service.saveContact('agenda-user', { name: 'Otra', alias: 'ANA-NUEVA', address: wallet }), /contact_alias_exists/);
    await assert.rejects(() => service.saveContact('agenda-user', { name: 'Vacío', alias: 'vacio' }), /contact_destination_required/);
    await assert.rejects(() => service.saveContact('agenda-user', { name: 'Banco', alias: 'banco', bankAccounts: [{ ...account, currency: 'ARS' }] }), /invalid_bank_contact/);
    await assert.rejects(() => service.saveContact('agenda-user', { name: 'Banco', alias: 'banco', bankAccounts: [account, account] }), /duplicate_bank_contact/);
    await assert.rejects(() => service.saveContact('agenda-user', { name: 'Banco', alias: 'banco', bankAccounts: Array(6).fill(account) }), /invalid_bank_contact/);
    await assert.rejects(() => service.saveContact('another-user', { id: bank.id, name: 'Ajeno', alias: 'ajeno', address: wallet }), /contact_not_found/);
    await service.deleteContact('another-user', bank.id);
    assert.equal((await service.me('another-user')).contacts.length, 0);
    assert.equal((await service.me('agenda-user')).contacts.length, 2);
    const noBankConfig = { ...c, services: { ...c.services, bankWithdrawal: { ...c.services.bankWithdrawal, enabled: false } } };
    const noBank = createPlatformService({ ...service.deps, db: pool, env, config: noBankConfig });
    await assert.rejects(() => noBank.saveContact('agenda-user', { name: 'Banco oculto', alias: 'oculto', bankAccounts: [account] }), /bank_contacts_unavailable/);
    const hidden = (await noBank.me('agenda-user')).contacts.find(c => c.id === bank.id);
    assert.equal(hidden.bankAccounts, undefined);
    await noBank.saveContact('agenda-user', { id: bank.id, name: 'Ana', alias: 'ana', address: wallet });
    assert.equal((await service.me('agenda-user')).contacts.find(c => c.id === bank.id).bankAccounts.length, 2);
    await service.deleteContact('agenda-user', bank.id);
    assert.equal((await service.me('agenda-user')).contacts.length, 1);
  });
  await t.test('new money requires the current legal bundle; another user cannot read an operation', async () => {
    await assert.rejects(() => service.createCollection('user', { amount: '100000', wallet }, randomUUID()), /acceptance_required/);
    await accept('user'); await service.settings('user', { businessName: 'Comercio', policy: { mode: 'percentage', value: '30' } });
    charge = await service.createCollection('user', { amount: '100000', wallet }, randomUUID());
    assert.equal(String(charge.retained_minor), '7000000'); assert.equal(String(charge.fee_minor), '15000');
    await assert.rejects(() => service.get('another-user', charge.id), /not_found/);
  });
  await t.test('creation retry keeps saved policy and input; quote/policy changes do not duplicate a charge', async () => {
    await service.settings('user', { businessName: 'Nuevo nombre', policy: { mode: 'percentage', value: '100' } });
    const retried = await service.createCollection('user', { amount: '100000.00', wallet }, charge.idempotency_key);
    assert.equal(retried.id, charge.id); assert.equal(retried.policy.value, '30.00');
    await assert.rejects(() => service.createCollection('user', { amount: '200000', wallet }, charge.idempotency_key), /idempotency_conflict/);
    await processOperation(service, charge.id); assert.equal(created, 1);
    charge = (await query('SELECT * FROM platform_operations WHERE id=$1', [charge.id])).rows[0];
    assert.equal(charge.status, 'awaiting_payment');
  });
  await t.test('paid event creates exactly one retained credit and one reserved conversion', async () => {
    charges.get(charge.provider_id).status = 'paid';
    await processOperation(service, charge.id); await processOperation(service, charge.id);
    assert.deepEqual(await balances(pool, c.scope, 'user'), { currency: 'COP', available: '70000.00', reserved: '30000.00' });
    const children = (await query('SELECT * FROM platform_operations WHERE parent_id=$1', [charge.id])).rows;
    assert.equal(children.length, 1); child = children[0];
  });
  await t.test('USDC payout is stored before broadcast and credits only finalized proof', async () => {
    await processOperation(service, child.id);
    child = (await query('SELECT * FROM platform_operations WHERE id=$1', [child.id])).rows[0];
    assert.ok(child.signed_wire); assert.equal(broadcasts, 1);
    signatureStatuses.set(child.signature, { confirmationStatus: 'confirmed', err: null }); await processOperation(service, child.id);
    assert.equal((await service.get('user', child.id)).status, 'confirmed');
    assert.equal((await balances(pool, c.scope, 'user')).reserved, '30000.00');
    signatureStatuses.set(child.signature, { confirmationStatus: 'finalized', err: null });
    await processOperation(service, child.id); await processOperation(service, child.id);
    assert.equal((await balances(pool, c.scope, 'user')).reserved, '0.00');
    assert.equal((await service.get('user', charge.id)).status, 'completed');
  });
  await t.test('database rejects unbalanced accounting and immutable journal mutations', async () => {
    await assert.rejects(() => journal(pool, c.scope, charge.id, 'bad', [copLine('a', 1), copLine('b', 1)]), /unbalanced/);
    await assert.rejects(() => query('INSERT INTO platform_journals(id,scope,event_key,operation_id,entries) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), c.scope, 'bad-db', charge.id, JSON.stringify([copLine('a', 1), copLine('b', 1)])]), /check constraint/);
    await assert.rejects(() => query('DELETE FROM platform_journals WHERE scope=$1', [c.scope]), /immutable/);
  });
  await t.test('register bank/Bre-B destinations with stable identifiers and verified key ownership', async () => {
    await registerCustomer(service, 'user', { firstName: 'Prueba', lastName: 'Sandbox', email: 'test@example.test', phone: '+573001234567', documentType: 'CC', documentNumber: '123456789', birthdate: '1990-01-01' });
    destination = await registerDestination(service, 'user', { kind: 'bank', bankId: 'test-bank', subtype: 'SAVINGS', accountNumber: '12345678' }, randomUUID());
    const breb = await registerDestination(service, 'user', { kind: 'breb', key: '@sandbox' }, randomUUID());
    assert.equal(breb.kind, 'breb'); assert.equal(bankLastBody.subtype, 'KEY');
  });
  await t.test('migration preserves a legacy provider identity and the original retry body/key', async () => {
    await service.me('legacy-beneficiary');
    const saved = (await query('SELECT * FROM platform_provider_customers WHERE scope=$1 AND user_id=$2', [c.scope, 'user'])).rows[0];
    await query(`UPDATE platform_merchants SET customer_id=$3,customer_key=$4,customer_body=$5,customer_input_hash=$6 WHERE scope=$1 AND user_id=$2`,
      [c.scope, 'legacy-beneficiary', saved.customer_id, saved.customer_key, JSON.stringify(saved.customer_body), saved.customer_input_hash]);
    await engine.exec(migration); await engine.exec(migration);
    const migrated = (await query('SELECT * FROM platform_provider_customers WHERE scope=$1 AND user_id=$2', [c.scope, 'legacy-beneficiary'])).rows;
    assert.equal(migrated.length, 1); assert.equal(migrated[0].provider, 'onepay');
    for (const key of ['customer_id', 'customer_key', 'customer_input_hash']) assert.equal(migrated[0][key], saved[key]);
    assert.deepEqual(migrated[0].customer_body, saved.customer_body);
  });
  await t.test('withdrawal reserves only its owner funds, handles pending and releases a failed payout once', async () => {
    const key = randomUUID(), w = await service.createWithdrawal('user', { amount: '10000', destinationId: destination.id }, key);
    assert.equal((await service.get('user', w.id)).destinationLabel, destination.label);
    assert.equal((await balances(pool, c.scope, 'user')).available, '60000.00');
    assert.equal((await service.createWithdrawal('user', { amount: '10000.00', destinationId: destination.id }, key)).id, w.id);
    await processOperation(service, w.id); assert.equal(cashoutPosts, 1);
    const fresh = (await query('SELECT * FROM platform_operations WHERE id=$1', [w.id])).rows[0];
    cashouts.get(fresh.provider_id).status = 'failed'; await processOperation(service, w.id); await processOperation(service, w.id);
    assert.equal((await balances(pool, c.scope, 'user')).available, '70000.00');
    await accept('other'); await assert.rejects(() => service.createWithdrawal('other', { amount: '1000', destinationId: destination.id }, randomUUID()), /destination_not_ready/);
  });
  await t.test('selling credits COP only after finality; rejected withdrawal does not undo a completed sale', async () => {
    const q = await service.quote('user', { direction: 'sell', amount: '1' });
    const sell = await service.createSell('user', { quoteId: q.id, wallet }, randomUUID());
    await assert.rejects(() => service.submit('user', sell.id, 'invalid'), /bad-signature/);
    const signed = await service.submit('user', sell.id, 'user-signed');
    assert.equal((await service.submit('user', sell.id, 'user-signed')).signature, signed.signature);
    assert.equal((await balances(pool, c.scope, 'user')).available, '70000.00');
    signatureStatuses.set(signed.signature, { confirmationStatus: 'finalized', err: null });
    await processOperation(service, sell.id); await processOperation(service, sell.id);
    assert.equal((await balances(pool, c.scope, 'user')).available, '73980.00');
  });
  await t.test('unsigned expired sales release liquidity without creating COP, and old rules remain labeled', async () => {
    const q = await service.quote('user', { direction: 'sell', amount: '1' });
    const sell = await service.createSell('user', { quoteId: q.id, wallet }, randomUUID());
    now = new Date(now.getTime() + 301000); await processOperation(service, sell.id);
    assert.equal((await service.get('user', sell.id)).status, 'expired');
    assert.equal((await balances(pool, c.scope, 'user')).available, '73980.00');
    const otherScope = createPlatformService({ ...service.deps, db: pool, env: { PLATFORM_DEPLOYMENT_ID: 'other' }, config: platformConfig({ PLATFORM_DEPLOYMENT_ID: 'other' }) });
    assert.equal((await otherScope.list('user')).operations.length, 0);
    assert.equal((await service.get('user', charge.id)).currency, 'COP');
  });
  await t.test('closed intents cannot be created later; concurrent close/create is serialized', async () => {
    const key = randomUUID();
    await service.closeAttempt('user', key);
    await assert.rejects(() => service.createCollection('user', { amount: '1000', wallet }, key), /attempt_closed/);
    const otherKey = randomUUID();
    const [created, closed] = await Promise.allSettled([
      service.createCollection('user', { amount: '1000', wallet }, otherKey), service.closeAttempt('user', otherKey),
    ]);
    assert.equal(closed.status, 'fulfilled');
    if (created.status === 'fulfilled') {
      assert.equal(closed.value.operation.id, created.value.id);
      const before = charges.size;
      await processOperation(service, created.value.id);
      assert.equal(charges.size, before);
      assert.equal((await service.get('user', created.value.id)).status, 'canceled');
    } else assert.match(created.reason.message, /attempt_closed/);
  });
  await t.test('cancel arriving during provider creation survives the response and releases treasury reservation', async () => {
    const pending = await service.createCollection('user', { amount: '1000', wallet }, randomUUID());
    const original = provider.createCharge;
    try {
      provider.createCharge = async body => {
        const response = await original(body);
        await service.cancel('user', pending.id);
        return response;
      };
      await processOperation(service, pending.id);
      const fresh = (await query('SELECT * FROM platform_operations WHERE id=$1', [pending.id])).rows[0];
      assert.equal(fresh.status, 'canceled'); assert.equal(String(fresh.reserve_raw), '0');
    } finally { provider.createCharge = original; }
  });
  await t.test('provider timeout after creation retries the same identifier and accounts for payment once', async () => {
    const pending = await service.createCollection('user', { amount: '1000', wallet }, randomUUID());
    const original = provider.createCharge, before = charges.size;
    let interrupted = false;
    try {
      provider.createCharge = async (body, key) => {
        assert.equal(key, pending.idempotency_key);
        const response = await original(body);
        if (!interrupted) { interrupted = true; throw new Error('response lost'); }
        return response;
      };
      await processOperation(service, pending.id);
      assert.equal((await service.get('user', pending.id)).status, 'creating');
      await processOperation(service, pending.id);
      assert.equal(charges.size, before + 1);
      const fresh = (await query('SELECT * FROM platform_operations WHERE id=$1', [pending.id])).rows[0];
      charges.get(fresh.provider_id).status = 'paid';
      await processOperation(service, pending.id); await processOperation(service, pending.id);
      assert.equal((await query('SELECT id FROM platform_journals WHERE event_key=$1', [`collection:${pending.id}`])).rows.length, 1);
      assert.equal((await query('SELECT id FROM platform_operations WHERE parent_id=$1', [pending.id])).rows.length, 1);
    } finally { provider.createCharge = original; }
  });
  await t.test('concurrent withdrawals cannot reserve the same COP twice', async () => {
    const before = await balances(pool, c.scope, 'user');
    const results = await Promise.allSettled([1, 2].map(() => service.createWithdrawal('user', { amount: '50000', destinationId: destination.id }, randomUUID())));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /insufficient_cop/);
    const w = results.find(result => result.status === 'fulfilled').value;
    await processOperation(service, w.id);
    const fresh = (await query('SELECT * FROM platform_operations WHERE id=$1', [w.id])).rows[0];
    cashouts.get(fresh.provider_id).status = 'failed'; await processOperation(service, w.id);
    assert.deepEqual(await balances(pool, c.scope, 'user'), before);
    assert.equal((await service.quote('user', { direction: 'sell', amount: '0.01' })).fiatAmount, '39.80');
  });
  await t.test('a paused worker observes a signed transfer without broadcasting new bytes', async () => {
    const transfer = await service.createTransfer('user', { wallet, to: treasury, amount: '1' }, randomUUID());
    const signed = await service.submit('user', transfer.id, 'user-signed');
    const paused = createPlatformService({ ...service.deps, db: pool, config: platformConfig({ PLATFORM_ENABLED: 'false' }) });
    const before = broadcasts; await processOperation(paused, transfer.id); assert.equal(broadcasts, before);
    signatureStatuses.set(signed.signature, { confirmationStatus: 'finalized', err: null });
    await processOperation(paused, transfer.id);
    assert.equal((await service.get('user', transfer.id)).status, 'completed');
    assert.equal(broadcasts, before);
  });
  await t.test('chain proof checks exact token accounts, owner, mint, amount and decimals', async () => {
    const source = await tokenAddress(wallet, c.network), target = await tokenAddress(treasury, c.network);
    const op = { kind: 'sell', wallet_address: wallet, metadata: { to: treasury }, usdc_raw: '1000000' };
    const info = { source, destination: target, authority: wallet, mint: c.network.mint, tokenAmount: { amount: '1000000', decimals: 6 } };
    const tx = detail => ({ meta: { err: null }, transaction: { message: { instructions: [{ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', parsed: { type: 'transferChecked', info: detail } }] } } });
    await verifyChainTransfer(op, tx(info), c.network);
    for (const change of [{ mint: wallet }, { authority: treasury }, { destination: source }, { tokenAmount: { amount: '2', decimals: 6 } }, { tokenAmount: { amount: '1000000', decimals: 9 } }])
      await assert.rejects(() => verifyChainTransfer(op, tx({ ...info, ...change }), c.network), /chain_proof_mismatch/);
  });
  await t.test('incoming USDC synchronization resumes pagination and records each finalized receipt once', async () => {
    const user = 'incoming-user', ata = await tokenAddress(wallet, c.network);
    await service.me(user);
    const signatures = Array.from({ length: 103 }, (_, index) => ({ signature: `incoming-${103 - index}`, blockTime: 1792310000, err: null }));
    const transaction = { meta: { err: null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 0, mint: c.network.mint, owner: wallet, uiTokenAmount: { amount: '1000000', decimals: 6 } }] }, transaction: { message: { accountKeys: [{ pubkey: ata }] } } };
    assert.equal(incomingAmount(transaction, ata, wallet, c.network.mint), 1000000n);
    assert.equal(incomingAmount(transaction, ata, wallet, treasury), 0n);
    const incoming = createPlatformService({ ...service.deps, db: pool, config: c, rpc: async (method, params) => {
      if (method === 'getGenesisHash') return c.network.genesis;
      if (method === 'getTransaction') return transaction;
      if (method === 'getSignaturesForAddress') {
        assert.equal(params[0], ata); assert.equal(params[1].commitment, 'finalized');
        const { before, until, limit } = params[1];
        const start = before ? signatures.findIndex(row => row.signature === before) + 1 : 0;
        const stop = until ? signatures.findIndex(row => row.signature === until) : signatures.length;
        return signatures.slice(start, stop < 0 ? signatures.length : stop).slice(0, limit);
      }
      throw new Error(`Unexpected RPC ${method}`);
    } });
    assert.equal((await reconcilePlatformWallet(incoming, user)).checked, 100);
    let cursor = (await query('SELECT * FROM platform_merchants WHERE scope=$1 AND user_id=$2', [c.scope, user])).rows[0];
    assert.equal(cursor.sync_signature, null); assert.equal(cursor.sync_before, 'incoming-4');
    signatures.unshift({ signature: 'incoming-104', blockTime: 1792310001, err: null });
    assert.equal((await reconcilePlatformWallet(incoming, user)).checked, 3);
    cursor = (await query('SELECT * FROM platform_merchants WHERE scope=$1 AND user_id=$2', [c.scope, user])).rows[0];
    assert.equal(cursor.sync_signature, 'incoming-103'); assert.equal(cursor.sync_before, null);
    assert.equal((await reconcilePlatformWallet(incoming, user)).checked, 1);
    assert.equal((await reconcilePlatformWallet(incoming, user)).checked, 0);
    assert.equal((await query("SELECT id FROM platform_operations WHERE scope=$1 AND user_id=$2 AND kind='receive'", [c.scope, user])).rows.length, 104);
    assert.equal((await query("SELECT id FROM platform_journals WHERE scope=$1 AND event_key LIKE $2", [c.scope, `incoming:${user}:%`])).rows.length, 104);
    assert.deepEqual(await balances(pool, c.scope, user), { currency: 'COP', available: '0.00', reserved: '0.00' });
  });
  await t.test('independent payout providers keep identities, retries, liquidity and saved destinations isolated', async () => {
    const input = { firstName: 'Prueba', lastName: 'Sandbox', email: 'test@example.test', phone: '+573001234567', documentType: 'CC', documentNumber: '123456789', birthdate: '1990-01-01' };
    const otherInput = { ...input, documentNumber: '987654321' };
    const keys = { a: [], b: [] }, sent = new Map(); let secondBalance = 0n, loseResponse = true;
    const a = { ...provider,
      createCustomer: async (body, key) => { keys.a.push(key); return { ...body, id: 'customer-first' }; },
      createBankAccount: async body => ({ id: 'bank-first', customer_id: body.customer_id, is_test: true }),
      createCashout: async () => { throw Error('Wrong payout provider'); },
    };
    const b = { ...provider, getBalance: async () => secondBalance,
      createCustomer: async (body, key) => {
        keys.b.push(key);
        if (loseResponse) { loseResponse = false; throw Error('Lost customer response'); }
        return { ...body, id: 'customer-second' };
      },
      getBrebKey: async () => ({ status: 'ACTIVE', document_type: 'CC', document_number: '987654321' }),
      createBankAccount: async body => { assert.equal(body.customer_id, 'customer-second'); return { id: 'bank-second', customer_id: body.customer_id, is_test: true }; },
      createCashout: async body => {
        assert.equal(body.customer_id, 'customer-second'); assert.equal(body.account_id, 'bank-second');
        const value = { ...body, id: 'cashout-second-' + body.external_id, is_test: true, status: 'processed' }; sent.set(value.id, value); return value;
      }, getCashout: async id => sent.get(id),
    };
    PROVIDER_FACTORIES['second-fixture'] = () => b;
    try {
      const services = { ...c.services, brebWithdrawal: { ...c.services.brebWithdrawal, provider: 'second-fixture' } };
      const config = { ...c, services }, user = 'multi-provider';
      const make = config => createPlatformService({ ...service.deps, db: pool, env, config, provider: a, providerFor: id => {
        if (id === 'onepay') return a; if (id === 'second-fixture') return b; throw Error('Unknown test provider');
      } });
      const multi = make(config);
      await multi.accept(user, { documents: legalDocuments().map(({ id, version, hash }) => ({ id, version, hash })) });
      await registerCustomer(multi, user, { ...input, kind: 'bank' });
      assert.deepEqual((await multi.me(user)).merchant.customers, { bank: true, breb: false });
      await assert.rejects(() => registerDestination(multi, user, { kind: 'breb', key: '@second' }, randomUUID()), /beneficiary_required/);
      await assert.rejects(() => registerCustomer(multi, user, { ...otherInput, kind: 'breb' }), /Lost customer response/);
      await registerCustomer(multi, user, { ...otherInput, kind: 'breb' });
      assert.equal(keys.b.length, 2); assert.equal(keys.b[0], keys.b[1]); assert.notEqual(keys.a[0], keys.b[0]);
      assert.deepEqual((await multi.me(user)).merchant.customers, { bank: true, breb: true });
      const account = await registerDestination(multi, user, { kind: 'breb', key: '@second' }, randomUUID());
      const stored = (await query('SELECT * FROM platform_destinations WHERE id=$1', [account.id])).rows[0];
      assert.equal(stored.provider, 'second-fixture'); assert.equal(stored.provider_customer_id, 'customer-second');
      await multi.settings(user, { businessName: 'Prueba múltiple', policy: { mode: 'percentage', value: '0' } });
      const collection = await multi.createCollection(user, { wallet, amount: '2000' }, randomUUID());
      await processOperation(multi, collection.id);
      const created = (await query('SELECT * FROM platform_operations WHERE id=$1', [collection.id])).rows[0];
      charges.get(created.provider_id).status = 'paid'; await processOperation(multi, collection.id);
      await assert.rejects(() => multi.createWithdrawal(user, { amount: '1000', destinationId: account.id }, randomUUID()), /insufficient_onepay_liquidity/);
      assert.equal((await balances(pool, c.scope, user)).available, '2000.00');
      secondBalance = 1000000000n;
      const withdrawal = await multi.createWithdrawal(user, { amount: '1000', destinationId: account.id }, randomUUID());
      assert.equal(withdrawal.provider, 'second-fixture');
      const switched = make({ ...config, services: { ...services, brebWithdrawal: { ...services.brebWithdrawal, provider: 'onepay' } } });
      await assert.rejects(() => switched.createWithdrawal(user, { amount: '1000', destinationId: account.id }, randomUUID()), /destination_provider_changed/);
      const old = (await switched.me(user)).destinations.find(item => item.id === account.id);
      assert.equal(old.status, 'provider_changed');
      await processOperation(switched, withdrawal.id);
      assert.equal((await switched.get(user, withdrawal.id)).status, 'completed'); assert.equal(sent.size, 1);
      assert.equal((await balances(pool, c.scope, user)).available, '1000.00');
    } finally { delete PROVIDER_FACTORIES['second-fixture']; }
  });
  await t.test('ramps are selected independently, keep their own reservations and survive configuration changes', async () => {
    const alternate = 'So11111111111111111111111111111111111111112', prepared = [];
    let raw = '500000';
    RAMP_FACTORIES['alternate-fixture'] = () => ({
      settlement: 'prefunded_solana', liquidity: async () => ({ owner: alternate, raw, solLamports: '10000000' }),
      sellDestination: async () => alternate,
      prepareBuy: async op => { prepared.push(op.id); return { hash: 'alternate-signature-' + op.id, wire: 'payout-wire', lastValidBlockHeight: '100' }; },
    });
    try {
      const config = { ...c, services: { ...c.services, onRamp: { ...c.services.onRamp, provider: 'alternate-fixture' }, offRamp: { ...c.services.offRamp, provider: 'alternate-fixture' } } };
      const make = config => createPlatformService({ ...service.deps, db: pool, env, config, providerFor: id => {
        if (id !== 'onepay') throw Error('Wrong fiat provider'); return provider;
      } });
      const ramp = make(config), user = 'ramp-user'; await accept(user);
      await service.settings(user, { businessName: 'Prueba rampas', policy: { mode: 'percentage', value: '0' } });
      const deposit = await service.createCollection(user, { wallet, amount: '2000' }, randomUUID());
      await processOperation(service, deposit.id);
      const stored = (await query('SELECT * FROM platform_operations WHERE id=$1', [deposit.id])).rows[0];
      charges.get(stored.provider_id).status = 'paid'; await processOperation(service, deposit.id);
      const nativeQuote = await service.quote(user, { direction: 'buy', amount: '1000' });
      await service.createBuy(user, { wallet, quoteId: nativeQuote.id }, randomUUID());
      RAMP_FACTORIES['shared-fixture'] = () => ({ ...RAMP_FACTORIES['alternate-fixture'](),
        liquidity: async () => ({ owner: treasury, raw: '248750', solLamports: '10000000' }),
      });
      const shared = make({ ...config, services: { ...config.services, onRamp: { ...config.services.onRamp, provider: 'shared-fixture' } } });
      await assert.rejects(() => shared.createBuy(user, { wallet, quoteId: nativeQuote.id }, randomUUID()), /insufficient_treasury/);
      const quote = await ramp.quote(user, { direction: 'buy', amount: '1000' });
      const buy = await ramp.createBuy(user, { wallet, quoteId: quote.id }, randomUUID());
      assert.equal(buy.provider, 'alternate-fixture'); assert.equal(buy.treasury_address, alternate);
      await processOperation(ramp, buy.id); assert.deepEqual(prepared, [buy.id]);
      let fresh = (await query('SELECT * FROM platform_operations WHERE id=$1', [buy.id])).rows[0];
      assert.equal(fresh.signed_wire, 'payout-wire');
      signatureStatuses.set(fresh.signature, { confirmationStatus: 'finalized', err: null });
      await processOperation(ramp, buy.id); raw = '251250';
      const sellQuote = await ramp.quote(user, { direction: 'sell', amount: '1' });
      const separate = make({ ...config, services: { ...config.services, offRamp: c.services.offRamp } });
      const nativeSell = await separate.createSell(user, { wallet, quoteId: sellQuote.id }, randomUUID());
      assert.equal(nativeSell.provider, 'treasury'); assert.equal(nativeSell.metadata.to, treasury);
      await separate.cancel(user, nativeSell.id);
      const sell = await ramp.createSell(user, { wallet, quoteId: sellQuote.id }, randomUUID());
      assert.equal(sell.provider, 'alternate-fixture'); assert.equal(sell.metadata.to, alternate);
      assert.equal(sell.metadata.fiatProvider, 'onepay');
      const changedFiat = make({ ...config, services: { ...config.services, offRamp: { ...config.services.offRamp, fiatProvider: 'unregistered-fiat' } } });
      const submitted = await changedFiat.submit(user, sell.id, 'user-signed');
      signatureStatuses.set(submitted.signature, { confirmationStatus: 'finalized', err: null });
      await processOperation(changedFiat, sell.id); assert.equal((await ramp.get(user, sell.id)).status, 'completed');
      raw = '1251250';
      await ramp.settings(user, { businessName: 'Prueba rampas', policy: { mode: 'percentage', value: '100' } });
      const collected = await ramp.createCollection(user, { wallet, amount: '1000' }, randomUUID());
      assert.equal(collected.metadata.rampProvider, 'alternate-fixture');
      const rotated = make(c); await processOperation(rotated, collected.id);
      fresh = (await query('SELECT * FROM platform_operations WHERE id=$1', [collected.id])).rows[0];
      charges.get(fresh.provider_id).status = 'paid'; await processOperation(rotated, collected.id);
      const child = (await query('SELECT * FROM platform_operations WHERE parent_id=$1', [collected.id])).rows[0];
      assert.equal(child.provider, 'alternate-fixture'); assert.equal(child.treasury_address, alternate);
      await processOperation(rotated, child.id); assert.deepEqual(prepared, [buy.id, child.id]);
      fresh = (await query('SELECT * FROM platform_operations WHERE id=$1', [child.id])).rows[0];
      signatureStatuses.set(fresh.signature, { confirmationStatus: 'finalized', err: null });
      await processOperation(rotated, child.id); assert.equal((await rotated.get(user, collected.id)).status, 'completed');
      const broken = make({ ...config, services: { ...config.services,
        onRamp: { ...config.services.onRamp, provider: 'unregistered' }, offRamp: { ...config.services.offRamp, provider: 'unregistered' },
      } });
      const before = await balances(pool, c.scope, user);
      const beforeCount = (await service.list(user)).operations.length;
      await assert.rejects(() => broken.createBuy(user, { wallet, quoteId: quote.id }, randomUUID()), /ramp_provider_not_integrated/);
      await assert.rejects(() => broken.createSell(user, { wallet, quoteId: sellQuote.id }, randomUUID()), /ramp_provider_not_integrated/);
      await assert.rejects(() => broken.createCollection(user, { wallet, amount: '1000' }, randomUUID()), /ramp_provider_not_integrated/);
      assert.deepEqual(await balances(pool, c.scope, user), before);
      assert.equal((await service.list(user)).operations.length, beforeCount);
    } finally { delete RAMP_FACTORIES['alternate-fixture']; delete RAMP_FACTORIES['shared-fixture']; }
  });
  await t.test('a signed OnePay webhook cannot select another provider with a colliding resource ID', async () => {
    const eventEnv = { PLATFORM_ENABLED: 'true', PLATFORM_DEPLOYMENT_ID: 'webhook-isolation', ONEPAY_WEBHOOK_TOKEN: 'offline-token', ONEPAY_WEBHOOK_SECRET: 'offline-secret' };
    const config = platformConfig(eventEnv), future = new Date(Date.now() + 86400000), selected = [];
    const first = await insertOperation(pool, config, { user_id: 'event-user', kind: 'collection', provider: 'onepay', provider_id: 'same-provider-id',
      status: 'awaiting_payment', idempotency_key: randomUUID(), input_hash: hashInput({ test: 1 }), fiat_minor: '100000', next_attempt_at: future, expires_at: future });
    await insertOperation(pool, config, { user_id: 'event-user', kind: 'collection', provider: 'second-fixture', provider_id: 'same-provider-id',
      status: 'awaiting_payment', idempotency_key: randomUUID(), input_hash: hashInput({ test: 2 }), fiat_minor: '100000', next_attempt_at: future, expires_at: future });
    const body = JSON.stringify({ event: 'charge.pending', data: { id: 'same-provider-id' } });
    const signature = createHmac('sha256', eventEnv.ONEPAY_WEBHOOK_SECRET).update(body).digest('hex');
    const webhook = createOnepayWebhook({ env: eventEnv, db: pool, kick: async () => {} });
    const event = { httpMethod: 'POST', body, headers: { 'x-webhook-token': eventEnv.ONEPAY_WEBHOOK_TOKEN, signature } };
    assert.equal((await webhook(event)).statusCode, 200); assert.equal((await webhook(event)).statusCode, 200);
    const scoped = createPlatformService({ ...service.deps, db: pool, config, providerFor: id => ({
      getCharge: async () => { selected.push(id); return { id: 'same-provider-id', is_test: true, currency: 'COP', amount: 1000, status: 'pending', external_id: first.id }; },
    }) });
    await runPlatformWorker(scoped, { budgetMs: 2000, wait: async () => {} });
    assert.deepEqual(selected, ['onepay']);
    const inbox = (await query('SELECT * FROM platform_inbox WHERE scope=$1', [config.scope])).rows;
    assert.equal(inbox.length, 1); assert.equal(inbox[0].provider, 'onepay'); assert.ok(inbox[0].processed_at);
  });
});
