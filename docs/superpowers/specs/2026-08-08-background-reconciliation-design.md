# Reconciliación de fondo — diseño

## Contexto

El cobro P2P por QR (`docs/superpowers/specs/2026-08-08-qr-charge-design.md`)
dejó un hueco documentado explícitamente como fuera de alcance: la detección
del pago vive enteramente en el cliente de quien cobra (polling de balance +
`findIncomingTransfer` mientras la pantalla "Esperando pago" está montada).
Si esa pantalla se cierra, o la app está apagada, el pago llega on-chain
igual pero nunca se escribe en `transactions` — el saldo lo refleja, pero
Movimientos no.

El mismo hueco existe, más ampliamente, para **cualquier** transferencia
entrante que el destinatario no haya generado desde su propio cliente en el
momento exacto: un `send` común de otro usuario de Midato, o una
transferencia desde una wallet externa. Hoy nada del lado del que recibe
registra esas transacciones, tenga o no la app abierta.

Investigando cómo cerrar esto se encontró un dato clave: **ArcScan
(`testnet.arcscan.app`) es una instancia de Blockscout** y expone una API
REST (`/api/v2/addresses/{address}/transactions`) que devuelve, paginado,
`hash`, `from`/`to` (objetos `{hash, ...}`), `value`, `raw_input` (el memo,
hex-encoded), `block_number`, `timestamp`, `fee` y `status` — con un filtro
`?filter=to` para traer sólo las entrantes. Verificado contra la instancia
real (ver mensajes de este chat). Esto evita depender del RPC público de
Arc para reconciliar — el mismo RPC que ya sabemos que rate-limita agresivo
(de ahí `withRetry` en `arc.js`) — y da todo lo necesario en una sola
llamada por página, sin tener que escanear bloques crudos.

## Alcance

Dos mecanismos combinados, compartiendo la misma lógica de reconciliación:

1. **Job programado** (Netlify Scheduled Function, cada 15 minutos):
   recorre todas las wallets conocidas y reconcilia cada una contra ArcScan.
   Cubre el caso "la app está apagada".
2. **Reconciliación al reabrir**: la misma llamada `GET /transactions` que
   ya se hace al montar la app reconcilia primero la wallet de *ese* usuario
   (usando su propio checkpoint) y recién después devuelve el historial. Sin
   llamada nueva del cliente — el usuario ve su historial al día apenas
   entra, sin esperar al próximo tick del job.

Cubre **cualquier** transferencia USDC nativa entrante a una wallet
conocida por la app, no sólo cobros QR: si el memo decodifica como
`MIDATO|v1|...` se reconstruye `kind`/`factura`/`ars` tal como los armó
quien envió; si no (transferencia externa, o memo no reconocible), se
registra igual con `kind: "received"` y el remitente como `who` (nombre de
contacto si está en la agenda del receptor, si no `short(address)`).

No incluye (fuera de alcance, no pedido): reconciliar transferencias
salientes (ya se registran client-side al momento de enviarlas — ver
`pushTx`); reconciliar wallets que nunca hicieron login en la app (no hay
`user_id` al que asociarlas); back-fill completo de historial viejo más
allá de una ventana acotada en el primer sync (ver §5, es una limitación
permanente, no "se pone al día después"); reintentos con backoff
sofisticado si ArcScan está caído — un fallo del job en una corrida se
resuelve solo en la siguiente.

## 1. Nueva tabla `wallets`

```sql
CREATE TABLE IF NOT EXISTS wallets (
  user_id            TEXT PRIMARY KEY,     -- Privy DID (una wallet por usuario, embedded wallet)
  address            TEXT NOT NULL,
  last_synced_block  BIGINT,               -- checkpoint: bloque más alto ya reconciliado
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallets_address_idx ON wallets (address);
```

Se agrega a `db/schema.sql`, mismo patrón que `contacts`/`transactions`
(se corre a mano contra Aiven).

