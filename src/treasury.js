import {securityFetch as fetch} from './securitySession.js';
/**
 * Cliente HTTP de la recaudadora.
 * La secret key vive solo en la Netlify Function (`TREASURY_SECRET_KEY`).
 * Las consultas y payouts requieren una sesión de Privy.
 */

let _status = { configured: false, address: null, balance: null };
let _statusPromise = null;
let _session = null;

export function setTreasurySession(userId, getAccessToken) {
  const session = userId ? { userId, getAccessToken } : null;
  _session = session;
  _status = { configured: false, address: null, balance: null };
  _statusPromise = null;
  return () => {
    if (_session !== session) return;
    _session = null;
    _status = { configured: false, address: null, balance: null };
    _statusPromise = null;
  };
}

async function api(path, token, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `http_${res.status}`);
    err.code = body.error;
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Consulta autenticada; el servidor entrega saldo solo a administradores. */
export async function refreshTreasuryStatus() {
  const session = _session;
  if (!session) return { configured: false, address: null, balance: null };
  _statusPromise = Promise.resolve().then(async () => {
    const token = await session.getAccessToken();
    if (!token || _session !== session) throw new Error('unauthorized');
    return api("/treasury", token, { cache: "no-store" });
  })
    .then((body) => {
      if (_session !== session) return { configured: false, address: null, balance: null };
      _status = {
        configured: Boolean(body.configured),
        address: body.address || null,
        balance: body.balance == null ? null : Number(body.balance),
      };
      return _status;
    })
    .catch(() => {
      if (_session !== session) return { configured: false, address: null, balance: null };
      _status = { configured: false, address: null, balance: null };
      return _status;
    });
  return _statusPromise;
}

function ensureStatus() {
  if (!_statusPromise) return refreshTreasuryStatus();
  return _statusPromise;
}

export function isTreasuryConfigured() {
  return Boolean(_status.configured && _status.address);
}

export function getTreasuryAddress() {
  return _status.address;
}

export async function getTreasuryAddressAsync() {
  await ensureStatus();
  return _status.address;
}

export async function getTreasuryBalance() {
  const st = await refreshTreasuryStatus();
  return st.balance;
}

/**
 * Payout desde la recaudadora → usuario (vía Function server-side).
 * Requiere access token de Privy.
 */
export async function sendTreasuryPayout(token, { to, usdc, kind, ars, fxRate, factura }) {
  if (!token) throw new Error("Sesión requerida para operar la recaudadora");
  await ensureStatus();
  if (!isTreasuryConfigured()) {
    throw new Error("Treasury no configurada. Definí TREASURY_SECRET_KEY en el server (Netlify/.env).");
  }
  const { payout } = await api("/treasury", token, {
    method: "POST",
    body: JSON.stringify({ to, usdc, kind, ars, fxRate, factura }),
  });
  return payout;
}
