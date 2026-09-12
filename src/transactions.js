// Cliente HTTP del historial de transacciones, con cache stale-while-revalidate
// en localStorage. Mismo patrón que src/contacts.js. Ver
// docs/superpowers/specs/2026-08-07-transactions-history-design.md § 1.4.

const CACHE_PREFIX = "mp_tx_cache_";
const cacheKey = (userId) => `${CACHE_PREFIX}${userId}`;

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
    memo: row.memo,
    createdAt: row.created_at,
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
  const onlyLocal = localList.filter((tx) => !seen.has(tx.hash));
  return [...onlyLocal, ...serverList];
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
