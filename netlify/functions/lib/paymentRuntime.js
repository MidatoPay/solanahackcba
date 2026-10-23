import pg from "pg";
import { authenticateIdentity, requireUnlock } from './securityAuth.js';
import { PrivyClient } from "@privy-io/server-auth";
import { timingSafeEqual } from "node:crypto";
import { NETWORK } from "../../../src/network.js";
import { PaymentError } from "./paymentCore.js";
import { primarySolanaWallet } from '../../../src/primaryWallet.js';

let pool, privy;
export function paymentDatabaseConfig(env=process.env) {
  if (!env.AIVEN_PG_URL?.trim()) throw new PaymentError("missing_aiven_pg_url");
  if (!env.AIVEN_PG_CA_CERT?.trim()) throw new PaymentError("missing_aiven_pg_ca_cert");
  let url;
  try {url=new URL(env.AIVEN_PG_URL.trim());if(!["postgres:","postgresql:"].includes(url.protocol))throw new Error();}
  catch {throw new PaymentError("invalid_database_url");}
  for(const key of ["sslmode","sslcert","sslkey","sslrootcert"])url.searchParams.delete(key);
  return {connectionString:url.toString(),max:4,connectionTimeoutMillis:5000,statement_timeout:12000,query_timeout:15000,
    ssl:{ca:env.AIVEN_PG_CA_CERT.replace(/\\n/g,"\n"),rejectUnauthorized:true,servername:url.hostname}};
}
export function getPaymentDb() {
  if (!pool) {
    pool = new pg.Pool(paymentDatabaseConfig());
  }
  return pool;
}
export function getPaymentPrivy() {
  if(!process.env.VITE_PRIVY_APP_ID?.trim())throw new PaymentError("missing_vite_privy_app_id");
  if(!process.env.PRIVY_APP_SECRET?.trim())throw new PaymentError("missing_privy_app_secret");
  return privy ??= new PrivyClient(process.env.VITE_PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
}
export async function authenticatePayment(event) {
  const identity=await authenticateIdentity(event);
  await requireUnlock(event,identity);
  return identity.userId;
}
export async function assertWalletOwned(userId, wallet) {
  const user = await getPaymentPrivy().getUser(userId);
  if (primarySolanaWallet(user)?.address!==wallet) throw new PaymentError("primary_wallet_required", 403);
}
export function paymentSettings(env=process.env,network=NETWORK) {
  const environment = env.MP_ENVIRONMENT || "test";
  if (!["test", "production"].includes(environment)) throw new PaymentError("invalid_mp_environment");
  // Mercado Pago environment and Solana cluster are configured independently.
  for (const key of ["MP_ACCESS_TOKEN", "MP_USER_ID", "MP_WEBHOOK_SECRET", "SOLANA_RPC", "INTERNAL_WORKER_SECRET"]) {
    if (!env[key]?.trim()) throw new PaymentError(`missing_${key.toLowerCase()}`);
  }
  if (env.INTERNAL_WORKER_SECRET.length < 32) throw new PaymentError("invalid_worker_secret");
  return { environment, network: network.cluster, seller: env.MP_USER_ID.trim(),
    store: env.MP_STORE_ID?.trim(), token: env.MP_ACCESS_TOKEN.trim() };
}
export function assertPaymentsEnabled() {
  if (process.env.PAYMENTS_ENABLED !== "true") throw new PaymentError("payments_disabled");
  if (process.env.CONVERSION_FEE_BPS && process.env.CONVERSION_FEE_BPS !== "50") throw new PaymentError("invalid_conversion_fee");
}
export { paymentQuoteSettings } from './quoteSettings.js';
export function internalAuthorized(event) {
  const actual = event.headers?.["x-worker-secret"] || event.headers?.["X-Worker-Secret"] || "";
  const secret = process.env.INTERNAL_WORKER_SECRET || "";
  return secret.length >= 32 && Buffer.byteLength(actual) === Buffer.byteLength(secret) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(secret));
}
export function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
export function errorResponse(error) {
  if (!(error instanceof PaymentError)) {
    const codes = { "42P01":"payment_schema_missing", "42703":"payment_schema_outdated",
      "28P01":"payment_database_auth_failed", "42501":"payment_database_permission_denied",
      CERT_HAS_EXPIRED:"payment_database_tls_failed", SELF_SIGNED_CERT_IN_CHAIN:"payment_database_tls_failed",
      DEPTH_ZERO_SELF_SIGNED_CERT:"payment_database_tls_failed", UNABLE_TO_VERIFY_LEAF_SIGNATURE:"payment_database_tls_failed",
      ERR_TLS_CERT_ALTNAME_INVALID:"payment_database_tls_failed", ECONNREFUSED:"payment_database_unavailable",
      ETIMEDOUT:"payment_database_unavailable", ENOTFOUND:"payment_database_unavailable", ECONNRESET:"payment_database_unavailable" };
    const code = codes[error?.code] || "payment_service_unavailable";
    // Never log SQL, connection strings, request headers or arbitrary error messages.
    console.error("payments_failure", { code, causeCode: codes[error?.code] ? error.code : "unclassified" });
    return json(503, { error: code });
  }
  if (error.status>=500) console.error("payments_failure",{code:error.code});
  return json(error instanceof PaymentError ? error.status : 503,
    { error: error instanceof PaymentError ? error.code : "payment_service_unavailable" });
}
export async function transaction(fn, poolOverride) {
  const db = await (poolOverride || getPaymentDb()).connect();
  try { await db.query("BEGIN"); const result = await fn(db); await db.query("COMMIT"); return result; }
  catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
export async function kickWorker({ env=process.env, request=fetch, log=console.error, functionName='payments-worker-background' }={}) {
  const origin = env.PAYMENTS_BASE_URL || env.URL;
  const failed=(code,status)=>{
    log("payments_worker_dispatch_failed",{code,...(status ? {status}: {})});
    return {accepted:false,code};
  };
  if (!origin || !env.INTERNAL_WORKER_SECRET) return failed("payment_worker_not_configured");
  try {
    if(!['payments-worker-background','transfers-worker-background'].includes(functionName))return failed('invalid_worker');
    const response=await request(new URL(`/.netlify/functions/${functionName}`, origin), {
      method: "POST", headers: { "x-worker-secret": env.INTERNAL_WORKER_SECRET }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return failed("payment_worker_dispatch_failed",response.status);
    // Netlify acknowledges background invocation before the worker finishes.
    return {accepted:true};
  } catch { return failed("payment_worker_dispatch_failed"); }
}