**Cómo se puebla:** `GET /transactions` acepta un query param `address`
opcional (`?address=0x...`). Si viene y es una address válida
(`ethers.isAddress`), la Function hace `INSERT ... ON CONFLICT (user_id) DO
UPDATE SET address = EXCLUDED.address, updated_at = now()` antes de
reconciliar — así la tabla siempre refleja la wallet activa del usuario, y
no hace falta ningún endpoint nuevo. El cliente (`src/transactions.js`,
`loadTransactions`) pasa la `address` que ya tiene disponible en
`AppInner` en cada carga.

## 2. Módulo compartido de reconciliación

**`netlify/functions/lib/reconcile.js`** (carpeta `lib/` para que Netlify
no la trate como una función propia — sólo los archivos directos de
`netlify/functions/*.js`, o `nombre/nombre.js`, se registran como rutas).
Usado tanto por el job programado como por `GET /transactions`.

```js
// Reconciliación compartida: trae transferencias USDC entrantes de ArcScan
// (Blockscout) para una address y las inserta en `transactions` si faltan.
// Usado por netlify/functions/reconcile-wallets.js (job) y
// netlify/functions/transactions.js (GET, al reabrir). Ver
// docs/superpowers/specs/2026-08-08-background-reconciliation-design.md.

const ARCSCAN_API = "https://testnet.arcscan.app/api/v2";
const MAX_PAGES_FIRST_SYNC = 3; // ~150 txs — acota el costo del primer sync de una wallet nueva

/** Decodifica raw_input (hex) a { text, fields }. fields es null si el texto
 *  no matchea el formato MIDATO|v1|... (pero el texto se guarda igual, si
 *  es UTF-8 válido, para no perder referencia de un memo no reconocido). */
function decodeMemo(rawInputHex) {
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
  return { text, fields }; // fields: { inv, to, cur, amt, kind } — lo que puso armarMemo
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
 * Reconcilia una wallet: trae páginas de ArcScan hasta llegar a
 * last_synced_block (o hasta MAX_PAGES_FIRST_SYNC si no hay checkpoint),
 * inserta lo que falte, devuelve el nuevo checkpoint.
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

      const decoded = decodeMemo(tx.raw_input); // { text, fields } | null
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

**Nota sobre `fxRate` reconstruida, no "de ahora":** si el memo trae
`cur:ARS` + `amt` (caso `charge_p2p` y cualquier `pay` hecho en ARS), la
cotización real de ese pago se reconstruye como `ars_del_memo / usdc_real`
— evita que un job que corre hasta 15 minutos tarde le asigne una
cotización distinta a la que efectivamente aplicó. Sólo se usa la
cotización live (`getFxRate`, que llama `fetchArsPerUsd` — ver § 3.1)
cuando no hay ese dato (memo ausente, o pago hecho directamente en USDC) —
mismo nivel de aproximación que ya acepta hoy `sendPayment` para un envío
en USDC.

## 3. Job programado — `netlify/functions/reconcile-wallets.js`

Mismo estilo V1 (`export const handler`) que el resto de las Functions de
este repo — el scheduling se declara en `netlify.toml`, no cambia la firma
de la función:

```js
// Job de reconciliación: corre cada 15 min (ver netlify.toml), recorre
// todas las wallets conocidas y reconcilia cada una contra ArcScan. No
// requiere auth — no lo dispara un usuario, lo dispara el scheduler de
// Netlify. Ver docs/superpowers/specs/2026-08-08-background-reconciliation-design.md.

import pkg from "pg";
import { reconcileWallet } from "./lib/reconcile.js";
import { fetchArsPerUsd } from "../../src/priceFeed.js"; // ver § 3.1

const getFxRate = () => fetchArsPerUsd(process.env.VITE_ETH_RPC || "https://ethereum.publicnode.com");

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

### 3.1 Cotización del lado del servidor

