# Historial de transacciones (Activity) — diseño

## Contexto

Hoy `AppInner` guarda las transacciones en `const [txs, setTxs] = useState([])`
(`App.jsx`), alimentado por `pushTx` desde los cuatro flujos que hacen una tx
on-chain: `sendPayment` (voz/pago manual), `handleCharge`,
`handleConvertArsUsdc`, `handleConvertUsdcArs`. Es puramente en memoria: se
pierde al refrescar la página, cerrar sesión (`setTxs([])` en logout) o
entrar desde otro dispositivo. La pestaña Movimientos (`Movimientos`/`TxCard`)
solo puede mostrar lo que pasó en la sesión actual.

Además, `pushTx` descarta datos que sus llamadores ya tienen disponibles:
`sendNativeUsdc`/`sendTreasuryPayout` devuelven `{hash, block, fee, memo}`,
pero la entrada que se guarda en `txs` solo toma `{hash, who, amt, factura,
fxRate, kind, direction}`. Ese detalle completo (fee, bloque, memo, tipo de
cambio) hoy solo se ve una vez, en la pantalla `Success` justo después de
pagar, y se pierde después.

## Alcance

Incluye: persistencia de transacciones en Postgres (Aiven) por usuario de
Privy, recuperable entre dispositivos y sesiones; carga del historial
completo al loguearse; detalle expandible en Movimientos (fee, bloque,
invoice, tipo de cambio) reutilizando el mismo bloque visual que ya tiene
`Success`.

No incluye (fuera de alcance, no pedido): paginación/límite de resultados,
borrado o edición de transacciones (es un log append-only, no un CRUD como
contactos), reconciliación con el estado on-chain real (ArcScan sigue siendo
la fuente de verdad última — esto es solo un espejo de conveniencia por
usuario), ledger entre dos usuarios de la app (cada fila representa la
transacción desde la perspectiva de quien la inició, igual que hoy).

## 1. Modelo de datos y storage

### 1.1 Arquitectura

Mismo patrón que `netlify/functions/contacts.js`:

```
Browser (App.jsx, src/transactions.js)
  │  fetch("/transactions", { headers: { Authorization: `Bearer <privy access token>` } })
  ▼
Netlify Function — netlify/functions/transactions.js
  │  1. Verifica el token con @privy-io/server-auth → obtiene user.id (DID)
  │  2. Ejecuta la query en Postgres, scopeada a ese user_id
  ▼
Aiven PostgreSQL 18 (SSL, CA cert vía env var, con SNI — ver
netlify/functions/contacts.js para el fix de `servername`)
```

Reutiliza la misma conexión/pool que ya usa `contacts.js` — mismas env vars
(`AIVEN_PG_URL`, `AIVEN_PG_CA_CERT`), sin nuevas dependencias.

### 1.2 Schema — `db/schema.sql`

Se agrega al archivo existente (se corre a mano contra Aiven, igual que la
tabla `contacts`):

```sql
CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,           -- Privy DID
  hash        TEXT NOT NULL UNIQUE,    -- hash on-chain, único globalmente
  kind        TEXT NOT NULL,           -- 'voice' | 'pay' | 'charge' | 'convert_ars_usdc' | 'convert_usdc_ars'
  direction   TEXT NOT NULL,           -- 'in' | 'out'
  who         TEXT NOT NULL,           -- contraparte mostrada (nombre de contacto, "Cobro", "Tesorería")
  amt         NUMERIC NOT NULL,        -- monto en USDC
  fx_rate     NUMERIC NOT NULL,        -- ARS por USDC al momento de la tx
  ars         NUMERIC NOT NULL,        -- monto en ARS al momento de la tx (ver nota abajo)
  factura     TEXT,
  block       BIGINT,
  fee         NUMERIC,                 -- fee de red en USDC
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_user_id_idx ON transactions (user_id, created_at DESC);
```

