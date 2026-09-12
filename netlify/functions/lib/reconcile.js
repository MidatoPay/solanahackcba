// Reconciliación compartida: trae transferencias USDC (SPL) entrantes vía RPC
// de Solana para una address y las inserta en `transactions` si faltan.
// Usado por reconcile-wallets.js (job) y transactions.js (GET).

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MAX_SIGS_FIRST_SYNC = 40;

function rpcUrl() {
  return process.env.VITE_SOLANA_RPC || process.env.VITE_ARC_RPC || "https://api.devnet.solana.com";
}

async function rpcCall(method, params) {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`solana_rpc_http_${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "solana_rpc_error");
  return json.result;
}

/** ATA PDA (mismo algoritmo que Associated Token Program). */
async function findAta(owner) {
  // En Node usamos getProgramAccounts filter como fallback; para ATA canónico
  // pedimos getTokenAccountsByOwner y tomamos el de USDC.
  const result = await rpcCall("getTokenAccountsByOwner", [
    owner,
    { mint: USDC_MINT },
    { encoding: "jsonParsed" },
  ]);
  const value = result?.value || [];
  if (value.length === 0) return null;
  return value[0].pubkey;
}

export function decodeMemo(text) {
  if (!text) return null;
  if (text.includes("\u0000") || text.includes("�")) return null;
  if (!text.startsWith("MIDATO|v1|")) return { text, fields: null };
  const fields = {};
  for (const part of text.split("|").slice(2)) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    fields[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return { text, fields };
}

function extractMemo(tx) {
  const ixs = tx?.transaction?.message?.instructions || [];
  for (const ix of ixs) {
    if (ix.program === "spl-memo" || ix.parsed?.type === "memo") {
      return String(ix.parsed?.info?.memo || ix.parsed || "");
    }
  }
  for (const group of tx?.meta?.innerInstructions || []) {
    for (const ix of group.instructions || []) {
      if (ix.program === "spl-memo" || ix.parsed?.type === "memo") {
        return String(ix.parsed?.info?.memo || "");
      }
    }
  }
  return null;
}

function usdcReceivedByOwner(tx, owner) {
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const preHit = pre.find((b) => b.mint === USDC_MINT && b.owner === owner);
  const postHit = post.find((b) => b.mint === USDC_MINT && b.owner === owner);
  if (!postHit) return 0;
  const postAmt = Number(postHit.uiTokenAmount?.uiAmount ?? 0);
  const preAmt = Number(preHit?.uiTokenAmount?.uiAmount ?? 0);
  return Math.max(0, postAmt - preAmt);
}

function counterparty(tx, owner) {
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const all = [...pre, ...post];
  const other = all.find((b) => b.mint === USDC_MINT && b.owner && b.owner !== owner);
  return other?.owner || null;
}

/**
 * @param {import('pg').Pool} db
 * @param {{ userId: string, address: string, lastSyncedBlock: number|null, getFxRate: () => Promise<number> }} opts
 * @returns {Promise<number|null>} nuevo last_synced_block (slot)
 */
export async function reconcileWallet(db, { userId, address, lastSyncedBlock, getFxRate }) {
  const ata = await findAta(address);
  if (!ata) return lastSyncedBlock;

  const sigs = await rpcCall("getSignaturesForAddress", [
    ata,
    { limit: lastSyncedBlock == null ? MAX_SIGS_FIRST_SYNC : 25 },
  ]);
  if (!Array.isArray(sigs) || sigs.length === 0) return lastSyncedBlock;

  let maxSlotSeen = lastSyncedBlock ?? null;

  for (const s of sigs) {
    if (s.err) continue;
    if (lastSyncedBlock != null && s.slot <= lastSyncedBlock) continue;

    try {
      const tx = await rpcCall("getTransaction", [
        s.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
      ]);
      if (!tx) continue;

      const usdc = usdcReceivedByOwner(tx, address);
      if (!(usdc > 0)) continue;

      const memoText = extractMemo(tx);
      const decoded = decodeMemo(memoText);
      const fields = decoded?.fields ?? null;

      let kind = "received";
      let factura = null;
      let ars = null;
      let fxRate;

      if (fields && fields.kind) {
        kind = String(fields.kind).slice(0, 32);
        factura = fields.inv ? String(fields.inv).slice(0, 64) : null;
        if (fields.cur === "ARS" && fields.amt) {
          const parsedArs = Number(fields.amt);
          if (Number.isFinite(parsedArs) && parsedArs > 0) {
            ars = parsedArs;
            fxRate = ars / usdc;
          }
        }
      }
      if (ars == null) {
        fxRate = await getFxRate();
        ars = usdc * fxRate;
      }

      const from = counterparty(tx, address);
      let who = from ? `${from.slice(0, 4)}…${from.slice(-4)}` : "—";
      if (from) {
        const contact = await db.query(
          "SELECT name FROM contacts WHERE user_id = $1 AND address = $2 LIMIT 1",
          [userId, from]
        );
        if (contact.rows[0]?.name) who = contact.rows[0].name;
      }

      const createdAt = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null;

      await db.query(
        `INSERT INTO transactions (user_id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo, created_at)
         VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8, $9, NULL, $10, COALESCE($11::timestamptz, now()))
         ON CONFLICT (user_id, hash) DO NOTHING`,
        [userId, s.signature, kind, who, usdc, fxRate, ars, factura, s.slot, memoText, createdAt]
      );

      if (maxSlotSeen == null || s.slot > maxSlotSeen) maxSlotSeen = s.slot;
    } catch (err) {
      console.error(`Failed to process signature ${s.signature || "unknown"}:`, err);
      continue;
    }
  }

  return maxSlotSeen;
}

// Silencia unused imports warning if tree-shaken elsewhere
void TOKEN_PROGRAM;
void ASSOCIATED_TOKEN_PROGRAM;
