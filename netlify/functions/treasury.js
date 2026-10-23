import { authenticatePayment } from './lib/paymentRuntime.js';
// API de la recaudadora: consulta autenticada + payouts firmados server-side.
// TREASURY_SECRET_KEY vive solo acá (sin prefijo VITE_).

import { PrivyClient } from "@privy-io/server-auth";
import { isAddress } from "@solana/kit";
import { NETWORK } from "../../src/network.js";
import { isPaymentAdmin } from './lib/paymentReporting.js';
import { createReadCache } from './lib/readCache.js';
import {
  getTreasuryAddress,
  getTreasuryBalance,
  isTreasuryConfigured,
  sendTreasuryPayout,
} from "./lib/treasuryPayout.js";



function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Vary": "Authorization" },
    // @solana/kit a veces devuelve BigInt (slot/amount); JSON no los serializa.
    body: JSON.stringify(body, (_key, value) =>
      typeof value === "bigint" ? Number(value) : value
    ),
  };
}

async function authenticate(event) {
  try { return await authenticatePayment(event); }
  catch { return null; }
}

export function createTreasuryHandler(adapters = {}) {
const read=adapters.read || createReadCache();
return async (event) => {
  const method = event.httpMethod || event.method || "GET";

  if (method === "GET") {
    try {
      const userId = await (adapters.authenticate || authenticate)(event);
      if (!userId) return json(401, { error: "unauthorized" });
      const configured = (adapters.isConfigured || isTreasuryConfigured)();
      if (!configured) {
        return json(200, { configured: false, address: null, balance: null });
      }
      const admin = (adapters.isAdmin || isPaymentAdmin)(userId);
      const address=await (adapters.getAddress || getTreasuryAddress)();
      const balance=admin ? await read(`treasury:${NETWORK.cluster}:${address}`,10000,adapters.getBalance || getTreasuryBalance) : null;
      return json(200, { configured: true, address, balance });
    } catch (err) {
      return json(503, { error: "treasury_unavailable" });
    }
  }

  if (method === "POST") {
    if (NETWORK.cluster !== "devnet") return json(403, { error: "direct_treasury_payout_disabled" });
    const userId = await authenticate(event);
    if (!userId) return json(401, { error: "unauthorized" });
    if (!isTreasuryConfigured()) {
      return json(503, { error: "treasury_not_configured" });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const { to, usdc, kind, ars, fxRate, factura } = body;
    if (!to || !isAddress(to)) return json(400, { error: "invalid_to" });
    const amount = Number(usdc);
    if (!Number.isFinite(amount) || amount < 0.01) return json(400, { error: "invalid_usdc" });
    if (amount > 10_000) return json(400, { error: "usdc_too_large" });

    try {
      const bal = await getTreasuryBalance();
      if (bal !== null && amount > bal) {
        return json(400, { error: "insufficient_treasury", balance: bal });
      }
      const payout = await sendTreasuryPayout({
        to,
        usdc: amount,
        kind: kind || "convert_ars_usdc",
        ars: Number(ars) || 0,
        fxRate: Number(fxRate) || 0,
        factura: factura || undefined,
      });
      return json(200, { payout });
    } catch (err) {
      return json(500, { error: String(err?.message || err) });
    }
  }

  return json(405, { error: "method_not_allowed" });
};
}
export const handler = createTreasuryHandler();
