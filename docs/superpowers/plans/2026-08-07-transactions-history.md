# Transaction History Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every completed transaction (voice/manual pay, charge, ARS→USDC convert, USDC→ARS convert) to Postgres per Privy user, so the Activity tab (Movimientos) survives page refreshes and works across devices, and shows the full transaction detail (fee, block, invoice, exchange rate, ARS amount) that today only appears once on the Success screen.

**Architecture:** New Netlify Function `netlify/functions/transactions.js` + Postgres table `transactions`, mirroring the existing `contacts.js`/`contacts` pattern exactly (same auth, same SSL/SNI-safe pool, same `netlify.toml`/`vite.config.js` proxy shape). New client module `src/transactions.js` (HTTP + localStorage cache, same shape as `src/contacts.js`). `App.jsx`'s existing `pushTx` becomes the single choke point that both updates local state and fires the persistence write; a new load-on-mount effect (keyed on `user.id`, same pattern as the existing contacts-loading effect) repopulates `txs` from the server. The Success screen's detail block is extracted into a shared `TxDetail` component, reused by `TxCard` for an expand-on-tap detail view in Movimientos.

**Tech Stack:** React 18, `pg` (already a dependency), `@privy-io/server-auth` (already a dependency), Aiven Postgres, Netlify Functions (esbuild bundler). No test runner exists in this repo — verification is a mix of: pure-function node one-liners (for the one new pure helper), `netlify functions:serve` + `curl` (for the Function's auth gate, no real token needed), a direct node+`pg` script against the live Aiven DB (for schema — this repo's established way of verifying DB changes, used earlier this session to diagnose and fix `contacts.js`'s SSL/table issues), and `npm run dev` + browser for the end-to-end UI flow.

## Global Constraints

- No test framework may be introduced (`CLAUDE.md`: "There is no lint script, no test runner, and no test files in this repo").
- No new env vars — reuse `AIVEN_PG_URL`, `AIVEN_PG_CA_CERT`, `PRIVY_APP_SECRET` already configured for `contacts.js`.
- The Netlify Function's request/response body uses the same field names as the DB columns (snake_case: `fx_rate`, `created_at`) — no renaming inside the Function. The camelCase translation (`fxRate`, `createdAt`) happens entirely client-side in `src/transactions.js`'s `toWire`/`fromWire`, mirroring how `contacts.js` keeps `address` as-is and only `src/contacts.js` translates `addr` ↔ `address`.
- `ars` is stored explicitly per transaction, never recomputed from `amt * fx_rate` — see spec §1.2 for why (float precision + it's the real settled ARS amount for `charge`/`convert_ars_usdc`, not a display-only figure).
- Follow existing conventions: inline `style={{...}}` objects, the `C` design-token object, `Card`/`btnOrange`/`btnOutline` primitives, `t()` from `useLanguage()` for all user-facing strings.
- No new i18n keys — `TxDetail` reuses the existing `success.*` keys already present for both `en`/`es`.
- Spec reference: `docs/superpowers/specs/2026-08-07-transactions-history-design.md`.

---

## File Structure

- **Modify** `db/schema.sql` — add the `transactions` table.
- **Create** `netlify/functions/transactions.js` — `GET`/`POST` handler, mirrors `contacts.js` (same pool/SSL/SNI setup, same auth helper shape).
- **Modify** `vite.config.js` — add the `/transactions` dev proxy entry.
- **Modify** `netlify.toml` — add the `/transactions` redirect.
- **Create** `src/transactions.js` — client HTTP module + localStorage cache + `mergeByHash` (pure, exported, unit-tested).
- **Modify** `src/App.jsx` — import the new module; extend `pushTx` to persist; add a load-on-mount effect; extract `TxDetail` from `Success`; make `TxCard` expandable; drop the now-unused `fxRate` prop from `TxCard`/`Movimientos`.

---

### Task 1: `transactions` table in Postgres

**Files:**
- Modify: `db/schema.sql`

**Interfaces:**
- Produces: the `transactions` table (columns: `id, user_id, hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo, created_at`), consumed by Task 2's Function.

- [ ] **Step 1: Append the table to `db/schema.sql`**

Add at the end of the file (after the existing `contacts_user_alias_uidx` index):

```sql

-- Historial de transacciones — ver
-- docs/superpowers/specs/2026-08-07-transactions-history-design.md § 1.2

CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,           -- Privy DID
  hash        TEXT NOT NULL UNIQUE,    -- hash on-chain, único globalmente
  kind        TEXT NOT NULL,           -- 'voice' | 'pay' | 'charge' | 'convert_ars_usdc' | 'convert_usdc_ars'
  direction   TEXT NOT NULL,           -- 'in' | 'out'
  who         TEXT NOT NULL,           -- contraparte mostrada
  amt         NUMERIC NOT NULL,        -- monto en USDC
  fx_rate     NUMERIC NOT NULL,        -- ARS por USDC al momento de la tx
  ars         NUMERIC NOT NULL,        -- monto en ARS al momento de la tx (no se recalcula, ver spec)
  factura     TEXT,
  block       BIGINT,
  fee         NUMERIC,
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_user_id_idx ON transactions (user_id, created_at DESC);
```

- [ ] **Step 2: Run it against the live Aiven DB and verify**

This repo has no migration runner — `db/schema.sql` is run by hand (see `CLAUDE.md`). Run it via a throwaway node script from the project root (reuses `.env`'s `AIVEN_PG_URL`/`AIVEN_PG_CA_CERT`, and the SNI-safe SSL config already fixed in `netlify/functions/contacts.js`):

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
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' ORDER BY ordinal_position"
);
console.log("transactions columns:", cols.rows.map((r) => r.column_name));
await pool.end();
EOF
node _run-schema-tmp.mjs
rm -f _run-schema-tmp.mjs
```

Expected output:
```
transactions columns: [
  'id', 'user_id', 'hash', 'kind',
  'direction', 'who', 'amt', 'fx_rate',
  'ars', 'factura', 'block', 'fee',
  'memo', 'created_at'
]
```

If it errors, fix `db/schema.sql` (the whole file is idempotent — `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS` — so re-running after a fix is safe) and re-run before moving on.

- [ ] **Step 3: Commit**

```bash
git add db/schema.sql
git commit -m "Add transactions table to schema.sql"
```

---

### Task 2: `netlify/functions/transactions.js` + dev/prod routing

**Files:**
- Create: `netlify/functions/transactions.js`
- Modify: `vite.config.js:20-42` (proxy block)
- Modify: `netlify.toml:22-27` (redirects, add a new one after the `/contacts` block)

**Interfaces:**
- Consumes: `pg`, `@privy-io/server-auth` (both already dependencies); `AIVEN_PG_URL`, `AIVEN_PG_CA_CERT`, `PRIVY_APP_SECRET`, `VITE_PRIVY_APP_ID` env vars (all already configured).
- Produces: `GET /transactions` (returns `{ transactions: [...] }`, rows scoped to the token's `user_id`, `ORDER BY created_at DESC`), `POST /transactions` (body = DB column names, returns `{ transaction: {...} }`; on `hash` conflict, returns the existing row with `200` instead of erroring).

- [ ] **Step 1: Write `netlify/functions/transactions.js`**

```js
// API del historial de transacciones — puente entre el browser y Postgres
// (Aiven). Mismo patrón que netlify/functions/contacts.js: el browser nunca
// ve la connection string ni el secret de Privy. Ver
// docs/superpowers/specs/2026-08-07-transactions-history-design.md § 1.

import pkg from "pg";
import { PrivyClient } from "@privy-io/server-auth";

const { Pool } = pkg;

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
         ON CONFLICT (hash) DO NOTHING
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

      // hash ya existía (reintento de POST) — devolver la fila existente en
      // vez de tratarlo como error.
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
```

- [ ] **Step 2: Add the `/transactions` dev proxy to `vite.config.js`, right after the `/contacts` block (`vite.config.js:36-40`)**

Old:

```js
        "/contacts": {
          target: "http://localhost:9999",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/contacts/, "/.netlify/functions/contacts"),
        },
      },
    },
  };
});
```

New:

```js
        "/contacts": {
          target: "http://localhost:9999",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/contacts/, "/.netlify/functions/contacts"),
        },
        "/transactions": {
          target: "http://localhost:9999",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/transactions/, "/.netlify/functions/transactions"),
        },
      },
    },
  };
});
```

- [ ] **Step 3: Add the `/transactions` redirect to `netlify.toml`, right after the `/contacts` redirect block (`netlify.toml:22-27`)**

Old:

```toml
# API de la agenda de contactos (Postgres vía Aiven, ver netlify/functions/contacts.js).
[[redirects]]
  from = "/contacts"
  to = "/.netlify/functions/contacts"
  status = 200
  force = true

