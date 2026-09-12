# Background Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap where a payment received while the collector's screen is closed (or the app is off) never gets recorded — by reconciling incoming USDC transfers from ArcScan's Blockscout API, both via a Netlify Scheduled Function (every 15 min, all known wallets) and on every app reopen (piggybacked on the existing `GET /transactions` load-on-mount call, scoped to just that user's own wallet).

**Architecture:** New `wallets(user_id, address, last_synced_block)` table maps a Privy user to their embedded wallet address, populated by `GET /transactions?address=...`. A shared module (`netlify/functions/lib/reconcile.js`) fetches new incoming transfers for one address from ArcScan (`/api/v2/addresses/{address}/transactions?filter=to`), decodes the `MIDATO|v1|...` memo when present to recover `kind`/`factura`/`ars`, and inserts missing rows via the same `ON CONFLICT (user_id, hash) DO NOTHING` pattern already used by `POST /transactions`. Two callers use it: `reconcile-wallets.js` (scheduled, loops all wallets) and `transactions.js`'s `GET` handler (one wallet, before the `SELECT`).

**Tech Stack:** Netlify Functions (V1 `exports.handler` style, esbuild bundler — matches the rest of this repo), Netlify Scheduled Functions (`netlify.toml` cron syntax), global `fetch` (already used unimported in `eth-rpc.js`, confirms Node 18+ runtime), Aiven Postgres, ArcScan's Blockscout v2 API (verified live against `testnet.arcscan.app`). No test runner in this repo — verification is a mix of pure-function node one-liners, `netlify functions:invoke` for the scheduled job (its schedule never fires under `netlify functions:serve`), and a direct node+`pg` script against the live Aiven DB for schema changes.

## Global Constraints

- No test framework may be introduced (`CLAUDE.md`: "There is no lint script, no test runner, and no test files in this repo").
- No new env vars, no new npm dependencies — `fetch` is a global in this Netlify Functions runtime (already relied on, unimported, in `netlify/functions/eth-rpc.js`), and `ethers`/`pg` are already project dependencies.
- The reconciliation module lives at `netlify/functions/lib/reconcile.js` — the `lib/` subfolder is deliberate: Netlify's function discovery only registers top-level files directly under `netlify/functions/*.js` (or a `<name>/<name>.js` folder-function pair), so a nested `lib/` folder is never picked up as its own route, only reachable via `import`.
- `fxRate` for a reconciled transaction is reconstructed from the memo's own `ars`/`amt` field divided by the real on-chain `usdc` value when available (`cur:ARS` in the memo) — **not** a live rate fetched at reconciliation time, since the job can run up to 15 minutes after the payment actually settled. Live rate (`fetchArsPerUsd`) is only the fallback when the memo carries no ARS figure (memo-less external transfer, or a USDC-denominated send).
- Server-side FX reads reuse `src/priceFeed.js`'s `fetchArsPerUsd(rpcUrl)` directly (it already takes the RPC URL as a parameter and never touches `window`) — no duplicate Chainlink-reading module.
- Spec reference: `docs/superpowers/specs/2026-08-08-background-reconciliation-design.md`.

---

## File Structure

- **Modify** `db/schema.sql` — add the `wallets` table.
- **Create** `netlify/functions/lib/reconcile.js` — `decodeMemo` (exported, pure) + `reconcileWallet` (exported, DB + ArcScan I/O). Not a route.
- **Create** `netlify/functions/reconcile-wallets.js` — scheduled job, loops all wallets.
- **Modify** `netlify.toml` — add the `[functions."reconcile-wallets"]` schedule block.
- **Modify** `netlify/functions/transactions.js` — `GET` handler upserts `wallets` and calls `reconcileWallet` before the existing `SELECT`.
- **Modify** `src/transactions.js` — `loadTransactions` gains an `address` parameter, sent as a query param.
- **Modify** `src/App.jsx` — the transactions-loading effect passes `address` through and depends on it (covers the async-wallet-creation race: the effect re-fires once `address` stops being empty).

---

### Task 1: `wallets` table in Postgres

