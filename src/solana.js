import {
  address,
  assertIsAddress,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionEncoder,
  isAddress,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
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
import { RPC_PROXY, SOLANA, USDC_MINT, USDC_DECIMALS } from "./chain.js";

export const rpc = createSolanaRpc(RPC_PROXY);

export { isAddress };

export async function withRetry(fn, tries = 4) {
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

export function nuevaFactura() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `${ymd}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

export function armarMemo(parts) {
  const body = Object.entries(parts)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
  return `MIDATO|v1|${body}`;
}

export function usdcToRaw(usdc) {
  const n = Number(usdc);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Monto inválido");
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

export function rawToUsdc(raw) {
  return Number(raw) / 10 ** USDC_DECIMALS;
}

export async function getAtaAddress(owner) {
  assertIsAddress(owner);
  const [ata] = await findAssociatedTokenPda({
    mint: address(USDC_MINT),
    owner: address(owner),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

/** Balance USDC (SPL, 6 decimals) como número. */
export async function getUsdcBalance(owner) {
  if (!owner || !isAddress(owner)) return null;
  const ata = await getAtaAddress(owner);
  const account = await withRetry(() => fetchMaybeToken(rpc, ata));
  if (!account.exists) return 0;
  return rawToUsdc(account.data.amount);
}

async function buildUsdcTransferInstructions({ from, to, usdc, memo, authoritySigner }) {
  assertIsAddress(from);
  assertIsAddress(to);
  const amount = usdcToRaw(usdc);
  const mint = address(USDC_MINT);
  const owner = address(from);
  const destinationOwner = address(to);
  const source = authoritySigner || createNoopSigner(owner);

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

  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: source,
      ata: destAta,
      owner: destinationOwner,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    getTransferCheckedInstruction({
      source: sourceAta,
      mint,
      destination: destAta,
      authority: source,
      amount,
      decimals: USDC_DECIMALS,
    }),
  ];

  if (memo) {
    instructions.push(
      getAddMemoInstruction({
        memo: String(memo),
        signers: [source],
      })
    );
  }

  return { instructions, sourceAta, destAta, amount };
}

/**
 * Codifica una tx USDC lista para que Privy (u otro wallet) firme y envíe.
 * @returns {Promise<Uint8Array>}
 */
export async function buildUsdcTransferBytes({ from, to, usdc, memo }) {
  const { instructions } = await buildUsdcTransferInstructions({ from, to, usdc, memo });
  const { value: latestBlockhash } = await withRetry(() => rpc.getLatestBlockhash().send());

  const compiled = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(address(from), tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => compileTransaction(tx)
  );

  return new Uint8Array(getTransactionEncoder().encode(compiled));
}

/**
 * Estima fee de una transferencia SPL USDC en Solana (fee en SOL, no en USDC).
 */
export async function estimateUsdcTransfer({ from, to, usdc, memo }) {
  if (!from) throw new Error("Wallet no conectada");
  if (!to || !isAddress(to)) throw new Error("Destinatario inválido");
  if (!Number.isFinite(Number(usdc)) || Number(usdc) <= 0) throw new Error("Monto inválido");

  const { instructions, destAta } = await buildUsdcTransferInstructions({ from, to, usdc, memo });
  const destToken = await withRetry(() => fetchMaybeToken(rpc, destAta));
  const needsAta = !destToken.exists;

  // Base fee ~5000 lamports/firma; crear ATA suma rent ~exempto ~2M lamports.
  const signatures = 1;
  const baseLamports = 5000n * BigInt(signatures);
  const ataRentLamports = needsAta ? 2_039_280n : 0n;
  const feeLamports = baseLamports + ataRentLamports;
  const feeNative = Number(feeLamports) / 1e9;

  // SOL≈USD aproximado solo para display; no es un oracle on-chain.
  const solUsdApprox = 150;
  const feeUsd = feeNative * solUsdApprox;

  return {
    gasLimit: BigInt(instructions.length),
    gasPrice: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    effectiveGasPrice: null,
    feeWei: feeLamports,
    feeNative,
    feeUsd,
    eip1559: false,
    nativeSymbol: "SOL",
    gasPriceGwei: null,
    maxFeePerGasGwei: null,
    maxPriorityFeePerGasGwei: null,
    needsAta,
    instructionCount: instructions.length,
  };
}

/** Alias de compatibilidad con el nombre anterior (UI / flows). */
export const estimateNativeUsdcTransfer = estimateUsdcTransfer;

/**
 * Firma y envía USDC con wallet Privy Solana (`signAndSendTransaction`).
 * @param {{ address: string }} wallet
 * @param {(args: { transaction: Uint8Array, wallet: unknown }) => Promise<{ signature?: string } | string | Uint8Array>} signAndSendTransaction
 */
export async function sendUsdc(wallet, signAndSendTransaction, { to, usdc, memo }) {
  if (!wallet?.address) throw new Error("Wallet no conectada");
  if (typeof signAndSendTransaction !== "function") {
    throw new Error("signAndSendTransaction no disponible");
  }

  const transaction = await buildUsdcTransferBytes({
    from: wallet.address,
    to,
    usdc,
    memo,
  });

  const result = await withRetry(() =>
    signAndSendTransaction({
      transaction,
      wallet,
      chain: "solana:devnet",
    })
  );

  const hash = normalizeSignature(result);
  let block = null;
  let fee = null;
  try {
    const status = await waitForSignature(hash, 45_000);
    block = status?.slot ?? null;
    fee = status?.fee != null ? String(Number(status.fee) / 1e9) : null;
  } catch {
    /* la tx ya se envió */
  }
  return { hash, block, fee, memo: memo || null };
}

/** Compat: mismo shape que sendNativeUsdc, pero requiere signAndSend como 2º arg. */
export async function sendNativeUsdc(walletOrSigner, signAndSendOrOpts, maybeOpts) {
  // sendNativeUsdc(wallet, signAndSend, opts)  — flujo Privy
  if (typeof signAndSendOrOpts === "function") {
    return sendUsdc(walletOrSigner, signAndSendOrOpts, maybeOpts);
  }
  // sendNativeUsdc(keyPairSigner, opts) — tesorería con KeyPairSigner
  return sendUsdcWithKeypair(walletOrSigner, signAndSendOrOpts);
}

function normalizeSignature(result) {
  if (!result) throw new Error("Sin signature");
  if (typeof result === "string") return result;
  if (result.signature) {
    if (typeof result.signature === "string") return result.signature;
    if (result.signature instanceof Uint8Array) return bs58.encode(result.signature);
  }
  if (result instanceof Uint8Array) return bs58.encode(result);
  throw new Error("Signature inválida");
}

async function waitForSignature(sig, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await withRetry(() =>
      rpc
        .getSignatureStatuses([sig], { searchTransactionHistory: true })
        .send()
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
        return { slot: tx?.slot ?? st.slot ?? null, fee };
      } catch {
        return { slot: st.slot ?? null, fee };
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

/**
 * Envía USDC firmando con un KeyPairSigner local (tesorería).
 */
export async function sendUsdcWithKeypair(signer, { to, usdc, memo }) {
  const from = signer.address;
  const { instructions } = await buildUsdcTransferInstructions({
    from,
    to,
    usdc,
    memo,
    authoritySigner: signer,
  });
  const { value: latestBlockhash } = await withRetry(() => rpc.getLatestBlockhash().send());

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx)
  );

  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const hash = getSignatureFromTransaction(signed);

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
    const status = await waitForSignature(hash, 45_000);
    block = status?.slot ?? null;
    fee = status?.fee != null ? String(Number(status.fee) / 1e9) : null;
  } catch {
    /* ok */
  }
  return { hash, block, fee, memo: memo || null };
}

export async function keypairSignerFromSecret(secret) {
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

/**
 * Busca una transferencia SPL USDC entrante reciente a `address`.
 * Preferencia por memo con `inv:<factura>` si hay varios candidatos.
 */
export async function findIncomingTransfer({ address: owner, factura, lookback = 20 }) {
  if (!owner || !isAddress(owner)) return null;
  const ata = await getAtaAddress(owner);
  const sigs = await withRetry(() =>
    rpc.getSignaturesForAddress(ata, { limit: lookback }).send()
  );
  if (!sigs?.length) return null;

  const candidates = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await withRetry(() =>
      rpc
        .getTransaction(s.signature, {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 1,
          commitment: "confirmed",
        })
        .send()
    );
    if (!tx) continue;

    const memoText = extractMemoFromTx(tx);
    const received = extractUsdcReceived(tx, ata);
    if (!(received > 0)) continue;

    candidates.push({
      hash: s.signature,
      block: tx.slot,
      fee: tx.meta?.fee != null ? String(Number(tx.meta.fee) / 1e9) : null,
      memo: memoText,
      usdc: received,
    });
  }

  if (candidates.length === 0) return null;

  let chosen = candidates[0];
  if (candidates.length > 1 && factura) {
    const matching = candidates.find((c) => (c.memo || "").includes(`inv:${factura}`));
    if (matching) chosen = matching;
  }
  return chosen;
}

function extractMemoFromTx(tx) {
  try {
    const ixs = tx?.transaction?.message?.instructions || [];
    for (const ix of ixs) {
      if (ix.parsed?.type === "memo" || ix.program === "spl-memo") {
        return String(ix.parsed?.info?.memo || ix.parsed || "");
      }
      if (typeof ix.data === "string" && ix.programId === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") {
        try {
          return Buffer.from(bs58.decode(ix.data)).toString("utf8");
        } catch {
          /* ignore */
        }
      }
    }
    const inner = tx?.meta?.innerInstructions || [];
    for (const group of inner) {
      for (const ix of group.instructions || []) {
        if (ix.parsed?.type === "memo" || ix.program === "spl-memo") {
          return String(ix.parsed?.info?.memo || "");
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractUsdcReceived(tx, ataAddress) {
  const ata = String(ataAddress);
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const preAmt = tokenBalAmount(pre, ata, tx);
  const postAmt = tokenBalAmount(post, ata, tx);
  if (postAmt == null) return 0;
  return Math.max(0, postAmt - (preAmt || 0));
}

function accountKeysMatch(tx, bal, ata) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const key = keys[bal.accountIndex];
  const pubkey = typeof key === "string" ? key : key?.pubkey;
  return pubkey === ata;
}

function tokenBalAmount(balances, ata, tx) {
  const hit = (balances || []).find((b) => b.mint === USDC_MINT && accountKeysMatch(tx, b, ata));
  if (!hit) return null;
  const ui = hit.uiTokenAmount?.uiAmount;
  if (ui != null) return Number(ui);
  if (hit.uiTokenAmount?.amount != null) return rawToUsdc(BigInt(hit.uiTokenAmount.amount));
  return null;
}

/** Ya no hay signer EVM — la UI pasa el wallet Privy + hook. */
export async function getBrowserSigner() {
  throw new Error("Usá sendUsdc(wallet, signAndSendTransaction, opts) en Solana");
}