# SPA: cualquier otra ruta sirve index.html (no hay react-router, pero
```

New:

```toml
# API de la agenda de contactos (Postgres vía Aiven, ver netlify/functions/contacts.js).
[[redirects]]
  from = "/contacts"
  to = "/.netlify/functions/contacts"
  status = 200
  force = true

# API del historial de transacciones (Postgres vía Aiven, ver netlify/functions/transactions.js).
[[redirects]]
  from = "/transactions"
  to = "/.netlify/functions/transactions"
  status = 200
  force = true

# SPA: cualquier otra ruta sirve index.html (no hay react-router, pero
```

- [ ] **Step 4: Verify the Function loads and the auth gate works, without needing a real Privy token**

Run (from the project root, in one terminal):

```bash
npx netlify functions:serve
```

In a second terminal, once it's listening on `:9999`:

```bash
curl -i http://localhost:9999/.netlify/functions/transactions
curl -i -X POST http://localhost:9999/.netlify/functions/transactions -d '{}'
```

Expected for both: `HTTP/1.1 401 Unauthorized` with body `{"error":"unauthorized"}`.

This confirms two things without a real token: the function bundles and loads cleanly (no `Cannot find module` crash like the one `contacts.js` hit earlier — see git history), and the auth gate runs before touching Postgres. Full read/write behavior with a real token is verified end-to-end in Task 5. Stop `netlify functions:serve` (Ctrl+C) once confirmed.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/transactions.js vite.config.js netlify.toml
git commit -m "Add /transactions Netlify Function, dev proxy, and redirect"
```

