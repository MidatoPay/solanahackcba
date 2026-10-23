import {securityFetch as fetch} from './securitySession.js';
import { SOLANA } from "./chain.js";
import { deliveryPhase, paymentReceived } from "./chargeStatus.js";
// Cliente HTTP del historial de transacciones, con cache stale-while-revalidate
// en localStorage. Mismo patrón que src/contacts.js. Ver
// docs/superpowers/specs/2026-08-07-transactions-history-design.md § 1.4.

const CACHE_PREFIX = "mp_tx_cache_";
const cacheKey = (userId) => `${CACHE_PREFIX}${SOLANA.cluster}_${userId}`;

function readCache(userId) {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeCache(userId, list) {
  if (!userId) return;
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

// El wire format de la Function usa los mismos nombres que las columnas
// (snake_case); la UI usa camelCase (mismo patrón que addr/address en
// src/contacts.js).
function toWire(tx) {
  return {
    hash: tx.hash,
    kind: tx.kind,
    direction: tx.direction,
    who: tx.who,
    amt: tx.amt,
    fx_rate: tx.fxRate,
    ars: tx.ars,
    factura: tx.factura ?? null,
    block: tx.block ?? null,
    fee: tx.fee ?? null,
    fee_ars: tx.feeArs ?? tx.fee ?? null,
    memo: tx.memo ?? null,
  };
}

function fromWire(row) {
  return {
    hash: row.hash,
    kind: row.kind,
    direction: row.direction,
    who: row.who,
    amt: Number(row.amt),
    fxRate: Number(row.fx_rate),
    ars: Number(row.ars),
    factura: row.factura,
    block: row.block !== null && row.block !== undefined ? Number(row.block) : null,
    fee: row.fee !== null && row.fee !== undefined ? Number(row.fee) : null,
    feeArs: row.fee_ars !== null && row.fee_ars !== undefined ? Number(row.fee_ars)
      : (row.fee !== null && row.fee !== undefined ? Number(row.fee) : null),
    memo: row.memo,
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
    lastError: row.last_error || null,
    chargeId: row.charge_id || null,
    transferId: row.transfer_id || null,
    orderId: row.order_id || null,
    source: row.source || "wallet",
    status: row.status || "confirmed",
    providerStatus: row.provider_status || null,
    providerDetail: row.provider_detail || null,
    settled: row.settled !== false,
    signature: row.signature || (row.hash?.startsWith("charge:") ? null : row.hash),
  };
}

async function api(path, token, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `http_${res.status}`);
    err.code = body.error;
    throw err;
  }
  return body;
}

/**
 * Mergea la lista fresca del server con lo que ya había en memoria: el
 * server manda para cualquier hash que ya conozca; las entradas locales
 * cuyo hash el server todavía no tiene (POST en vuelo, o falló) se
 * mantienen arriba de todo.
 */
export function mergeByHash(serverList, localList) {
  const seen = new Set(serverList.map((tx) => tx.hash));
  const charges = new Set(serverList.map((tx)=>tx.chargeId).filter(Boolean));
  const transfers=new Set(serverList.map(tx=>tx.transferId).filter(Boolean));
  const onlyLocal = localList.filter((tx) => !seen.has(tx.hash) && !(tx.chargeId && charges.has(tx.chargeId)) && !(tx.transferId && transfers.has(tx.transferId)));
  return [...onlyLocal, ...serverList];
}

export function activityStatusKey(tx, now) {
  if(tx.source==='transfer')return ({broadcasting:'transferPending',confirmed:'transferConfirmed',completed:'transferCompleted',failed:'transferFailed',manual_review:'transferReview'})[tx.status] || 'transferPending';
  if(tx.source!=="mercadopago")return null;
  const paid=paymentReceived(tx);
  if(tx.status==="manual_review")return paid?"chargePaidReview":"chargeReview";
  if(paid)return ({pending:"chargePaidPending",confirmed:"chargeConfirmed",delayed:"chargePaidDelayed",delivered:"chargeDelivered"})[deliveryPhase(tx,now)];
  return ({creating:"chargeCreating",awaiting_payment:"chargeAwaiting",paid:"chargePaidPending",
    delivery_pending:"chargePaidPending",broadcasting:"chargePaidPending",confirmed:"chargeConfirmed",delivered:"chargeDelivered",
    canceled:"chargeCanceled",expired:"chargeExpired",cancel_pending:"chargeCancelPending",refunded:"chargeRefunded"})[tx.status] || "chargeReview";
}

export function activityRefreshInterval(transactions) {
  if(transactions.some(tx=>tx.source==='transfer' && ['broadcasting','confirmed'].includes(tx.status)))return 2500;
  if(transactions.some(tx=>tx.source==='transfer' && tx.status==='manual_review'))return 15000;
  const pending=transactions.filter(tx=>tx.source==="mercadopago" && !tx.settled);
  if(pending.some(tx=>["paid","delivery_pending","broadcasting","confirmed"].includes(tx.status)))return 2500;
  if(pending.some(tx=>["creating","awaiting_payment","cancel_pending"].includes(tx.status)))return 5000;
  if(pending.some(tx=>tx.status==="manual_review" && paymentReceived(tx)))return 15000;
  return null;
}

/**
 * Sirve el cache al instante (vía onCache, si hay algo cacheado) y en
 * paralelo pide la lista real a /transactions; la respuesta del server pisa
 * el cache y es lo que resuelve la promise. Si el request falla, se resuelve
 * con lo que había en cache en vez de rechazar.
 */
export function loadTransactions(userId, token, address, onCache) {
  const cached = readCache(userId);
  if (onCache) onCache(cached);
  if (!userId || !token) return Promise.resolve(cached);
  const path = address ? `/transactions?address=${encodeURIComponent(address)}` : "/transactions";
  return api(path, token)
    .then(({ transactions }) => {
      const list = transactions.map(fromWire);
      writeCache(userId, list);
      return list;
    })
    .catch(() => cached);
}

export async function addTransaction(userId, token, list, data) {
  const { transaction } = await api("/transactions", token, { method: "POST", body: JSON.stringify(toWire(data)) });
  const fresh = fromWire(transaction);
  const next = [fresh, ...list.filter((tx) => tx.hash !== fresh.hash)];
  writeCache(userId, next);
  return next;
}
