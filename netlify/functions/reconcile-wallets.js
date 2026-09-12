// Job de reconciliación: corre cada 15 min (ver netlify.toml), recorre
// todas las wallets conocidas y reconcilia cada una contra el RPC de Solana.
// No requiere auth — lo dispara el scheduler de Netlify.

import pkg from "pg";
import { reconcileWallet } from "./lib/reconcile.js";
import { fetchArsPerUsd } from "../../src/priceFeed.js";

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
        servername: new URL(connectionString).hostname,
      },
    });
  }
  return pool;
}

export const handler = async () => {
  const db = getPool();
  const { rows: wallets } = await db.query("SELECT user_id, address, last_synced_block FROM wallets");

  let ok = 0;
  let failed = 0;
  for (const w of wallets) {
    try {
      const newCheckpoint = await reconcileWallet(db, {
        userId: w.user_id,
        address: w.address,
        lastSyncedBlock: w.last_synced_block,
        getFxRate,
      });
      if (newCheckpoint != null) {
        await db.query("UPDATE wallets SET last_synced_block = $1, updated_at = now() WHERE user_id = $2", [newCheckpoint, w.user_id]);
      }
      ok++;
    } catch (err) {
      // Una wallet que falla (RPC caído, address rara) no debe frenar
      // el resto — se reintenta sola en la próxima corrida, 15 min después.
      console.error(`reconcile failed for ${w.user_id}:`, err);
      failed++;
    }
  }

  console.log(`reconcile-wallets: ${ok} ok, ${failed} failed, ${wallets.length} total`);
  return { statusCode: 200, body: JSON.stringify({ ok, failed, total: wallets.length }) };
};