---

### Task 3: `src/transactions.js` — client HTTP module + cache

**Files:**
- Create: `src/transactions.js`

**Interfaces:**
- Consumes: nothing new (plain `fetch`/`localStorage`, same as `src/contacts.js`).
- Produces: `loadTransactions(userId, token, onCache) -> Promise<Tx[]>`, `addTransaction(userId, token, list, data) -> Promise<Tx[]>`, `mergeByHash(serverList, localList) -> Tx[]` (pure, exported), where `Tx = { hash, kind, direction, who, amt, fxRate, ars, factura, block, fee, memo, createdAt }`.

- [ ] **Step 1: Write `src/transactions.js`**

```js
// Cliente HTTP del historial de transacciones, con cache stale-while-revalidate
// en localStorage. Mismo patrón que src/contacts.js. Ver
// docs/superpowers/specs/2026-08-07-transactions-history-design.md § 1.4.

const CACHE_PREFIX = "mp_tx_cache_";
const cacheKey = (userId) => `${CACHE_PREFIX}${userId}`;

function readCache(userId) {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeCache(userId, list) {
  if (!userId) return;
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

// El wire format de la Function usa los mismos nombres que las columnas
// (snake_case); la UI usa camelCase (mismo patrón que addr/address en
// src/contacts.js).
function toWire(tx) {
  return {
    hash: tx.hash,
    kind: tx.kind,
    direction: tx.direction,
    who: tx.who,
    amt: tx.amt,
    fx_rate: tx.fxRate,
    ars: tx.ars,
    factura: tx.factura ?? null,
    block: tx.block ?? null,
    fee: tx.fee ?? null,
    memo: tx.memo ?? null,
  };
}

function fromWire(row) {
  return {
    hash: row.hash,
    kind: row.kind,
    direction: row.direction,
    who: row.who,
    amt: Number(row.amt),
    fxRate: Number(row.fx_rate),
    ars: Number(row.ars),
    factura: row.factura,
    block: row.block !== null && row.block !== undefined ? Number(row.block) : null,
    fee: row.fee !== null && row.fee !== undefined ? Number(row.fee) : null,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

async function api(path, token, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `http_${res.status}`);
    err.code = body.error;
    throw err;
  }
  return body;
}

/**
 * Mergea la lista fresca del server con lo que ya había en memoria: el
 * server manda para cualquier hash que ya conozca; las entradas locales
 * cuyo hash el server todavía no tiene (POST en vuelo, o falló) se
 * mantienen arriba de todo.
 */
export function mergeByHash(serverList, localList) {
  const seen = new Set(serverList.map((tx) => tx.hash));
  const onlyLocal = localList.filter((tx) => !seen.has(tx.hash));
  return [...onlyLocal, ...serverList];
}

/**
 * Sirve el cache al instante (vía onCache, si hay algo cacheado) y en
 * paralelo pide la lista real a /transactions; la respuesta del server pisa
 * el cache y es lo que resuelve la promise. Si el request falla, se resuelve
 * con lo que había en cache en vez de rechazar.
 */
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

export async function addTransaction(userId, token, list, data) {
  const { transaction } = await api("/transactions", token, { method: "POST", body: JSON.stringify(toWire(data)) });
  const next = mergeByHash([fromWire(transaction)], list);
  writeCache(userId, next);
  return next;
}
```

- [ ] **Step 2: Verify `mergeByHash` with a Node one-liner (pure function, no `fetch`/`localStorage` needed)**

Run (from the project root):