**`ars` se guarda explícito, no se recalcula.** Decisión revisada: para
`charge` y `convert_ars_usdc`, el ARS es el dato de entrada real (lo que
tipeó el usuario / cobró el comercio) y `usdc` es el derivado
(`arsToUsdc(ars, fxRate)` en `fx.js`, sin redondear). Reconstruir
`ars = amt * fx_rate` en el cliente sería un `(ars / fxRate) * fxRate` que en
punto flotante no siempre reproduce el número original bit a bit. Más
importante que la precisión: en esos dos flujos el ARS ya es el monto que
efectivamente se acreditó/debitó en `arsBalance` (`arsDelta` en `flows.js`)
— es un hecho de negocio, no un valor derivado para mostrar. Las cuatro
funciones que arman una entrada de `txs` (`runChargeFlow`,
`runConvertArsToUsdc`, `runConvertUsdcToArs`, `sendPayment` en `App.jsx`) ya
calculan y devuelven `ars` hoy (`result.ars` en las tres primeras;
`parsed.usdc * (parsed.fxRate || fxRate)` inline en `sendPayment`) — no hace
falta ningún cálculo nuevo, solo dejar de descartarlo al armar la entrada de
`pushTx`.

Tampoco se guarda un timestamp pre-formateado (`"06:49 PM"`): se usa
`created_at` y se formatea en el cliente con el locale activo al momento de
render, no el de cuando se hizo la tx.

`hash` es `UNIQUE` (no `(user_id, hash)`) porque un hash de tx es único en
toda la chain — sirve además como protección natural contra inserts
duplicados si el `POST` se reintenta.

### 1.3 API — `netlify/functions/transactions.js`

| Método | Acción |
|---|---|
| `GET /transactions` | Lista las transacciones del usuario del token, `ORDER BY created_at DESC` |
| `POST /transactions` | Alta — body `{ hash, kind, direction, who, amt, fx_rate, ars, factura, block, fee, memo }` |

Sin `PUT`/`DELETE` — es un log append-only, no un CRUD.

El body/response de la Function usa los mismos nombres que las columnas
(`fx_rate`, `created_at`, snake_case) — igual que `contacts.js`, que expone
`address` tal cual (sin traducir a/desde `addr`). La Function no hace ningún
mapeo de nombres; arma la fila con `SELECT`/`INSERT` directo. La traducción
camelCase (`fxRate`, `createdAt`, consistente con el resto de `App.jsx`/
`flows.js`) vive enteramente en el cliente, vía `toWire`/`fromWire` en
`src/transactions.js` — mismo lugar y mismo patrón que ya usa `contacts.js`
para `addr` ↔ `address`.

Errores: `401` si el token no verifica, `400` si faltan campos requeridos
(`hash`, `kind`, `direction`, `who`, `amt`, `fx_rate`, `ars`), `500` genérico para
errores de DB. El conflicto de `hash` duplicado (`23505`, mismo código que ya
mapea `contacts.js` para alias duplicado) se responde `200` con la fila
existente en vez de error — un reintento de POST con el mismo hash no debe
verse como una falla real.

### 1.4 Cliente — `src/transactions.js`

Mismo rol que `src/contacts.js`: módulo de lógica separado de la UI, cliente
HTTP con cache en `localStorage`.

```js
Tx = { hash, kind, direction, who, amt, fxRate, ars, factura, block, fee, memo, createdAt }
```

- **Cache stale-while-revalidate**, clave `mp_tx_cache_<user_id>`: mismo
  patrón que `contacts.js` — sirve cache al instante vía `onCache`, el `GET`
  real pisa cache + estado cuando responde. El server siempre gana.
- `loadTransactions(userId, token, onCache)` — igual forma que
  `loadContacts`.
- `addTransaction(userId, token, list, data)` — `POST` fire-and-forget desde
  el llamador (ver § 2 flujo de escritura); actualiza cache tras la
  confirmación del server, pero **no** bloquea ni puede fallar el flujo de
  pago que la llama.
- Dedupe por `hash` al mergear una lista fresca del server con lo que ya
  había en memoria (evita duplicar la entrada optimista que `pushTx` ya puso
  en `txs` antes de que el `POST` termine).

### 1.5 Env vars

Ninguna nueva — reutiliza `AIVEN_PG_URL`, `AIVEN_PG_CA_CERT`, `PRIVY_APP_SECRET`
ya configuradas para `contacts.js`.

### 1.6 Dev workflow

Sin cambios — ya corre bajo el mismo `netlify functions:serve` /
`vite.config.js` proxy que usa `/contacts`; se agrega la entrada
`/transactions` al proxy de dev y a `netlify.toml` (redirect), igual que las
existentes.

