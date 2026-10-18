import pg from 'pg';
import { createHash } from 'node:crypto';
import { COUNTRY_CATALOG, bankContactsAvailable } from '../../../../src/platform/countries.js';
import { PlatformError } from '../../../../src/platform/money.js';
import { networkConfig } from '../../../../src/network.js';
import { legalDocuments } from './legal.js';

export function platformConfig(env = process.env) {
  const country = COUNTRY_CATALOG[env.APP_COUNTRY || 'CO'];
  if (!country) throw new PlatformError('unsupported_country', 503);
  if (!country.legacy && !legalDocuments(country.code).length) throw new PlatformError('country_legal_documents_required', 503);
  if (env.CONVERSION_FEE_BPS && env.CONVERSION_FEE_BPS !== '50') throw new PlatformError('invalid_conversion_fee', 503);
  const environment = env.APP_ENVIRONMENT || 'sandbox';
  const network = networkConfig(env.VITE_SOLANA_CLUSTER || 'devnet');
  if (!country.legacy && (environment !== 'sandbox' || network.cluster !== 'devnet'))
    throw new PlatformError('colombia_requires_sandbox_devnet', 503);
  const deployment = env.PLATFORM_DEPLOYMENT_ID || 'colombia-sandbox';
  const account = env.ONEPAY_ACCOUNT_REF || 'onepay-sandbox';
  if (![deployment, account].every(value => /^[a-zA-Z0-9_-]{1,80}$/.test(value))) throw new PlatformError('invalid_deployment_identity', 503);
  const scope = `${deployment}:${country.code}:${environment}:${network.cluster}:${account}`;
  const enabled = env.PLATFORM_ENABLED === 'true';
  const services = Object.fromEntries(Object.entries(country.services).map(([id, service]) => [id, {
    ...service, enabled: enabled && service.available,
    ...(!enabled && service.available ? { reason: 'sandbox_not_enabled' } : {}),
  }]));
  return { country, environment, network, deployment, account, scope,
    contextId: createHash('sha256').update(scope).digest('hex'), services, enabled, feeBps: 50 };
}
export function publicConfig(env = process.env) {
  const c = platformConfig(env);
  return { country: c.country, environment: c.environment, network: c.network.cluster, mint: c.network.mint,
    deployment: c.deployment, contextId: c.contextId, services: c.services, features: { bankContacts: bankContactsAvailable(c) }, feeBps: c.feeBps, documents: legalDocuments(c.country.code) };
}
export function assertService(config, id, { existing = false } = {}) {
  const service = config.services[id];
  if (!service?.available) throw new PlatformError(service?.reason || 'service_unavailable', 403);
  if (!existing && !service.enabled) throw new PlatformError('sandbox_not_enabled', 403);
}
let pool;
export function getPlatformDb(env = process.env) {
  platformConfig(env);
  if (!env.PLATFORM_DATABASE_URL || !env.PLATFORM_DATABASE_CA_CERT) throw new PlatformError('platform_database_not_configured', 503);
  const url = new URL(env.PLATFORM_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new PlatformError('invalid_platform_database', 503);
  // Never run the new ledger against the legacy production database by accident.
  if (env.AIVEN_PG_URL) {
    const legacy = new URL(env.AIVEN_PG_URL);
    if (url.host === legacy.host && url.pathname === legacy.pathname) throw new PlatformError('platform_database_must_be_isolated', 503);
  }
  for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(name);
  return pool ??= new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000,
    statement_timeout: 15000, ssl: { ca: env.PLATFORM_DATABASE_CA_CERT.replace(/\\n/g, '\n'), rejectUnauthorized: true, servername: url.hostname } });
}
export async function closePlatformDb() { if (pool) { await pool.end(); pool = undefined; } }