```bash
node --input-type=module -e "
import { mergeByHash } from './src/transactions.js';
const server = [{ hash: 'a', amt: 1 }, { hash: 'b', amt: 2 }];
const local = [{ hash: 'c', amt: 3 }, { hash: 'a', amt: 999 }];
console.log(JSON.stringify(mergeByHash(server, local)));
"
```

Expected: `[{"hash":"c","amt":3},{"hash":"a","amt":1},{"hash":"b","amt":2}]` — the local-only entry (`c`) is kept and placed first; the entry that exists in both (`a`) takes the **server's** value (`amt: 1`, not `999`); `b` (server-only) passes through unchanged.

If it doesn't match, fix `mergeByHash` and re-run before moving on.

- [ ] **Step 3: Commit**

```bash
git add src/transactions.js
git commit -m "Add transactions.js: HTTP client, cache, and mergeByHash for the tx history"
```

---

### Task 4: Wire persistence into `App.jsx` (`pushTx` + load-on-mount)

**Files:**
- Modify: `src/App.jsx:22-30` (imports)
- Modify: `src/App.jsx:2631` (add `txsRef`)
- Modify: `src/App.jsx:2665-2684` (add a load-on-mount effect for transactions, right after the contacts one)
- Modify: `src/App.jsx:2761-2763` (`pushTx`)
- Modify: `src/App.jsx:2765-2805` (`sendPayment` — its `pushTx` call)
- Modify: `src/App.jsx:2807-2823` (`handleCharge` — its `pushTx` call)
- Modify: `src/App.jsx:2825-2846` (`handleConvertArsUsdc` — its `pushTx` call)
- Modify: `src/App.jsx:2848-2869` (`handleConvertUsdcArs` — its `pushTx` call)

**Interfaces:**
- Consumes: `loadTransactions`, `addTransaction`, `mergeByHash` from `./transactions.js` (Task 3).
- Produces: `txs` entries now shaped `{ hash, who, amt, fxRate, ars, factura, block, fee, memo, kind, direction, createdAt }` (adds `ars`, `block`, `fee`, `memo`, `createdAt` on top of what exists today) — Task 5 consumes this shape in `TxCard`/`TxDetail`.

- [ ] **Step 1: Add the import, right after the existing `./contacts.js` import block (`src/App.jsx:22-30`)**

```jsx
import {
  loadContacts,
  addContact,
  updateContact,
  removeContact,
  findByAlias,
  searchContacts,
  validateContact,
} from "./contacts.js";
import { loadTransactions, addTransaction, mergeByHash } from "./transactions.js";
```

- [ ] **Step 2: Add `txsRef`, right after `const [txs, setTxs] = useState([]);` (`src/App.jsx:2631`)**

Old:

```jsx
  const [txs, setTxs] = useState([]);
```

New:

```jsx
  const [txs, setTxs] = useState([]);
  const txsRef = useRef(txs);
  txsRef.current = txs;
```

- [ ] **Step 3: Add the load-on-mount effect, right after the contacts-loading effect (`src/App.jsx:2665-2684`, ends right before `const handleAddContact = ...`)**

Insert immediately after that effect's closing `}, [user?.id, getAccessToken]);`:

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

- [ ] **Step 4: Rewrite `pushTx` to persist (`src/App.jsx:2761-2763`)**

Old:

```jsx
  const pushTx = useCallback((entry) => {
    setTxs((t) => [entry, ...t]);
  }, []);
```

New:

```jsx
  const pushTx = useCallback(
    (entry) => {
      const withTimestamp = { ...entry, createdAt: new Date().toISOString() };
      setTxs((t) => [withTimestamp, ...t]);
      if (!user?.id) return;
      getAccessToken()
        .then((token) => addTransaction(user.id, token, txsRef.current, withTimestamp))
        .catch(() => {});
    },
    [user?.id, getAccessToken]
  );
```

(`createdAt` here is a client-side placeholder so `TxCard`/`TxDetail` — Task 5 — have something to show immediately; once the load-on-mount effect's next `GET` reconciles via `mergeByHash`, the server's real `created_at` replaces it, since the hash will now be present in the server list.)

- [ ] **Step 5: Extend the `pushTx` call in `sendPayment` with `ars`/`block`/`fee`/`memo` (`src/App.jsx:2765-2805`)**

Old:

```jsx
      const tx = await sendNativeUsdc(signer, {
        to: parsed.contact.addr,
        usdc: parsed.usdc,
        memo,
      });
      pushTx({
        hash: tx.hash,
        who: parsed.contact.name,
        amt: parsed.usdc,
        factura: parsed.factura,
        fxRate: parsed.fxRate,
        kind,
        direction: "out",
      });
      await refreshBalances();
      return {
        kind,
        hash: tx.hash,
        block: tx.block,
        fee: tx.fee,
        memo: tx.memo,
        factura: parsed.factura,
        usdc: parsed.usdc,
        ars: parsed.usdc * (parsed.fxRate || fxRate),
        fxRate: parsed.fxRate || fxRate,
        ts: new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
      };
```