**Files:**
- Modify: `db/schema.sql`

**Interfaces:**
- Produces: the `wallets` table (`user_id` PK, `address`, `last_synced_block`), consumed by Task 2's `reconcileWallet` and Task 4's `GET /transactions`.

- [ ] **Step 1: Append to `db/schema.sql`, after the existing P2P-charge migration block**

```sql

-- Mapeo user_id (Privy DID) -> address de su wallet embebida, con
-- checkpoint de reconciliación de fondo. Ver
-- docs/superpowers/specs/2026-08-08-background-reconciliation-design.md § 1.

CREATE TABLE IF NOT EXISTS wallets (
  user_id            TEXT PRIMARY KEY,     -- Privy DID (una wallet por usuario, embedded wallet)
  address            TEXT NOT NULL,
  last_synced_block  BIGINT,               -- checkpoint: bloque más alto ya reconciliado
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallets_address_idx ON wallets (address);
```

- [ ] **Step 2: Run it against the live Aiven DB and verify**

```bash
cat > _run-schema-tmp.mjs << 'EOF'
import { readFileSync } from "fs";
import pkg from "pg";
const { Pool } = pkg;

const envText = readFileSync(".env", "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    env[m[1]] = v;
  }
}

const connectionString = (env.AIVEN_PG_URL || "").replace(/[?&]sslmode=[^&]*/, "");
const pool = new Pool({
  connectionString,
  ssl: {
    ca: (env.AIVEN_PG_CA_CERT || "").replace(/\\n/g, "\n"),
    rejectUnauthorized: true,
    servername: new URL(connectionString).hostname,
  },
});

const schema = readFileSync("db/schema.sql", "utf8");
await pool.query(schema);

const cols = await pool.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'wallets' ORDER BY ordinal_position"
);
console.log("wallets columns:", cols.rows.map((r) => r.column_name));
await pool.end();
EOF
node _run-schema-tmp.mjs
rm -f _run-schema-tmp.mjs
```

Expected output:
```
wallets columns: [ 'user_id', 'address', 'last_synced_block', 'updated_at' ]
```

- [ ] **Step 3: Commit**

```bash
git add db/schema.sql
git commit -m "Add wallets table for background reconciliation checkpoints"
```

---

### Task 2: `netlify/functions/lib/reconcile.js` — shared reconciliation module

**Files:**
- Create: `netlify/functions/lib/reconcile.js`

**Interfaces:**
- Produces: `decodeMemo(rawInputHex) -> { text, fields } | null` (exported, pure — `fields` is `{inv, to, cur, amt, kind}` or `null` if the text isn't `MIDATO|v1|...`), `reconcileWallet(db, { userId, address, lastSyncedBlock, getFxRate }) -> Promise<number|null>` (exported — returns the new checkpoint, or `null` if nothing new was found). Consumed by Task 3 (`reconcile-wallets.js`) and Task 4 (`transactions.js`).

- [ ] **Step 1: Write `netlify/functions/lib/reconcile.js`**

```js
// Reconciliación compartida: trae transferencias USDC entrantes de ArcScan
// (Blockscout) para una address y las inserta en `transactions` si faltan.
// Usado por netlify/functions/reconcile-wallets.js (job) y
// netlify/functions/transactions.js (GET, al reabrir). No es una ruta —
// vive en lib/ a propósito, ver docs/superpowers/specs/2026-08-08-
// background-reconciliation-design.md § 2.

const ARCSCAN_API = "https://testnet.arcscan.app/api/v2";
const MAX_PAGES_FIRST_SYNC = 3; // ~150 txs — acota el costo del primer sync de una wallet nueva

/**
 * Decodifica raw_input (hex) a { text, fields }. fields es null si el
 * texto no matchea el formato MIDATO|v1|... (el texto se guarda igual, si
 * es UTF-8 válido, para no perder referencia de un memo no reconocido).
 * Devuelve null si raw_input está vacío o no es UTF-8 válido.
 */
export function decodeMemo(rawInputHex) {
  if (!rawInputHex || rawInputHex === "0x") return null;
  let text;
  try {
    text = Buffer.from(rawInputHex.slice(2), "hex").toString("utf8");
  } catch {
    return null;
  }
  if (!text.startsWith("MIDATO|v1|")) return { text, fields: null };
  const fields = {};
  for (const part of text.split("|").slice(2)) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    fields[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return { text, fields };
}

async function fetchArcScanPage(address, params) {
  const url = new URL(`${ARCSCAN_API}/addresses/${address}/transactions`);
  url.searchParams.set("filter", "to");
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arcscan_http_${res.status}`);
  return res.json();
}