`src/fx.js`'s `getArsPerUsdc` (usada en el cliente) pasa por el proxy
`/eth-rpc` para evitar CORS del browser — pero `src/priceFeed.js`'s
`fetchArsPerUsd(rpcUrl)`, la función que hace la lectura real de
`latestAnswer()`, ya recibe la URL del RPC como parámetro y no toca
`window` salvo para calcular su default. Nada impide importarla
directamente desde una Function (esbuild bundlea igual que ya bundlea
`@privy-io/server-auth`): `reconcile-wallets.js` y `transactions.js`
llaman `fetchArsPerUsd(process.env.VITE_ETH_RPC ||
"https://ethereum.publicnode.com")` — mismo target que ya usa
`eth-rpc.js` server-side, sin RPC ni módulo nuevo.

### 3.2 `netlify.toml`

```toml
# Job de reconciliación de wallets — ver
# docs/superpowers/specs/2026-08-08-background-reconciliation-design.md.
[functions."reconcile-wallets"]
  schedule = "*/15 * * * *"
```

## 4. Reconciliación al reabrir — `GET /transactions`

`netlify/functions/transactions.js`'s `GET` handler, antes del `SELECT`:

```js
if (event.httpMethod === "GET") {
  const address = event.queryStringParameters?.address;
  if (address && ethers.isAddress(address)) {
    await db.query(
      `INSERT INTO wallets (user_id, address, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET address = EXCLUDED.address, updated_at = now()`,
      [userId, address]
    );
    const { rows: walletRows } = await db.query("SELECT last_synced_block FROM wallets WHERE user_id = $1", [userId]);
    try {
      const newCheckpoint = await reconcileWallet(db, {
        userId,
        address,
        lastSyncedBlock: walletRows[0]?.last_synced_block ?? null,
        getFxRate: () => fetchArsPerUsd(process.env.VITE_ETH_RPC || "https://ethereum.publicnode.com"),
      });
      if (newCheckpoint != null) {
        await db.query("UPDATE wallets SET last_synced_block = $1 WHERE user_id = $2", [newCheckpoint, userId]);
      }
    } catch {
      // Si ArcScan falla acá, no bloquea la carga del historial existente
      // — se reintenta en la próxima apertura o en el próximo tick del job.
    }
  }

  const { rows } = await db.query(/* ... el SELECT que ya existe ... */);
  return json(200, { transactions: rows });
}
```

`ethers` y `fetchArsPerUsd` (de `src/priceFeed.js`, ver § 3.1) se agregan
a los imports de `transactions.js` — `ethers` ya es dependencia del
proyecto (usada en el cliente); Netlify Functions con `node_bundler =
"esbuild"` bundlea ambos igual que ya bundlea `@privy-io/server-auth`.

### 4.1 Cliente — `src/transactions.js` / `App.jsx`

`loadTransactions(userId, token, address, onCache)` gana un parámetro
`address`; internamente arma `` `/transactions?address=${address}` `` en
vez de `/transactions` a secas. `AppInner`'s efecto de carga (`App.jsx`,
el que ya llama `loadTransactions` al montar) agrega `address` a su lista
de dependencias — así, si la wallet todavía no existía cuando el efecto
corrió la primera vez (creación de wallet embebida asincrónica), se
vuelve a disparar apenas `address` deja de estar vacío, sin lógica nueva.

## 5. Errores y edge cases

- **ArcScan caído o rate-limitando:** `fetchArcScanPage` deja que el error
  suba; en el job, se captura por-wallet y sigue con las demás (§3); en
  `GET /transactions`, se captura y no bloquea la respuesta (§4) — el
  historial existente siempre se sirve.
- **Wallet nueva sin checkpoint (`last_synced_block IS NULL`):** se acota a
  `MAX_PAGES_FIRST_SYNC` páginas (~150 txs, las más recientes — ArcScan
  devuelve más nuevo primero) para no colgar la primera reconciliación de
  una wallet con mucho historial previo a este feature. **Importante:**
  esto es una limitación permanente, no algo que se resuelve solo después.
  El checkpoint que queda es el bloque más alto de esas ~150 txs
  procesadas; cualquier transacción *más vieja* que ese punto de corte
  nunca se va a reconciliar en corridas futuras, porque cada corrida sólo
  mira transacciones por encima del checkpoint. Documentado explícito acá,
  no silencioso: si hace falta el historial completo desde el día uno para
  una wallet con mucha actividad previa, hay que subir el cap o quitarlo
  (a costa de una primera corrida más lenta para esa wallet).
