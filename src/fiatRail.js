/**
 * Riel fiat (ARS) — interfaz desacoplada del on-chain.
 *
 * Hoy: simula el desembolso en pesos de Convertir (USDC→ARS).
 * Mañana: reemplazar el cuerpo de `payoutArsToUser` por un proveedor
 * real (Mercado Pago, PSE, transferencia, etc.) sin tocar Convertir.
 */

/**
 * @typedef {object} FiatPaymentResult
 * @property {string} id
 * @property {'simulated'|'pending'|'confirmed'|'failed'} status
 * @property {number} ars
 * @property {string} currency
 * @property {number} ts
 * @property {string} [provider]
 */

/**
 * Simula un desembolso fiat al usuario (USDC→ARS).
 * No mueve dinero bancario: solo confirma el crédito en ledger local.
 * @param {number} arsAmount
 * @returns {Promise<FiatPaymentResult>}
 */
export async function payoutArsToUser(arsAmount) {
  const ars = Number(arsAmount);
  if (!Number.isFinite(ars) || ars <= 0) {
    throw new Error("Monto ARS inválido para payout fiat");
  }
  await new Promise((r) => setTimeout(r, 350));
  return {
    id: `fiat_out_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`,
    status: "simulated",
    ars,
    currency: "ARS",
    ts: Date.now(),
    provider: "mock-fiat-rail",
  };
}