/**
 * Reconcilia una wallet: trae páginas de ArcScan (más nuevo primero) hasta
 * llegar a lastSyncedBlock (o hasta MAX_PAGES_FIRST_SYNC si no hay
 * checkpoint), inserta lo que falte, devuelve el nuevo checkpoint.
 *
 * @param {import('pg').Pool} db
 * @param {{ userId: string, address: string, lastSyncedBlock: number|null, getFxRate: () => Promise<number> }} opts
 * @returns {Promise<number|null>} nuevo last_synced_block (null si no hubo nada que procesar)
 */
export async function reconcileWallet(db, { userId, address, lastSyncedBlock, getFxRate }) {
  let params = {};
  let maxBlockSeen = lastSyncedBlock ?? null;
  let page = 0;
  const isFirstSync = lastSyncedBlock == null;

  while (true) {
    page++;
    const data = await fetchArcScanPage(address, params);
    const items = data.items || [];
    if (items.length === 0) break;

    for (const tx of items) {
      if (tx.status !== "ok") continue;
      if (lastSyncedBlock != null && tx.block_number <= lastSyncedBlock) continue;

      const decoded = decodeMemo(tx.raw_input);
      const fields = decoded?.fields ?? null;
      const memoText = decoded?.text ?? null;
      const usdc = Number(tx.value) / 1e18;
      if (!(usdc > 0)) continue; // filtra llamadas a contrato sin valor nativo

      let kind = "received";
      let factura = null;
      let ars = null;
      let fxRate;

      if (fields && fields.kind) {
        kind = fields.kind;
        factura = fields.inv || null;
        if (fields.cur === "ARS" && fields.amt) {
          ars = Number(fields.amt);
          fxRate = ars / usdc; // reconstruida del propio memo, no la cotización "de ahora"
        }
      }
      if (ars == null) {
        fxRate = await getFxRate();
        ars = usdc * fxRate;
      }

      const contact = await db.query(
        "SELECT name FROM contacts WHERE user_id = $1 AND LOWER(address) = LOWER($2) LIMIT 1",
        [userId, tx.from.hash]
      );
      const who = contact.rows[0]?.name || `${tx.from.hash.slice(0, 6)}…${tx.from.hash.slice(-4)}`;

      // fee no se popula acá (el formato exacto del campo `fee` de la API
      // de ArcScan no está verificado contra una transferencia real) — el
      // fee sólo se conoce con certeza en el flujo de detección en vivo
      // (findIncomingTransfer), que sí llama getTransactionReceipt.
      await db.query(
        `INSERT INTO transactions (user_id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo)
         VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8, $9, NULL, $10)
         ON CONFLICT (user_id, hash) DO NOTHING`,
        [userId, tx.hash, kind, who, usdc, fxRate, ars, factura, tx.block_number, memoText]
      );

      if (maxBlockSeen == null || tx.block_number > maxBlockSeen) maxBlockSeen = tx.block_number;
    }

    const stoppedAtCheckpoint = lastSyncedBlock != null && items.some((tx) => tx.block_number <= lastSyncedBlock);
    if (stoppedAtCheckpoint) break;
    if (isFirstSync && page >= MAX_PAGES_FIRST_SYNC) break;
    if (!data.next_page_params) break;
    params = data.next_page_params;
  }

  return maxBlockSeen;
}
```

- [ ] **Step 2: Verify `decodeMemo` with a node one-liner (pure function)**

```bash
node --input-type=module -e "
import { decodeMemo } from './netlify/functions/lib/reconcile.js';

