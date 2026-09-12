import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

// Lecturas van por el proxy local de Vite/Netlify (ver vite.config.js) para
// evitar CORS del navegador contra el RPC de Solana.
export const RPC_PROXY =
  typeof window !== "undefined" ? `${window.location.origin}/rpc` : "https://api.devnet.solana.com";

export const WSS_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_SOLANA_WSS) ||
  "wss://api.devnet.solana.com";

/** Circle USDC en Solana Devnet (mint + Token Program clásico). Nunca por símbolo. */
export const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_DECIMALS = 6;

export const SOLANA = {
  cluster: "devnet",
  explorer: "https://explorer.solana.com",
  faucet: "https://faucet.circle.com",
  usdcMint: USDC_MINT,
  usdcDecimals: USDC_DECIMALS,
};

export function explorerAddressUrl(address) {
  return `${SOLANA.explorer}/address/${address}?cluster=${SOLANA.cluster}`;
}

export function explorerTxUrl(signature) {
  return `${SOLANA.explorer}/tx/${signature}?cluster=${SOLANA.cluster}`;
}

export function createAppRpc() {
  return createSolanaRpc(RPC_PROXY);
}

export function createAppRpcSubscriptions() {
  return createSolanaRpcSubscriptions(WSS_URL);
}
