// Firma y envío de USDC SPL desde la recaudadora (solo server-side).
// La secret key NUNCA sale del proceso de la Function.

import {
  address,
  assertIsAddress,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  fetchMaybeToken,
} from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";
import bs58 from "bs58";
import { NETWORK } from "../../../src/network.js";
import { PaymentError } from "./paymentCore.js";

const USDC_MINT = NETWORK.mint;
const USDC_DECIMALS = 6;

const RPC_URL =
  process.env.SOLANA_RPC || process.env.VITE_SOLANA_RPC || NETWORK.rpc;

function treasurySecret() {
  // Only private server environment names are accepted.
  return (
    process.env.TREASURY_SECRET_KEY ||
    process.env.TREASURY_PRIVATE_KEY ||
    ""
  ).trim();
}

export function isTreasuryConfigured() {
  return treasurySecret().length >= 32;
}

async function keypairSignerFromSecret(secret) {
  const raw = String(secret || "").trim();
  if (!raw) throw new Error("Secret key vacía");
  let bytes;
  if (raw.startsWith("[")) {
    bytes = Uint8Array.from(JSON.parse(raw));
  } else {
    bytes = bs58.decode(raw);
  }
  if (bytes.length === 64) {
    return createKeyPairSignerFromBytes(bytes);
  }
  if (bytes.length === 32) {
    const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
    return createKeyPairSignerFromPrivateKeyBytes(bytes);
  }
  throw new Error("Secret key Solana inválida (esperaba 32 o 64 bytes)");
}

let cachedSignerPromise = null;

export async function getTreasurySigner() {
  if (!isTreasuryConfigured()) {
    throw new PaymentError("treasury_not_configured");
  }
  if (!cachedSignerPromise) {
    cachedSignerPromise = keypairSignerFromSecret(treasurySecret()).catch(()=>{
      cachedSignerPromise=null;
      throw new PaymentError("invalid_treasury_secret_key");
    });
  }
  return cachedSignerPromise;
}