## 2. Integración en `App.jsx`

### Flujo de escritura

`pushTx` (hoy en `App.jsx:2761`) se extiende para:
1. Aceptar también `block`, `fee`, `memo` y `ars` en la entrada. Todos ya
   están disponibles en cada uno de los 4 call sites sin cálculo nuevo:
   `block`/`fee`/`memo` vienen del `result`/`tx` que devuelven
   `sendNativeUsdc`/`sendTreasuryPayout`; `ars` viene de `result.ars` en
   `handleCharge`/`handleConvertArsUsdc`/`handleConvertUsdcArs` (ya lo
   devuelve `flows.js`), y en `sendPayment` se calcula igual que ya hace hoy
   el objeto que arma para `Success` (`parsed.usdc * (parsed.fxRate ||
   fxRate)`).
2. Seguir agregando la entrada al estado local `txs` de inmediato (UI
   optimista, sin esperar red — sin cambios respecto a hoy).
3. Disparar `addTransaction(...)` en fire-and-forget (`.catch(() => {})`) —
   la tx on-chain ya se confirmó y el usuario ya vio su éxito antes de este
   punto; un fallo de red/DB acá no debe afectar el flujo de pago.

### Flujo de lectura

`AppInner` agrega un `useEffect` keyed en `user.id` (mismo patrón que el que
ya carga `contacts`) que llama `loadTransactions(user.id, token, onCache)` y
reemplaza `txs` con el resultado — mergeado por `hash` con lo que ya hubiera
en memoria de la sesión actual. `setTxs([])` en logout se mantiene sin
cambios.

## 3. UI — detalle expandible en Movimientos

El bloque de detalle que hoy vive inline en `Success` (`App.jsx` ~2080-2107:
monto, equivalente ARS, tipo de cambio, fee de red, bloque, hora, invoice,
link a ArcScan) se extrae a un componente compartido `TxDetail({ tx, fxRate
})`, usado por:
- `Success` (sin cambios de comportamiento — mismo lugar, mismo trigger
  "Ver detalle").
- `TxCard` en `Movimientos`: tocar la tarjeta expande/colapsa el mismo
  bloque, con los datos ahora persistidos (`fee`, `block`, `memo`,
  `factura`, `ars`) en vez de solo estar disponibles en la sesión donde se
  hizo el pago.

`TxCard` hoy calcula `arsEq = tx.amt * (tx.fxRate || fxRate)` para mostrar el
monto en pesos en la card compacta — pasa a usar directamente `tx.ars`
(guardado, no recalculado), consistente con la decisión de §1.2. El
parámetro `fxRate` (cotización *actual*) que hoy recibe `TxCard` deja de
usarse para ese cálculo — cada transacción ya trae su propio `fxRate`
histórico.

La vista compacta de Home (`TxCard compact`) no gana detalle expandible —
sigue siendo un resumen, igual que hoy; el detalle completo queda reservado
para la pestaña Movimientos.

## 4. i18n

Sin claves nuevas — `TxDetail` reutiliza las claves `success.amountSent`,
`success.equals`, `success.exchangeRate`, `success.networkFee`,
`success.block`, `success.time`, `success.invoiceLabel`,
`success.onchainCheck`, `success.viewOnArcScan` que ya existen en
`src/i18n.jsx` para ambos idiomas.

## Fuera de alcance / decisiones explícitas

- Sin paginación ni límite de filas — igual que `contacts.js`, se trae la
  lista completa del usuario. Aceptable para el volumen de uso actual (demo);
  si se vuelve un problema real, es un cambio acotado al `GET` (`LIMIT`) sin
  tocar el schema.
- Sin reconciliación con el estado real on-chain (confirmaciones, reorgs) —
  se guarda lo que el flujo cliente ya sabe en el momento en que la tx se dio
  por confirmada, igual que hace hoy `Success`/`Movimientos`.
- `who` guarda el string ya traducido al idioma activo en el momento de la
  tx (mismo comportamiento que tiene hoy `pushTx` en memoria) — si el usuario
  cambia de idioma después, las transacciones viejas no se retraducen. No es
  una regresión (el comportamiento actual en memoria ya tiene esta
  limitación) y no se pidió resolverlo.
