import {
  armarMemo,
  estimateUsdcTransfer,
  getUsdcBalance,
  nuevaFactura,
  sendUsdc,
} from "./solana.js";
import { arsToUsdc, getArsPerUsdc, quoteArsToUsdc, quoteUsdcToArs, usdcToArs } from "./fx.js";
import { payoutArsToUser } from "./fiatRail.js";
import {
  getTreasuryAddressAsync,
  getTreasuryBalance,
  sendTreasuryPayout,
} from "./treasury.js";

const MIN_USDC = 0.01;

/**
 * Convertir ARS → USDC:
 * Cotiza con Chainlink y la tesorería envía USDC SPL.
 */
export async function runConvertArsToUsdc({ userAddress, arsAmount, arsBalance }) {
  if (!userAddress) throw new Error("Wallet de usuario no disponible");
  const ars = Number(arsAmount);
  if (!Number.isFinite(ars) || ars <= 0) throw new Error("Ingresá un monto en ARS válido");

  const fxRate = await getArsPerUsdc();
  const usdc = arsToUsdc(ars, fxRate);
  if (usdc < MIN_USDC) throw new Error("El equivalente es menor a 0.01 USDC");

  const treasuryBal = await getTreasuryBalance();
  if (treasuryBal !== null && usdc > treasuryBal) {
    throw new Error(
      `La recaudadora no tiene USDC suficiente (tiene ${treasuryBal.toFixed(2)}, necesita ${usdc.toFixed(2)})`
    );
  }

  const payout = await sendTreasuryPayout({
    to: userAddress,
    usdc,
    ars,
    fxRate,
    kind: "convert_ars_usdc",
  });

  const available = Number(arsBalance || 0);
  if (available > 0 && ars > available) {
    throw new Error(`Saldo ARS insuficiente (tenés $ ${available.toFixed(0)})`);
  }
  const arsDelta = available > 0 ? -ars : 0;

  return {
    kind: "convert_ars_usdc",
    fxRate,
    ars,
    usdc,
    arsDelta,
    hash: payout.hash,
    block: payout.block,
    fee: payout.fee,
    memo: payout.memo,
    factura: payout.factura,
    from: payout.from,
    to: userAddress,
  };
}

function buildConvertUsdcArsMemo({ usdc, ars, fxRate, factura }) {
  return armarMemo({
    inv: factura,
    kind: "convert_usdc_ars",
    cur: "USDC",
    amt: Number(usdc).toFixed(6),
    fx: Number(fxRate).toFixed(2),
    ars: Number(ars).toFixed(2),
  });
}

/** Estimación de fee para Convertir USDC→ARS (firma del usuario). */
export async function estimateConvertUsdcToArs({ from, usdcAmount, fxRate }) {
  const treasury = await getTreasuryAddressAsync();
  if (!treasury) throw new Error("Treasury no configurada. Definí VITE_TREASURY_SECRET_KEY en .env");
  if (!from) throw new Error("Wallet no conectada");

  const usdc = Number(usdcAmount);
  if (!Number.isFinite(usdc) || usdc <= 0) throw new Error("Ingresá un monto en USDC válido");

  const rate = fxRate ?? (await getArsPerUsdc());
  const ars = usdcToArs(usdc, rate);
  const memo = buildConvertUsdcArsMemo({ usdc, ars, fxRate: rate, factura: "estimate" });

  return estimateUsdcTransfer({ from, to: treasury, usdc, memo });
}

/**
 * Convertir USDC → ARS:
 * Usuario envía USDC a la recaudadora; se acredita ARS simulado (fiatRail).
 */
export async function runConvertUsdcToArs({ wallet, signAndSendTransaction, usdcAmount, userUsdcBalance }) {
  const treasury = await getTreasuryAddressAsync();
  if (!treasury) throw new Error("Treasury no configurada. Definí VITE_TREASURY_SECRET_KEY en .env");

  const usdc = Number(usdcAmount);
  if (!Number.isFinite(usdc) || usdc <= 0) throw new Error("Ingresá un monto en USDC válido");
  if (usdc < MIN_USDC) throw new Error("El monto mínimo es 0.01 USDC");
  if (userUsdcBalance !== null && usdc > userUsdcBalance) {
    throw new Error(`Saldo USDC insuficiente (tenés ${Number(userUsdcBalance).toFixed(2)})`);
  }

  const fxRate = await getArsPerUsdc();
  const ars = usdcToArs(usdc, fxRate);
  const factura = nuevaFactura();
  const memo = buildConvertUsdcArsMemo({ usdc, ars, fxRate, factura });

  const tx = await sendUsdc(wallet, signAndSendTransaction, { to: treasury, usdc, memo });
  const fiat = await payoutArsToUser(ars);

  return {
    kind: "convert_usdc_ars",
    fxRate,
    ars,
    usdc,
    arsDelta: ars,
    fiat,
    hash: tx.hash,
    block: tx.block,
    fee: tx.fee,
    memo: tx.memo,
    factura,
    from: wallet.address,
    to: treasury,
  };
}

export async function refreshPairBalances(userAddress) {
  const [userUsdc, treasuryUsdc, treasuryAddress] = await Promise.all([
    getUsdcBalance(userAddress),
    getTreasuryBalance(),
    getTreasuryAddressAsync(),
  ]);
  return { userUsdc, treasuryUsdc, treasuryAddress };
}

export { quoteArsToUsdc, quoteUsdcToArs, getArsPerUsdc };