function usdcToRaw(usdc) {
  const n = Number(usdc);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Monto inválido");
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

function rawToUsdc(raw) {
  return Number(raw) / 10 ** USDC_DECIMALS;
}

/** JSON.stringify no soporta BigInt (slots/fees de @solana/kit). */
function toJsonNumber(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nuevaFactura() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `${ymd}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

function armarMemo(parts) {
  const body = Object.entries(parts)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
  return `MIDATO|v1|${body}`;
}

async function withRetry(fn, tries = 4) {
  let wait = 1200;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      const m = String(e?.message || e);
      const limited =
        m.includes("429") ||
        m.includes("Too Many Requests") ||
        m.includes("rate limit") ||
        m.includes("-32429");
      if (!limited || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

function getRpc() {
  return createSolanaRpc(RPC_URL);
}

export async function getTreasuryAddress() {
  if (!isTreasuryConfigured()) return null;
  try {
    const signer = await getTreasurySigner();
    return signer.address;
  } catch {
    return null;
  }
}

export async function getTreasuryBalance() {
  const owner = await getTreasuryAddress();
  if (!owner) return null;
  const rpc = getRpc();
  const [ata] = await findAssociatedTokenPda({
    mint: address(USDC_MINT),
    owner: address(owner),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const account = await withRetry(() => fetchMaybeToken(rpc, ata));
  if (!account.exists) return 0;
  return rawToUsdc(account.data.amount);
}

async function waitForSignature(rpc, sig, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await withRetry(() =>
      rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send()
    );
    const st = res?.value?.[0];
    if (st?.err) throw new Error(`Tx falló on-chain: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      let fee = null;
      try {
        const tx = await rpc
          .getTransaction(sig, {
            encoding: "json",
            maxSupportedTransactionVersion: 1,
            commitment: "confirmed",
          })
          .send();
        fee = tx?.meta?.fee ?? null;
        return { slot: toJsonNumber(tx?.slot ?? st.slot), fee: toJsonNumber(fee) };
      } catch {
        return { slot: toJsonNumber(st.slot), fee: null };
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

export async function prepareTreasuryPayout({ to, usdc, rawAmount, kind, ars, fiatAmount, currency = 'ARS', fxRate, factura: facturaIn }) {
  assertIsAddress(to);
  const signer = await getTreasurySigner();
  const from = signer.address;
  const amount = rawAmount ? BigInt(rawAmount) : usdcToRaw(usdc);
  const mint = address(USDC_MINT);
  const owner = address(from);
  const destinationOwner = address(to);

  const [sourceAta] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [destAta] = await findAssociatedTokenPda({
    mint,
    owner: destinationOwner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const factura = facturaIn || nuevaFactura();
  const memo = armarMemo({
    inv: factura,
    kind,
    cur: currency,
    amt: fiatAmount ?? ars,
    fx: Number(fxRate).toFixed(2),
    usdc: Number(usdc).toFixed(6),
  });

  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      ata: destAta,
      owner: destinationOwner,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    getTransferCheckedInstruction({
      source: sourceAta,
      mint,
      destination: destAta,
      authority: signer,
      amount,
      decimals: USDC_DECIMALS,
    }),
    getAddMemoInstruction({
      memo: String(memo),
      signers: [signer],
    }),
  ];

  const rpc = getRpc();
  const { value: latestBlockhash } = await withRetry(() => rpc.getLatestBlockhash({commitment:"confirmed"}).send());

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx)
  );

  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const hash = getSignatureFromTransaction(signed);

  return { wire, hash: String(hash), lastValidBlockHeight: String(latestBlockhash.lastValidBlockHeight), memo, factura,
    from: String(from), to: String(to), usdc: rawToUsdc(amount), ars: Number(ars), fxRate: Number(fxRate), kind };
}

// Only used by the devnet demo. Production jobs persist the prepared wire first.
export async function sendTreasuryPayout(options) {
  if (NETWORK.cluster !== "devnet") throw new Error("direct_treasury_payout_disabled");
  const prepared = await prepareTreasuryPayout(options);
  const { wire, hash, memo, factura, from, to, usdc, ars, fxRate, kind } = prepared;
  const rpc = getRpc();

  await withRetry(() =>
    rpc
      .sendTransaction(wire, {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
      })
      .send()
  );

  let block = null;
  let fee = null;
  try {
    const status = await waitForSignature(rpc, hash, 45_000);
    block = status?.slot ?? null;
    fee = status?.fee != null ? String(Number(status.fee) / 1e9) : null;
  } catch {
    /* ok */
  }

  return {
    hash: String(hash),
    block: toJsonNumber(block),
    fee,
    memo,
    factura,
    from: String(from),
    to: String(to),
    usdc: Number(usdc),
    ars: Number(ars),
    fxRate: Number(fxRate),
    kind,
  };
}

export async function treasuryRpc(method, params) {
  try {
    const response = await fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok || body.error || body.result==null) throw new PaymentError("solana_rpc_unavailable");
    return body.result;
  } catch(error) {
    if(error instanceof PaymentError)throw error;
    throw new PaymentError(["TimeoutError","AbortError"].includes(error.name)?"solana_rpc_timeout":"solana_rpc_unavailable");
  }
}
export async function treasuryLiquidity(adapters = {}) {
  const owner = await (adapters.getTreasuryAddress || getTreasuryAddress)();
  if (!owner) throw new PaymentError("treasury_not_configured");
  const rpc=adapters.rpc || treasuryRpc,network=adapters.network || NETWORK;
  const [tokens, sol, genesis] = await Promise.all([
    rpc("getTokenAccountsByOwner", [owner, { mint: network.mint }, { encoding: "jsonParsed", commitment: "finalized" }]),
    rpc("getBalance", [owner, { commitment: "finalized" }]),
    rpc("getGenesisHash", []),
  ]);
  if (genesis !== network.genesis) throw new PaymentError("solana_rpc_network_mismatch");
  const [ata] = await findAssociatedTokenPda({ mint: address(network.mint), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const account = tokens.value?.find((t) => t.pubkey === String(ata));
  return { owner, raw: account?.account?.data?.parsed?.info?.tokenAmount?.amount || "0", solLamports: String(sol.value) };
}