const memo = 'MIDATO|v1|inv:20260808-1234|to:qr|cur:ARS|amt:500|kind:charge_p2p';
const hex = '0x' + Buffer.from(memo, 'utf8').toString('hex');
console.log('MIDATO memo:', JSON.stringify(decodeMemo(hex)));

const garbageHex = '0xcadddd7d0000000000000000000000000000000000000000000000000000';
console.log('non-UTF8/contract-call input:', JSON.stringify(decodeMemo(garbageHex)));

console.log('empty:', JSON.stringify(decodeMemo('0x')));
console.log('null input:', JSON.stringify(decodeMemo(null)));

const plainText = '0x' + Buffer.from('hola', 'utf8').toString('hex');
console.log('valid UTF-8, not MIDATO:', JSON.stringify(decodeMemo(plainText)));
"
```

Expected:
- `MIDATO memo`: `{"text":"MIDATO|v1|inv:20260808-1234|to:qr|cur:ARS|amt:500|kind:charge_p2p","fields":{"inv":"20260808-1234","to":"qr","cur":"ARS","amt":"500","kind":"charge_p2p"}}`
- `non-UTF8/contract-call input`: likely `null` or `{"text":"...","fields":null}` depending on whether those bytes happen to be valid UTF-8 — either is acceptable, but it must NOT throw and must NOT have `fields.kind` set.
- `empty`: `null`
- `null input`: `null`
- `valid UTF-8, not MIDATO`: `{"text":"hola","fields":null}`

If `decodeMemo` throws instead of returning `null`/an object, fix it and re-run before moving on.

- [ ] **Step 3: Verify the module loads without syntax errors**

```bash
npx esbuild netlify/functions/lib/reconcile.js --bundle=false --outfile=_reconcile_check.js && echo "SYNTAX OK" && rm -f _reconcile_check.js
```

Expected: `SYNTAX OK`.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/lib/reconcile.js
git commit -m "Add shared reconciliation module: ArcScan fetch, memo decode, upsert"
```

---

### Task 3: Scheduled job — `netlify/functions/reconcile-wallets.js`

**Files:**
- Create: `netlify/functions/reconcile-wallets.js`
- Modify: `netlify.toml`