New:

```jsx
      const tx = await sendNativeUsdc(signer, {
        to: parsed.contact.addr,
        usdc: parsed.usdc,
        memo,
      });
      const effectiveFxRate = parsed.fxRate || fxRate;
      const ars = parsed.usdc * effectiveFxRate;
      pushTx({
        hash: tx.hash,
        who: parsed.contact.name,
        amt: parsed.usdc,
        fxRate: effectiveFxRate,
        ars,
        factura: parsed.factura,
        block: tx.block,
        fee: tx.fee,
        memo: tx.memo,
        kind,
        direction: "out",
      });
      await refreshBalances();
      return {
        kind,
        hash: tx.hash,
        block: tx.block,
        fee: tx.fee,
        memo: tx.memo,
        factura: parsed.factura,
        usdc: parsed.usdc,
        ars,
        fxRate: effectiveFxRate,
        ts: new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
      };
```

- [ ] **Step 6: Extend the `pushTx` call in `handleCharge` (`src/App.jsx:2807-2823`)**

Old:

```jsx
      pushTx({
        hash: result.hash,
        who: t("charge.merchantSelf"),
        amt: result.usdc,
        factura: result.factura,
        fxRate: result.fxRate,
        kind: "charge",
        direction: "in",
      });
```

New:

```jsx
      pushTx({
        hash: result.hash,
        who: t("charge.merchantSelf"),
        amt: result.usdc,
        fxRate: result.fxRate,
        ars: result.ars,
        factura: result.factura,
        block: result.block,
        fee: result.fee,
        memo: result.memo,
        kind: "charge",
        direction: "in",
      });
```

- [ ] **Step 7: Extend the `pushTx` call in `handleConvertArsUsdc` (`src/App.jsx:2825-2846`)**

Old:

```jsx
      pushTx({
        hash: result.hash,
        who: t("convert.treasuryLabel"),
        amt: result.usdc,
        factura: result.factura,
        fxRate: result.fxRate,
        kind: "convert_ars_usdc",
        direction: "in",
      });
```

New:

```jsx
      pushTx({
        hash: result.hash,
        who: t("convert.treasuryLabel"),
        amt: result.usdc,
        fxRate: result.fxRate,
        ars: result.ars,
        factura: result.factura,
        block: result.block,
        fee: result.fee,
        memo: result.memo,
        kind: "convert_ars_usdc",
        direction: "in",
      });
```

- [ ] **Step 8: Extend the `pushTx` call in `handleConvertUsdcArs` (`src/App.jsx:2848-2869`)**

Old:

```jsx
      pushTx({
        hash: result.hash,
        who: t("convert.treasuryLabel"),
        amt: result.usdc,
        factura: result.factura,
        fxRate: result.fxRate,
        kind: "convert_usdc_ars",
        direction: "out",
      });
```

New:

```jsx
      pushTx({
        hash: result.hash,
        who: t("convert.treasuryLabel"),
        amt: result.usdc,
        fxRate: result.fxRate,
        ars: result.ars,
        factura: result.factura,
        block: result.block,
        fee: result.fee,
        memo: result.memo,
        kind: "convert_usdc_ars",
        direction: "out",
      });
```