- **Memo no-MIDATO o transferencia externa:** `kind: "received"`, `who` =
  contacto si `tx.from` está en la agenda del receptor, si no
  `short(address)` — mismo patrón que ya usa `Pay` para addresses sin
  alias.
- **Doble reconciliación (job y "al reabrir" procesan la misma tx):**
  cubierto por el mismo `ON CONFLICT (user_id, hash) DO NOTHING` que ya
  protege reintentos de POST — no importa cuál de los dos mecanismos llega
  primero.
- **Reconciliar algo que el propio cliente ya registró en tiempo real**
  (ej. un cobro QR con la pantalla abierta, que ya se guardó vía
  `handleChargeDetected`): mismo `ON CONFLICT` — la reconciliación es un
  no-op para esa fila, no se duplica ni se pisa.
- **`tx.value` en formato hex/string grande:** Blockscout devuelve `value`
  como string decimal de wei — `Number(tx.value) / 1e18` alcanza para los
  montos de esta demo (sin overflow real de `Number` en este rango); no
  hace falta `BigInt`/`ethers.formatEther` server-side sólo por esto, pero
  si se prefiere consistencia con `arc.js` se puede usar
  `ethers.formatEther(BigInt(tx.value))` sin cambiar el resultado.

## 6. Verificación manual

Sin test runner en el repo. Verificación con Aiven real y ArcScan real (no
hay forma de mockear esto barato):

- **Migración de schema:** correr `db/schema.sql` contra Aiven, confirmar
  que `wallets` existe con las columnas esperadas (mismo script node+`pg`
  que ya se usó para las migraciones anteriores de este proyecto).
- **Población de `wallets`:** loguearse en la app, confirmar en Aiven que
  aparece una fila en `wallets` con la address de la wallet Privy del
  usuario.
- **Reconciliación al reabrir:** desde otra wallet (o `Pay`/`Convert` de
  este mismo usuario a otra address), mandar una transferencia entrante
  *sin* tener la pantalla de cobro abierta; recargar la app (nuevo `GET
  /transactions`); confirmar que la transacción aparece en Movimientos con
  `kind`/`who` correctos según si el memo era MIDATO o no.
- **Job programado:** desplegado a Netlify (esto no corre en
  `netlify functions:serve` — los scheduled functions no se disparan solos
  en dev), invocar el endpoint a mano (`netlify functions:invoke
  reconcile-wallets` o `curl` al deploy preview) y confirmar en los logs de
  Netlify Functions que procesa las wallets y actualiza `last_synced_block`.
- **Checkpoint funciona:** correr la reconciliación dos veces seguidas
  contra la misma wallet sin transacciones nuevas en el medio — confirmar
  que la segunda corrida no reinserta nada (0 filas nuevas) y que
  `last_synced_block` no retrocede.
- **Regresión:** confirmar que `GET /transactions` sin `address` (por si
  quedó algún caller viejo) sigue funcionando — sólo se salta la
  reconciliación, no rompe.

## Fuera de alcance / decisiones explícitas

- No reconcilia salientes — ya se registran client-side al momento de
  enviar.
- No hace back-fill completo de historial pre-existente más allá del cap
  de `MAX_PAGES_FIRST_SYNC` en el primer sync de cada wallet.
- No hay reintentos con backoff dentro de una misma corrida — un fallo se
  resuelve en la corrida siguiente (job) o la próxima apertura (reabrir).
- No cubre wallets que nunca hicieron login (no hay `user_id` al que
  asociar la fila).
- Depende de la API de Blockscout de ArcScan, que no tiene documentación
  oficial pública — es un tercero fuera del control de este repo. Si deja
  de responder o cambia de forma, la reconciliación se degrada a "no pasa
  nada" (no rompe nada existente, sólo deja de ponerse al día) hasta que se
  actualice el cliente HTTP en `lib/reconcile.js`.
