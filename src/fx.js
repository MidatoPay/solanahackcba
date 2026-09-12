import { FALLBACK_FX_ARS_USD, fetchArsPerUsd } from "./priceFeed.js";
import { withRetry } from "./solana.js";

export { FALLBACK_FX_ARS_USD };

/** Obtiene ARS por 1 USDC/USD desde Chainlink (con fallback). */
export async function getArsPerUsdc() {
  try {
    return await withRetry(() => fetchArsPerUsd());
  } catch {
    return FALLBACK_FX_ARS_USD;
  }
}

/** ARS → USDC usando cotización (ARS por 1 USDC). */
export function arsToUsdc(arsAmount, arsPerUsdc) {
  const rate = Number(arsPerUsdc);
  const ars = Number(arsAmount);
  if (!Number.isFinite(ars) || ars <= 0) throw new Error("Monto ARS inválido");
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Cotización inválida");
  return ars / rate;
}

/** USDC → ARS usando cotización (ARS por 1 USDC). */
export function usdcToArs(usdcAmount, arsPerUsdc) {
  const rate = Number(arsPerUsdc);
  const usdc = Number(usdcAmount);
  if (!Number.isFinite(usdc) || usdc <= 0) throw new Error("Monto USDC inválido");
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Cotización inválida");
  return usdc * rate;
}

export function quoteArsToUsdc(arsAmount, arsPerUsdc) {
  const usdc = arsToUsdc(arsAmount, arsPerUsdc);
  return { ars: Number(arsAmount), usdc, fxRate: Number(arsPerUsdc) };
}

export function quoteUsdcToArs(usdcAmount, arsPerUsdc) {
  const ars = usdcToArs(usdcAmount, arsPerUsdc);
  return { usdc: Number(usdcAmount), ars, fxRate: Number(arsPerUsdc) };
}