- [ ] **Step 9: Manually verify persistence (no detail UI yet — that's Task 5)**

Run in one terminal: `npx netlify functions:serve`. Run in another: `npm run dev`, open the printed local URL, log in.

1. Make any payment (voice or manual "Pay"), or a Charge/Convert — confirm the Success screen shows as before (no regression).
2. Go to Movimientos — confirm the new transaction appears in the list (same as before this task).
3. Refresh the browser page (full reload, not SPA nav) — confirm the transaction is **still there** in Movimientos after reload. This is the actual behavior change: before this task, a refresh would have shown an empty list.
4. Check the browser console — no errors.

Stop both processes once confirmed.

- [ ] **Step 10: Commit**

```bash
git add src/App.jsx
git commit -m "Persist transactions to Postgres via pushTx and load them on mount"
```

---

### Task 5: `TxDetail` extraction + expandable `TxCard`

**Files:**
- Modify: `src/App.jsx:2017-2126` (`Success` — extract detail block into `TxDetail`, placed just above `Success`)
- Modify: `src/App.jsx:2130-2210` (`TxCard` — drop `fxRate` prop, add expand/collapse, render `TxDetail`)
- Modify: `src/App.jsx:2212-2247` (`Movimientos` — drop `fxRate` prop/forwarding)
- Modify: `src/App.jsx:664` (Home's compact `TxCard` call — drop `fxRate` prop)
- Modify: `src/App.jsx:3021` (`Movimientos` render call — drop `fxRate` prop)

**Interfaces:**
- Consumes: `tx` entries shaped as produced by Task 4 (`ars`, `block`, `fee`, `memo`, `createdAt` now present).
- Produces: `TxDetail({ usdc, ars, fx, fee, block, factura, hash, time })` (module-scope component, presentational only).

- [ ] **Step 1: Add `TxDetail`, right before the `Success` component (`src/App.jsx`, just above line 2017's `// ————— Éxito a pantalla completa —————` comment)**

```jsx
// ————— Detalle de transacción (compartido: Success + TxCard) —————
function TxDetail({ usdc, ars, fx, fee, block, factura, hash, time }) {
  const { t, locale } = useLanguage();
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 14 }}>{t("success.operation")}</div>
      <div style={{ display: "grid", gap: 10, fontSize: 14.5 }}>
        {[
          [t("success.amountSent"), `${fmt(usdc, 2, locale)} USDC`],
          [t("success.equals"), `$${fmtArs(ars)} ARS`],
          [t("success.exchangeRate"), `1 USDC = $${fmtArs(fx)} ARS`],
          [t("success.networkFee"), fee ? `${Number(fee).toFixed(6)} USDC` : "—"],
          block ? [t("success.block"), String(block)] : null,
          [t("success.time"), time],
        ].filter(Boolean).map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: C.mut }}>{k}:</span>
            <span style={{ color: C.ink, fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 16, paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14.5 }}>
          <span style={{ color: C.mut }}>{t("success.invoiceLabel")}</span>
          <span style={{ color: C.green, fontWeight: 700 }}>{factura} · {t("success.onchainCheck")}</span>
        </div>
        <a href={`${ARC.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 12, fontSize: 13.5, color: "#fe6c1c", fontWeight: 600, textDecoration: "none", wordBreak: "break-all" }}>
          {t("success.viewOnArcScan", short(hash))}
        </a>
      </div>
    </div>
  );
}

```

- [ ] **Step 2: Replace `Success`'s inline detail block with `TxDetail` (`src/App.jsx:2080-2108`)**

Old:

```jsx
        {detalle && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.ink, marginBottom: 14 }}>{t("success.operation")}</div>
            <div style={{ display: "grid", gap: 10, fontSize: 14.5 }}>
              {[
                [t("success.amountSent"), `${fmt(usdc, 2, locale)} USDC`],
                [t("success.equals"), `$${fmtArs(ars)} ARS`],
                [t("success.exchangeRate"), `1 USDC = $${fmtArs(fx)} ARS`],
                [t("success.networkFee"), receipt.fee ? `${Number(receipt.fee).toFixed(6)} USDC` : "—"],
                receipt.block ? [t("success.block"), String(receipt.block)] : null,
                [t("success.time"), receipt.ts],
              ].filter(Boolean).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: C.mut }}>{k}:</span>
                  <span style={{ color: C.ink, fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 16, paddingTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14.5 }}>
                <span style={{ color: C.mut }}>{t("success.invoiceLabel")}</span>
                <span style={{ color: C.green, fontWeight: 700 }}>{receipt.factura} · {t("success.onchainCheck")}</span>
              </div>
              <a href={`${ARC.explorer}/tx/${receipt.hash}`} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 12, fontSize: 13.5, color: "#fe6c1c", fontWeight: 600, textDecoration: "none", wordBreak: "break-all" }}>
                {t("success.viewOnArcScan", short(receipt.hash))}
              </a>
            </div>
          </div>
        )}
```

New:

```jsx
        {detalle && (
          <TxDetail
            usdc={usdc}
            ars={ars}
            fx={fx}
            fee={receipt.fee}
            block={receipt.block}
            factura={receipt.factura}
            hash={receipt.hash}
            time={receipt.ts}
          />
        )}