**Interfaces:**
- Consumes: `reconcileWallet` (Task 2), `fetchArsPerUsd` (`src/priceFeed.js`, already exists — takes `rpcUrl` and reads Chainlink's `latestAnswer()` directly, no `window` dependency).
- Produces: a Netlify Scheduled Function invoked every 15 minutes; no HTTP-facing behavior a client depends on.

- [ ] **Step 1: Write `netlify/functions/reconcile-wallets.js`**

```js
// Job de reconciliación: corre cada 15 min (ver netlify.toml), recorre
// todas las wallets conocidas y reconcilia cada una contra ArcScan. No
// requiere auth — no lo dispara un usuario, lo dispara el scheduler de
// Netlify. Ver docs/superpowers/specs/2026-08-08-background-reconciliation-design.md.

import pkg from "pg";
import { reconcileWallet } from "./lib/reconcile.js";
import { fetchArsPerUsd } from "../../src/priceFeed.js";

const { Pool } = pkg;

const getFxRate = () => fetchArsPerUsd(process.env.VITE_ETH_RPC || "https://ethereum.publicnode.com");

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
      // Una wallet que falla (ArcScan caído, address rara) no debe frenar
      // el resto — se reintenta sola en la próxima corrida, 15 min después.
      console.error(`reconcile failed for ${w.user_id}:`, err);
      failed++;
    }
  }

  console.log(`reconcile-wallets: ${ok} ok, ${failed} failed, ${wallets.length} total`);
  return { statusCode: 200, body: JSON.stringify({ ok, failed, total: wallets.length }) };
};
```

- [ ] **Step 2: Add the schedule to `netlify.toml`, right after the `[functions]` block (`netlify.toml:5-13`)**

Old:

```toml
[functions]
  directory = "netlify/functions"
  # Default zip-it-and-ship-it tracer mis-packages @privy-io/server-auth's
  # @hpke/* deps (conditional dual ESM/CJS exports) — it copies
  # @hpke/common/script/mod.js into the deploy zip but drops the relative
  # ./src/errors.js it requires, crashing contacts.js at cold start with
  # "Cannot find module './src/errors.js'". esbuild fully bundles instead
  # of copying node_modules, avoiding the mis-trace.
  node_bundler = "esbuild"

# Reemplaza al proxy /rpc de Vite (solo existe en dev) por una function
```

New:

```toml
[functions]
  directory = "netlify/functions"
  # Default zip-it-and-ship-it tracer mis-packages @privy-io/server-auth's
  # @hpke/* deps (conditional dual ESM/CJS exports) — it copies
  # @hpke/common/script/mod.js into the deploy zip but drops the relative
  # ./src/errors.js it requires, crashing contacts.js at cold start with
  # "Cannot find module './src/errors.js'". esbuild fully bundles instead
  # of copying node_modules, avoiding the mis-trace.
  node_bundler = "esbuild"

# Job de reconciliación de wallets — ver
# docs/superpowers/specs/2026-08-08-background-reconciliation-design.md.
[functions."reconcile-wallets"]
  schedule = "*/15 * * * *"

# Reemplaza al proxy /rpc de Vite (solo existe en dev) por una function
```

- [ ] **Step 3: Verify it loads and runs via `netlify functions:invoke` (schedules never fire under `netlify functions:serve` — this is the documented way to test a scheduled function locally)**

```bash
npx netlify functions:serve
```

In a second terminal, once listening:

```bash
npx netlify functions:invoke reconcile-wallets
```

Expected: no crash; JSON output like `{"ok":N,"failed":0,"total":N}` where `N` is however many rows exist in `wallets` at this point (likely `0` until Task 4 ships and someone logs in — `{"ok":0,"failed":0,"total":0}` is a valid, correct result here). If it throws before Task 4 exists, that's expected too (the `wallets` table exists from Task 1, but nothing populates it until Task 4 — a `0`-row result is what "loads and runs cleanly with an empty table" looks like). Stop `netlify functions:serve` once confirmed.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/reconcile-wallets.js netlify.toml
git commit -m "Add scheduled reconcile-wallets job (every 15 min)"
```

---

### Task 4: Reconcile on reopen — `GET /transactions`

**Files:**
- Modify: `netlify/functions/transactions.js`

**Interfaces:**
- Consumes: `reconcileWallet` (Task 2), `fetchArsPerUsd` (`src/priceFeed.js`), `ethers.isAddress`.
- Produces: `GET /transactions?address=0x...` now upserts `wallets(user_id, address)` and reconciles that one wallet (bounded, best-effort — failure doesn't block the response) before returning the existing transaction list. `GET /transactions` with no `address` behaves exactly as before (skips reconciliation).

- [ ] **Step 1: Add the new imports, right after the existing ones (`netlify/functions/transactions.js:1-9`)**

Old:

```js
import pkg from "pg";
import { PrivyClient } from "@privy-io/server-auth";

const { Pool } = pkg;
```

New:

```js
import pkg from "pg";
import { PrivyClient } from "@privy-io/server-auth";
import { ethers } from "ethers";
import { reconcileWallet } from "./lib/reconcile.js";
import { fetchArsPerUsd } from "../../src/priceFeed.js";

const { Pool } = pkg;

const getFxRate = () => fetchArsPerUsd(process.env.VITE_ETH_RPC || "https://ethereum.publicnode.com");
```

- [ ] **Step 2: Rewrite the `GET` branch to reconcile before the `SELECT` (`netlify/functions/transactions.js`, inside `handler`)**

Old:

```js
    if (event.httpMethod === "GET") {
      const { rows } = await db.query(
        `SELECT id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo, created_at
         FROM transactions WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      return json(200, { transactions: rows });
    }
```

New:

```js
    if (event.httpMethod === "GET") {
      const address = event.queryStringParameters?.address;
      if (address && ethers.isAddress(address)) {
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
          // Si ArcScan falla acá, no bloquea la carga del historial existente
          // — se reintenta en la próxima apertura o en el próximo tick del job.
        }
      }

      const { rows } = await db.query(
        `SELECT id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo, created_at
         FROM transactions WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      return json(200, { transactions: rows });
    }
```

- [ ] **Step 3: Verify the Function still bundles cleanly**

```bash
npx netlify functions:serve
```

In a second terminal:

```bash
curl -i "http://localhost:9999/.netlify/functions/transactions?address=0x41c990cFA3914492313351e61A23955C6e1C99E7"
```

Expected: `HTTP/1.1 401 Unauthorized` (no token supplied) — confirms the file still loads and bundles without a syntax/import error even with the new imports (`ethers`, `../../src/priceFeed.js`, `./lib/reconcile.js`) before the auth gate is ever reached. Stop `netlify functions:serve` once confirmed.

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/transactions.js
git commit -m "Reconcile the caller's wallet in GET /transactions before returning history"
```

---

### Task 5: Client — pass `address` to `loadTransactions`

**Files:**
- Modify: `src/transactions.js`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadTransactions(userId, token, address, onCache)` (was `(userId, token, onCache)` — `address` inserted as the 3rd positional param) — `App.jsx`'s only call site is updated in the same task, so no other caller is affected.

- [ ] **Step 1: Update `loadTransactions` in `src/transactions.js`**

Old:

```js
export function loadTransactions(userId, token, onCache) {
  const cached = readCache(userId);
  if (onCache) onCache(cached);
  if (!userId || !token) return Promise.resolve(cached);
  return api("/transactions", token)
    .then(({ transactions }) => {
      const list = transactions.map(fromWire);
      writeCache(userId, list);
      return list;
    })
    .catch(() => cached);
}
```

New:

```js
export function loadTransactions(userId, token, address, onCache) {
  const cached = readCache(userId);
  if (onCache) onCache(cached);
  if (!userId || !token) return Promise.resolve(cached);
  const path = address ? `/transactions?address=${encodeURIComponent(address)}` : "/transactions";
  return api(path, token)
    .then(({ transactions }) => {
      const list = transactions.map(fromWire);
      writeCache(userId, list);
      return list;
    })
    .catch(() => cached);
}
```

- [ ] **Step 2: Update the call site in `src/App.jsx`'s transactions-loading effect**

Old:

```jsx
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    getAccessToken()
      .then((token) =>
        loadTransactions(user.id, token, (cached) => {
          if (!cancelled) setTxs((prev) => mergeByHash(cached, prev));
        })
      )
      .then((fresh) => {
        if (!cancelled) setTxs((prev) => mergeByHash(fresh, prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user?.id, getAccessToken]);
```

New:

```jsx
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    getAccessToken()
      .then((token) =>
        loadTransactions(user.id, token, address, (cached) => {
          if (!cancelled) setTxs((prev) => mergeByHash(cached, prev));
        })
      )
      .then((fresh) => {
        if (!cancelled) setTxs((prev) => mergeByHash(fresh, prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user?.id, address, getAccessToken]);
```

(Adding `address` to the dependency array means this effect re-fires once the embedded wallet finishes being created — `address` starts as `""` and the Function skips reconciliation for an empty/invalid address, exactly like it already does when the query param is absent entirely.)

- [ ] **Step 3: Verify the full production build still passes**

```bash
npm run build
```

Expected: build succeeds (same chunk-size warnings as before are fine, no new errors).

- [ ] **Step 4: Commit**

```bash
git add src/transactions.js src/App.jsx
git commit -m "Pass the wallet address to GET /transactions for reconciliation"
```

---

### Task 6: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Migration sanity check**

Confirm (already done in Task 1, re-verify here after all code changes) that `wallets` exists in Aiven with the expected columns.

- [ ] **Step 2: Wallet registration**

Run `npx netlify functions:serve` + `npm run dev`, log in. Confirm in Aiven (`SELECT * FROM wallets;`) that a row appears for this user with their Privy embedded wallet's address, within a few seconds of login (covers the `address` dependency added in Task 5 — even if the wallet wasn't ready on the very first render).

- [ ] **Step 3: Reconcile-on-reopen, end to end**

From a second wallet (or this same user's `Pay`/`Convert` to a different address), send a payment to the logged-in user's address **without** having their Cobrar "Esperando pago" screen open. Reload the app (fresh `GET /transactions?address=...`). Confirm the transaction now appears in Movimientos with the correct `kind`/`who`:
- If the sender used the QR/Pay flow (memo carries `MIDATO|v1|...|kind:charge_p2p` or `kind:pay`), confirm `kind`/`factura`/`ars` match what the sender's own Movimientos shows for the same hash.
- If sent from an address with no MIDATO memo (e.g. a plain wallet transfer), confirm it shows up with `kind: "received"` and `who` as either a matching contact name or the short address.

- [ ] **Step 4: Scheduled job, invoked manually**

```bash
npx netlify functions:serve
```

In a second terminal:

```bash
npx netlify functions:invoke reconcile-wallets
```

Confirm it processes the wallet(s) registered so far and updates `last_synced_block` in Aiven (`SELECT user_id, last_synced_block FROM wallets;`).

- [ ] **Step 5: Checkpoint idempotency**

Immediately invoke `reconcile-wallets` a second time with no new transactions in between. Confirm via `SELECT count(*) FROM transactions WHERE user_id = '<id>';` that the count didn't change, and that `last_synced_block` didn't move backward.

- [ ] **Step 6: Regression check**

Confirm a manual "Pay" or voice payment (client-side, real-time path) still shows up in Movimientos exactly as before — reconciliation must be a pure addition, not a change to the existing write path (`pushTx` is untouched by this plan). Confirm `GET /transactions` still works if `address` is ever missing from the query string (simulates an old cached client build) — it should just skip reconciliation, not error.

Stop both processes once confirmed.

---

## Self-Review

**Spec coverage:**
- §1 `wallets` table + population via `GET /transactions?address=` → Task 1, Task 4. ✓
- §2 Shared reconciliation module (`decodeMemo`, `reconcileWallet`, fxRate reconstruction from memo, fee left `NULL`) → Task 2. ✓
- §3 Scheduled job + `netlify.toml` schedule + server-side FX via `fetchArsPerUsd` → Task 3. ✓
- §4 Reconcile-on-reopen in `GET /transactions`, client passes `address` → Task 4, Task 5. ✓
- §5 Errors/edge cases (ArcScan down doesn't block the response; first-sync page cap is a permanent limitation, not "catches up later"; non-MIDATO memo → `kind: "received"`; double-reconciliation is a no-op via `ON CONFLICT`) → all implemented as designed in Task 2/4, explicitly covered in Task 6's manual verification. ✓
- §6 Verification approach (schema check, wallet population, reconcile-on-reopen, `functions:invoke` for the job, checkpoint idempotency, regression) → Task 6, mirrors the spec's list exactly. ✓
- Fuera de alcance (no reconcilia salientes, no backfill completo, sin backoff, sin cobertura de wallets sin login) → no task attempts any of these, confirmed absent from the implementation.

**Placeholder scan:** No TBD/TODO; every step has literal code, exact commands, or a concrete verification procedure with expected output.

**Type/naming consistency:** `reconcileWallet(db, { userId, address, lastSyncedBlock, getFxRate })` signature and its returned `Promise<number|null>` match exactly between Task 2's definition and both call sites (Task 3's job loop, Task 4's `GET` handler). `decodeMemo(rawInputHex) -> { text, fields } | null` matches between its Task 2 definition and Task 2's own verification step. `loadTransactions(userId, token, address, onCache)`'s new parameter order matches between Task 5's `src/transactions.js` definition and its single call site in `src/App.jsx` (same task, so no risk of drift). The `wallets` table's columns (`user_id, address, last_synced_block, updated_at`) are used identically across Task 1's DDL, Task 2's `reconcileWallet` (implicitly, via the caller-supplied `lastSyncedBlock`), Task 3's job query, and Task 4's upsert/`SELECT`.
