import { platformConfig, getPlatformDb, closePlatformDb } from '../netlify/functions/lib/platform/config.js';
import { onepaySettings, createOnepay } from '../netlify/functions/lib/platform/onepay.js';
import { fetchPlatformQuote } from '../netlify/functions/lib/platform/fx.js';
import { treasuryLiquidity } from '../netlify/functions/lib/treasuryPayout.js';
import { PlatformError } from '../src/platform/money.js';

// Read-only: never creates customers, webhooks, charges, signatures or payouts.
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push({ name, ready: true }); }
  catch (error) { checks.push({ name, ready: false, code: error?.code || error?.message === 'missing_table' && 'platform_migration_required' || 'check_unavailable' }); }
}
await check('country_and_network', async () => { const c = platformConfig(); if (c.country.legacy) throw new Error(); });
await check('onepay_test_credentials', async () => { onepaySettings(); });
await check('onepay_balance', async () => { await createOnepay().getBalance(); });
await check('webhook_configuration', async () => {
  if (!process.env.ONEPAY_WEBHOOK_SECRET || !process.env.ONEPAY_WEBHOOK_TOKEN) throw new PlatformError('onepay_webhook_not_configured');
  if (!process.env.PAYMENTS_BASE_URL || (process.env.INTERNAL_WORKER_SECRET || '').length < 32) throw new PlatformError('worker_not_configured');
});
await check('database_schema', async () => {
  const db = getPlatformDb();
  for (const table of ['platform_merchants','platform_provider_customers','platform_operations','platform_journals','platform_acceptances','platform_inbox','platform_quotes','platform_destinations','platform_closed_attempts','platform_contacts','platform_wallet_audit']) {
    const { rows } = await db.query('SELECT to_regclass($1)::text AS name', [table]);
    if (!rows[0].name) throw new Error('missing_table');
  }
});
await check('criptoya_quote', async () => { await fetchPlatformQuote(); });
await check('devnet_treasury_liquidity', async () => {
  const liquidity = await treasuryLiquidity();
  if (BigInt(liquidity.raw) === 0n) throw new PlatformError('devnet_usdc_required');
  if (BigInt(liquidity.solLamports) < 3000000n) throw new PlatformError('devnet_sol_required');
});
await closePlatformDb();
console.log(JSON.stringify({ ready: checks.every(c => c.ready), readOnly: true, checks }, null, 2));
if (checks.some(c => !c.ready)) process.exitCode = 1;
