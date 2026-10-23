import { createSolanaRpc, createSolanaRpcFromTransport, createDefaultRpcTransport, createSolanaRpcSubscriptions } from "@solana/kit";
import { NETWORK } from "./network.js";
import { rpcAccessToken } from './rpcSession.js';
import {securityHeaders,securitySnapshot} from './securitySession.js';

// Lecturas van por el proxy local de Vite/Netlify (ver vite.config.js) para
// evitar CORS del navegador contra el RPC de Solana.
export const RPC_PROXY =
  typeof window !== "undefined" ? `${window.location.origin}/rpc` : NETWORK.rpc;

export const WSS_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_SOLANA_WSS) ||
  NETWORK.wss;

/** Circle USDC en Solana Devnet (mint + Token Program clásico). Nunca por símbolo. */
export const USDC_MINT = NETWORK.mint;
export const USDC_DECIMALS = 6;

export const SOLANA = {
  cluster: NETWORK.cluster,
  chain: NETWORK.chain,
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
  if(typeof window==='undefined')return createSolanaRpc(RPC_PROXY);
  let previousToken,transport;
  return createSolanaRpcFromTransport(async request=>{
    if(!securitySnapshot().credential)throw new Error('app_locked');
    if(typeof document!=='undefined' && (document.visibilityState!=='visible' || !document.hasFocus()))throw new Error('app_inactive');
    const epoch=securitySnapshot().epoch;
    const token=await rpcAccessToken();
    if(securitySnapshot().epoch!==epoch)throw new Error('app_locked');
    if(previousToken!==token+':'+epoch) {
      previousToken=token+':'+epoch;
      transport=createDefaultRpcTransport({url:RPC_PROXY,headers:{Authorization:`Bearer ${token}`,...securityHeaders()}});
    }
    const result=await transport(request);
    if(securitySnapshot().epoch!==epoch)throw new Error('app_locked');
    return result;
  });
}

export function createAppRpcSubscriptions() {
  return createSolanaRpcSubscriptions(WSS_URL);
}