```

- [ ] **Step 3: Replace `TxCard` with an expandable version that drops the `fxRate` prop (`src/App.jsx:2130-2210`)**

Old (full component):

```jsx
function TxCard({ tx, fxRate, compact = false }) {
  const { t, locale } = useLanguage();
  const inbound = tx.direction === "in";
  const isConvert = tx.kind === "convert_ars_usdc" || tx.kind === "convert_usdc_ars";
  const arsEq = tx.amt * (tx.fxRate || fxRate);

  const title = isConvert
    ? tx.kind === "convert_ars_usdc"
      ? "ARS → USDC"
      : "USDC → ARS"
    : tx.kind === "charge"
      ? t("movs.charge")
      : tx.who;

  const primary =
    isConvert && tx.kind === "convert_ars_usdc"
      ? `+${fmt(tx.amt, 2, locale)} USDC`
      : isConvert && tx.kind === "convert_usdc_ars"
        ? `−${fmt(tx.amt, 2, locale)} USDC`
        : `${inbound ? "+" : "−"}${fmt(tx.amt, 2, locale)} USDC`;

  const secondary =
    isConvert && tx.kind === "convert_ars_usdc"
      ? `−${fmtArs(arsEq)} ARS`
      : isConvert && tx.kind === "convert_usdc_ars"
        ? `+${fmtArs(arsEq)} ARS`
        : `${inbound ? "+" : "−"}${fmtArs(arsEq)} ARS`;

  const iconBg = isConvert ? C.orangeSoft : inbound ? C.orangeSoft : C.violetSoft;
  const iconColor = isConvert ? "#fe6c1c" : inbound ? C.orange : C.violet;

  return (
    <Card style={{ padding: compact ? 16 : 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: "50%",
            background: iconBg,
            display: "grid",
            placeItems: "center",
            color: iconColor,
            flexShrink: 0,
          }}
        >
          {isConvert ? <IconSwap size={18} /> : inbound ? <IconArrowDown size={18} /> : <IconArrowUp size={18} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.ink, whiteSpace: "nowrap" }}>{title}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.ink }}>{primary}</div>
          <div style={{ fontSize: 13, color: C.mut, marginTop: 2 }}>{secondary}</div>
          {!compact && (
            <a
              href={`${ARC.explorer}/tx/${tx.hash}`}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                marginTop: 8,
                textDecoration: "none",
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 700,
                color: C.ink,
                background: C.card,
                border: `1.5px solid ${C.line}`,
                borderRadius: 8,
                padding: "5px 10px",
              }}
            >
              ArcScan ↗
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}
```

New:

```jsx
function TxCard({ tx, compact = false }) {
  const { t, locale } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const inbound = tx.direction === "in";
  const isConvert = tx.kind === "convert_ars_usdc" || tx.kind === "convert_usdc_ars";
  const arsEq = tx.ars;

  const title = isConvert
    ? tx.kind === "convert_ars_usdc"
      ? "ARS → USDC"
      : "USDC → ARS"
    : tx.kind === "charge"
      ? t("movs.charge")
      : tx.who;

  const primary =
    isConvert && tx.kind === "convert_ars_usdc"
      ? `+${fmt(tx.amt, 2, locale)} USDC`
      : isConvert && tx.kind === "convert_usdc_ars"
        ? `−${fmt(tx.amt, 2, locale)} USDC`
        : `${inbound ? "+" : "−"}${fmt(tx.amt, 2, locale)} USDC`;

  const secondary =
    isConvert && tx.kind === "convert_ars_usdc"
      ? `−${fmtArs(arsEq)} ARS`
      : isConvert && tx.kind === "convert_usdc_ars"
        ? `+${fmtArs(arsEq)} ARS`
        : `${inbound ? "+" : "−"}${fmtArs(arsEq)} ARS`;

  const iconBg = isConvert ? C.orangeSoft : inbound ? C.orangeSoft : C.violetSoft;
  const iconColor = isConvert ? "#fe6c1c" : inbound ? C.orange : C.violet;

  const time = tx.createdAt
    ? new Date(tx.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <Card style={{ padding: compact ? 16 : 18 }}>
      <div
        onClick={compact ? undefined : () => setExpanded((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 13, cursor: compact ? "default" : "pointer" }}
      >
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: "50%",
            background: iconBg,
            display: "grid",
            placeItems: "center",
            color: iconColor,
            flexShrink: 0,
          }}
        >
          {isConvert ? <IconSwap size={18} /> : inbound ? <IconArrowDown size={18} /> : <IconArrowUp size={18} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.ink, whiteSpace: "nowrap" }}>{title}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: C.ink }}>{primary}</div>
          <div style={{ fontSize: 13, color: C.mut, marginTop: 2 }}>{secondary}</div>
          {!compact && (
            <a
              href={`${ARC.explorer}/tx/${tx.hash}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                display: "inline-block",
                marginTop: 8,
                textDecoration: "none",
                fontFamily: "inherit",
                fontSize: 12,
                fontWeight: 700,
                color: C.ink,
                background: C.card,
                border: `1.5px solid ${C.line}`,
                borderRadius: 8,
                padding: "5px 10px",
              }}
            >
              ArcScan ↗
            </a>
          )}
        </div>
      </div>

      {!compact && expanded && (
        <TxDetail
          usdc={tx.amt}
          ars={tx.ars}
          fx={tx.fxRate}
          fee={tx.fee}
          block={tx.block}
          factura={tx.factura}
          hash={tx.hash}
          time={time}
        />
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Drop `fxRate` from `Movimientos`'s signature and its `TxCard` call (`src/App.jsx:2212-2247`)**

Old (top and the map line):

```jsx
function Movimientos({ txs, address, fxRate }) {
```

```jsx
        txs.map((tx) => <TxCard key={tx.hash} tx={tx} fxRate={fxRate} />)
```

New:

```jsx
function Movimientos({ txs, address }) {
```

```jsx
        txs.map((tx) => <TxCard key={tx.hash} tx={tx} />)
```

- [ ] **Step 5: Drop `fxRate` from Home's compact `TxCard` call (`src/App.jsx:664`)**

Old: `txs.map((tx) => <TxCard key={tx.hash} tx={tx} fxRate={fxRate} compact />)`

New: `txs.map((tx) => <TxCard key={tx.hash} tx={tx} compact />)`

- [ ] **Step 6: Drop `fxRate` from the `Movimientos` render call (`src/App.jsx:3021`)**

Old: `{tab === "movs" && <Movimientos txs={txs} address={address} fxRate={fxRate} />}`

New: `{tab === "movs" && <Movimientos txs={txs} address={address} />}`

- [ ] **Step 7: Manually verify the full feature end-to-end**

Run in one terminal: `npx netlify functions:serve`. Run in another: `npm run dev`, open the printed local URL, log in.

1. Make a manual "Pay" or voice payment to a contact — confirm Success screen still works identically, including "Ver detalle" showing the same fields as before (no regression from the `TxDetail` extraction).
2. Go to Movimientos — tap the new transaction's card — confirm it expands showing the same detail block (amount, ARS equivalent, exchange rate, network fee, block, time, invoice, ArcScan link) with real data, not placeholders.
3. Tap the ArcScan link inside an expanded card — confirm it opens ArcScan in a new tab and does **not** also collapse/toggle the card (tests the `stopPropagation` fix).
4. Tap the card again (not the link) — confirm it collapses.
5. Do a Charge and a Convert (both directions) — confirm each shows up correctly in Movimientos with the right title (`Cobro`/`ARS → USDC`/`USDC → ARS`), correct in/out sign on both USDC and ARS amounts, and expands with correct detail.
6. Refresh the page — confirm all transactions and their expand-to-detail still work after reload (this is the persistence from Task 4, now visually confirmed with full detail).
7. On Home, confirm the compact activity list still shows summaries only (no tap-to-expand) — no regression.
8. Check the browser console throughout — no errors.

Stop both processes once confirmed.

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "Add TxDetail component and make TxCard expandable in Movimientos"
```

---

## Self-Review

**Spec coverage:**
- §1.1 Arquitectura (mismo patrón que contacts) → Task 2. ✓
- §1.2 Schema, incl. `ars` explícito → Task 1. ✓
- §1.3 API (GET/POST, wire = columnas, conflicto de hash) → Task 2. ✓
- §1.4 Cliente (`loadTransactions`/`addTransaction`, cache, dedupe) → Task 3. ✓
- §1.5/1.6 Env vars / dev workflow (sin cambios nuevos, proxy agregado) → Task 2. ✓
- §2 Flujo de escritura/lectura en `App.jsx` → Task 4. ✓
- §3 UI detalle expandible → Task 5. ✓
- §4 i18n (sin claves nuevas) → confirmed no task adds any; `TxDetail` reuses existing `success.*` keys. ✓
- Fuera de alcance (paginación, reconciliación on-chain, `who` no se retraduce) → no task implements any of these, confirmed absent. ✓

**Placeholder scan:** No TBD/TODO; every step has literal code, exact commands, or a concrete manual-verification procedure with expected output.

**Type/naming consistency:** `Tx` shape (`hash, kind, direction, who, amt, fxRate, ars, factura, block, fee, memo, createdAt`) matches across Task 3's `fromWire`/`toWire`, Task 4's `pushTx` entries, and Task 5's `TxCard`/`TxDetail` props. `mergeByHash(serverList, localList)` signature and argument order matches between its Task 3 definition and both Task 4 call sites (`mergeByHash(cached, prev)`, `mergeByHash(fresh, prev)`). DB column names (`fx_rate`, `created_at`, snake_case) used consistently in Task 1's schema, Task 2's SQL, and Task 3's `toWire`/`fromWire` — never leaked into the camelCase (`fxRate`, `createdAt`) side. `TxDetail`'s prop names (`usdc, ars, fx, fee, block, factura, hash, time`) match between its Task 5 definition and both call sites (`Success`, `TxCard`).
