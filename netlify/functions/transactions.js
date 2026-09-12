// API del historial de transacciones — puente entre el browser y Postgres
// (Aiven). Mismo patrón que netlify/functions/contacts.js: el browser nunca
// ve la connection string ni el secret de Privy. Ver
// docs/superpowers/specs/2026-08-07-transactions-history-design.md § 1.

import pkg from "pg";
import { PrivyClient } from "@privy-io/server-auth";
import { reconcileWallet } from "./lib/reconcile.js";
import { fetchArsPerUsd } from "../../src/priceFeed.js";

/** Validación liviana de address Solana (base58, sin traer @solana/kit al bundle de la function). */
function isSolanaAddress(value) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

const { Pool } = pkg;

let fxPromise;
const getFxRate = () => (fxPromise ??= fetchArsPerUsd(process.env.VITE_ETH_RPC || "https://ethereum.publicnode.com"));

let pool;
function getPool() {
  if (!pool) {
    const connectionString = (process.env.AIVEN_PG_URL || "").replace(/[?&]sslmode=[^&]*/, "");
    pool = new Pool({
      connectionString,
      ssl: {
        ca: (process.env.AIVEN_PG_CA_CERT || "").replace(/\\n/g, "\n"),
        rejectUnauthorized: true,
        // Ver netlify/functions/contacts.js para el porqué del servername
        // explícito (Aiven decide qué cert presentar según el SNI).
        servername: new URL(connectionString).hostname,
      },
    });
  }
  return pool;
}

let privy;
function getPrivy() {
  if (!privy) {
    privy = new PrivyClient(process.env.VITE_PRIVY_APP_ID, process.env.PRIVY_APP_SECRET);
  }
  return privy;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function authenticate(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const claims = await getPrivy().verifyAuthToken(token);
    return claims.userId;
  } catch {
    return null;
  }
}

const REQUIRED_FIELDS = ["hash", "kind", "direction", "who", "amt", "fx_rate", "ars"];

export const handler = async (event) => {
  const userId = await authenticate(event);
  if (!userId) return json(401, { error: "unauthorized" });

  const db = getPool();

  try {
    if (event.httpMethod === "GET") {
      const address = event.queryStringParameters?.address;
      if (address && isSolanaAddress(address)) {
        // El address viaja en la query del cliente y no está atado a nada —
        // hay que verificar que sea una wallet del propio usuario antes de
        // pisar su fila en `wallets`, o cualquiera podría inyectar el
        // historial de otra persona en su propia cuenta (ver finding #1 del
        // review final). Una address ajena/errónea no debe romper la carga
        // del historial existente — se cae al SELECT normal, como si no se
        // hubiera mandado address.
        let owned = false;
        try {
          const user = await getPrivy().getUser(userId);
          owned = (user.linkedAccounts || []).some(
            (a) => a.type === "wallet" && a.address === address
          );
        } catch {
          owned = false;
        }

        if (owned) {
          await db.query(
            `INSERT INTO wallets (user_id, address, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (user_id) DO UPDATE SET address = EXCLUDED.address, updated_at = now()`,
            [userId, address]
          );
          try {
            const { rows: walletRows } = await db.query("SELECT last_synced_block FROM wallets WHERE user_id = $1", [userId]);
            const newCheckpoint = await reconcileWallet(db, {
              userId,
              address,
              lastSyncedBlock: walletRows[0]?.last_synced_block ?? null,
              getFxRate,
            });
            if (newCheckpoint != null) {
              await db.query("UPDATE wallets SET last_synced_block = $1 WHERE user_id = $2", [newCheckpoint, userId]);
            }
          } catch {
            // Si el RPC de Solana falla acá, no bloquea la carga del historial existente
            // — se reintenta en la próxima apertura o en el próximo tick del job.
          }
        }
      }

      const { rows } = await db.query(
        `SELECT id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo, created_at
         FROM transactions WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      return json(200, { transactions: rows });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const missing = REQUIRED_FIELDS.filter((f) => body[f] === undefined || body[f] === null || body[f] === "");
      if (missing.length > 0) return json(400, { error: "missing_fields" });

      const { rows } = await db.query(
        `INSERT INTO transactions (user_id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (user_id, hash) DO NOTHING
         RETURNING id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo, created_at`,
        [
          userId,
          body.hash,
          body.kind,
          body.direction,
          body.who,
          body.amt,
          body.fx_rate,
          body.ars,
          body.factura ?? null,
          body.block ?? null,
          body.fee ?? null,
          body.memo ?? null,
        ]
      );

      if (rows.length > 0) return json(200, { transaction: rows[0] });

      // (user_id, hash) ya existía (reintento de POST, o el otro lado de un
      // cobro P2P ya insertó su propia fila para este mismo hash) — devolver
      // la fila existente de ESTE usuario en vez de tratarlo como error.
      const existing = await db.query(
        `SELECT id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo, created_at
         FROM transactions WHERE hash = $1 AND user_id = $2`,
        [body.hash, userId]
      );
      if (existing.rows.length === 0) return json(409, { error: "hash_conflict" });
      return json(200, { transaction: existing.rows[0] });
    }

    return json(405, { error: "method_not_allowed" });
  } catch (err) {
    return json(500, { error: "server_error" });
  }
};
