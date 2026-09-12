import { armarMemo, nuevaFactura, getUsdcBalance, sendUsdcWithKeypair, keypairSignerFromSecret } from "./solana.js";

/**
 * Wallet recaudadora (tesorería) fondeada en Solana Devnet.
 * En demo: clave en VITE_TREASURY_SECRET_KEY (base58 o JSON array, solo devnet).
 * En producción: reemplazar por un servicio/backend que firme payouts.
 */
const TREASURY_SECRET = import.meta.env.VITE_TREASURY_SECRET_KEY || import.meta.env.VITE_TREASURY_PRIVATE_KEY || "";

let cachedSignerPromise = null;

export function isTreasuryConfigured() {
  return Boolean(TREASURY_SECRET && TREASURY_SECRET.length >= 32);
}

async function getTreasurySigner() {
  if (!isTreasuryConfigured()) {
    throw new Error("Treasury no configurada. Definí VITE_TREASURY_SECRET_KEY en .env");
  }
  if (!cachedSignerPromise) {
    cachedSignerPromise = keypairSignerFromSecret(TREASURY_SECRET);
  }
  return cachedSignerPromise;
}

export async function getTreasuryWallet() {
  return getTreasurySigner();
}

export function getTreasuryAddress() {
  if (!isTreasuryConfigured()) return null;
  // Derivación sync no está disponible sin await — cacheamos al primer uso async.
  // Para UI temprana devolvemos null hasta que se resuelva; flows usan getTreasuryAddressAsync.
  return _treasuryAddressCache;
}

let _treasuryAddressCache = null;

export async function getTreasuryAddressAsync() {
  if (!isTreasuryConfigured()) return null;
  try {
    const signer = await getTreasurySigner();
    _treasuryAddressCache = signer.address;
    return signer.address;
  } catch {
    return null;
  }
}

// Eager hydrate for UI that reads getTreasuryAddress() sync
if (isTreasuryConfigured()) {
  getTreasuryAddressAsync().catch(() => {});
}

export async function getTreasuryBalance() {
  const addr = await getTreasuryAddressAsync();
  if (!addr) return null;
  return getUsdcBalance(addr);
}

/**
 * Payout desde la recaudadora → usuario (USDC SPL en Solana).
 */
export async function sendTreasuryPayout({ to, usdc, kind, ars, fxRate, factura: facturaIn }) {
  const signer = await getTreasurySigner();
  const factura = facturaIn || nuevaFactura();
  const memo = armarMemo({
    inv: factura,
    kind,
    cur: "ARS",
    amt: ars,
    fx: Number(fxRate).toFixed(2),
    usdc: Number(usdc).toFixed(6),
  });
  const result = await sendUsdcWithKeypair(signer, { to, usdc, memo });
  return { ...result, factura, from: signer.address, to, usdc, ars, fxRate, kind };
}
