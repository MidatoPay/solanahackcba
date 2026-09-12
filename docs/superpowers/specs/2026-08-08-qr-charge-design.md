# Cobro P2P por QR — diseño

## Contexto

Hoy "Cobrar" (`Charge` en `App.jsx:802-830`, orquestado por `runChargeFlow`
en `flows.js`) no es un cobro entre dos usuarios: el usuario ingresa un
monto en ARS, se simula un pago fiat (`fiatRail.receiveArsPayment`) y la
tesorería (`treasury.js`) le envía a **sí mismo** el equivalente en USDC. Es
un cash-in simulado, no una transferencia P2P — no hay una segunda persona
ni una segunda wallet involucrada en ningún punto del flujo.

Aparte, se investigó si las conversiones ARS↔USDC iniciadas por voz
persisten en la base de transacciones (mismo mecanismo que investiga este
documento en general). Resultado: **la voz no tiene intent de conversión.**
`localParse` y `claudeParse` (`App.jsx:100-156`) sólo devuelven
`intent: "send"` o `"unknown"`, y `Voice.analyze` (`App.jsx:1539`) descarta
cualquier otro resultado. `handleConvertArsUsdc`/`handleConvertUsdcArs` (que
sí llaman `pushTx` correctamente) sólo son alcanzables desde el formulario
manual `Convert` en Stack. No es un bug de persistencia — es que la
funcionalidad de "convertir por voz" no existe. Queda fuera de alcance de
este documento (no fue pedida como feature nueva); se deja registrado acá
como hallazgo.

## Alcance

Reemplaza "Cobrar" por un flujo P2P real entre dos wallets de Privy sobre
Arc: quien cobra ingresa un monto en ARS y muestra un QR (+ link); quien
paga lo escanea (o abre el link) desde su propia sesión de la app, confirma,
y se ejecuta una transferencia nativa USDC directa entre las dos wallets —
sin tesorería de por medio.

No incluye (fuera de alcance, no pedido): expiración/invalidación del link
tras el primer cobro (un link puede pagarse más de una vez — señalado en
diseño, decisión pospuesta explícitamente); reconciliación server-side o vía
indexer de pagos entrantes si quien cobra cierra la pantalla antes de
recibir el pago; voz para iniciar un cobro o un pago por QR; conversión por
voz (ARS↔USDC) — hallazgo de contexto, no parte de este trabajo.

## 1. Formato del QR y del link

### 1.1 Payload

URL real del sitio, usando el `origin` activo (funciona igual en
`localhost:5173` y en producción) con un único query param `pay`:

```
https://<origin>/?pay=addr:<address>,who:<nombre>,ars:<monto>,inv:<factura>
```

Mismo campo único (en vez de varios query params) para no pelear con
encoding/orden; se parsea con un split simple, análogo a como ya se arman
memos on-chain con `armarMemo` en `arc.js` (mismo espíritu, formato propio,
no on-chain en este caso).

`factura` se genera con `nuevaFactura()` (ya existe en `arc.js`) al montar
la pantalla de cobro.

### 1.2 Generación (lado de quien cobra)

- Librería nueva: `qrcode` (genera a `<canvas>`/data-URL, sin dependencias
  nativas) — codifica la URL completa de 1.1.
- Debajo del QR: el link se muestra como texto seleccionable, con un botón
  "Copiar".

### 1.3 Lectura (lado de quien paga)

Dos entradas al mismo parser (`parsePayUrl(url) → { addr, who, ars, factura
} | null`, valida `ethers.isAddress(addr)` y `ars` numérico > 0):

- **Cámara in-app:** librería nueva `jsqr` (decodificador QR puro JS sobre
  frames de `<video>`/`<canvas>`, sin WASM). Pide `getUserMedia` con
  `facingMode: "environment"`, decodifica con `requestAnimationFrame`. Si la
  cámara no está disponible o el permiso se deniega, fallback a un campo de
  texto "o ingresá el link" (mismo `parsePayUrl` sobre el string pegado).
- **Deep link:** `AppInner` lee `window.location.search` en el montaje
  inicial. Si hay `?pay=...`:
  - Si el usuario no está logueado, Privy muestra su login normal primero
    (el query string persiste porque no hay redirect fuera de la SPA).
  - Autenticado, en vez de caer en Home, la app navega directo a la pantalla
    de confirmar pago con los datos ya decodificados — mismo `parsePayUrl`
    reutilizado.

## 2. Flujo — quien cobra

Reemplaza el componente `Charge` actual (`App.jsx:802`) y `runChargeFlow`
(`flows.js`) deja de usarse (se puede eliminar junto con lo que quede sólo
para ese camino — `fiatRail.receiveArsPayment` si no lo usa nadie más).

1. Ingresa monto en ARS (misma validación que hoy: número positivo).
2. Se genera `factura`, se arma la URL de 1.1 con la address propia
   (`address`, ya disponible en `AppInner`) y el nombre a mostrar (ver §4).
3. Pantalla "Esperando pago": QR + link + monto ARS, botón cancelar.
4. Mientras está montada: polling liviano de `getUsdcBalance(address)` (ya
   existe en `arc.js`) cada ~5s, comparado contra el balance capturado al
   entrar a la pantalla.
5. Al detectar una suba: **una** búsqueda acotada de los últimos ~20 bloques
   (`readProvider.getBlock(n, true)` en loop corto) buscando una tx con
   `to === address`; si hay más de una candidata, se desambigua decodificando
   el memo (UTF-8 de `tx.data`) y comparando `factura`. El scan pesado sólo
   corre una vez, disparado por el balance-diff — no hay polling continuo de
   bloques (protege el rate limit del RPC público, mismo motivo que ya
   documenta `withRetry` en `arc.js`).
6. Con el hash ubicado: `pushTx({ hash, who: <nombre de quien pagó, si se
   conoce, si no la address corta>, amt: usdc, fxRate: <cotización vigente al
   detectar>, ars, factura, block, fee, memo, kind: "charge_p2p", direction:
   "in" })` — mismo objeto que ya arma `handleCharge` hoy, mismo `pushTx`.
7. Transición a pantalla de éxito (reutiliza `Success`, ya soporta mostrar
   detalle por `kind`).

## 3. Flujo — quien paga

Nueva entrada dentro del flujo de envío existente (junto a la voz): un
toggle/botón "Escanear QR" que abre la cámara in-app (§1.3).

1. Al decodificar un payload válido: valida que `addr` no sea la propia
   address (bloquea "pagarte a vos mismo" con error explícito).
2. Cotiza `ars → usdc` con el `fxRate` **vigente al momento de confirmar**
   (no el que hubiera al generar el QR — cotización no se congela, ya
   decidido). Mismas validaciones que ya existen en `sendPayment`/
   `Voice.analyze`: `usdc < 0.01` y `usdc > balance` bloquean con el mismo
   mensaje de error que ya usan.
3. Pantalla de confirmación: "Pagarle a `<who>` — `$<ars>` (~`<usdc>` USDC)".
   El ARS se muestra prominente y el USDC como equivalente aproximado, para
   que quede claro qué es lo fijo.
4. Confirmar → memo `armarMemo({ inv: factura, kind: "charge_p2p", cur:
   "ARS", amt: ars, to: who })`, `sendNativeUsdc(signer, { to: addr, usdc,
   memo })` — mismo signer/mecánica que ya usa `sendPayment`, sólo que el
   destino sale del QR en vez de la agenda de contactos.
5. `pushTx({ hash, who, amt: usdc, fxRate, ars, factura, block, fee, memo,
   kind: "charge_p2p", direction: "out" })` — mismo patrón que `sendPayment`
   hoy.
6. Si `addr` no está en la agenda de contactos del que pagó: prompt "¿Guardar
   a `<who>` como contacto?" antes de volver a Home (opcional, no bloquea el
   flujo).

## 4. Nombre a mostrar (`who`)

El nombre de quien cobra viene de su cuenta Privy (mismo campo `nombre` que
ya se pasa hoy a `Mas`) y viaja en el payload del QR/link. Si por algún
motivo el nombre no está disponible, se usa `short(address)` (helper ya
existente en `App.jsx`) como fallback — igual que ya hace el resto de la app
con addresses sin alias.

## 5. Schema — `db/schema.sql`

La tabla `transactions` tiene hoy `hash TEXT NOT NULL UNIQUE` (global, no
por usuario) — correcto mientras cada hash pertenece a un único usuario (el
que inició la tx). Con el cobro P2P, **dos** usuarios distintos insertan una
fila para el mismo hash (quien cobra: `direction: "in"`; quien paga:
`direction: "out"`) — con la constraint actual el segundo insert de ese
mismo hash colisiona.

Migración (se corre a mano contra Aiven, igual que el resto de este
archivo):

```sql
ALTER TABLE transactions DROP CONSTRAINT transactions_hash_key;
ALTER TABLE transactions ADD CONSTRAINT transactions_user_hash_key UNIQUE (user_id, hash);
```

`netlify/functions/transactions.js` ajusta su `ON CONFLICT (hash)` a
`ON CONFLICT (user_id, hash)` en el `INSERT` — el resto de la Function (que
ya filtra todo por `user_id`) no cambia.

## 6. Errores y edge cases

- **Cámara no disponible/denegada:** fallback a campo de texto para pegar el
  link (mismo `parsePayUrl`).
- **QR/link inválido:** `parsePayUrl` devuelve `null` → error "Código QR
  inválido", no se intenta ningún pago.
- **Pagarse a uno mismo:** bloqueado antes de llegar a confirmar.
- **Balance insuficiente / monto bajo el mínimo:** reutiliza las
  validaciones existentes de `sendPayment`/`Voice`.
- **Pago duplicado (doble submit del lado de quien cobra):** cubierto por el
  `ON CONFLICT (user_id, hash) DO NOTHING` de §5 — un segundo insert del
  mismo hash es no-op, devuelve la fila existente (mismo comportamiento que
  ya tiene la Function hoy para reintentos).
- **Cerrar la pantalla de espera antes de cobrar:** no hay reconciliación de
  fondo — el saldo on-chain sí refleja el pago, pero no se crea la fila en
  Movimientos hasta que quien cobra vuelva a abrir esa pantalla mientras el
  pago está pendiente. Aceptado explícitamente (demo, sin colas/jobs).
- **Link reusado (alguien paga un link ya cobrado antes):** no hay
  invalidación en este v1 — pagar dos veces el mismo link genera dos
  transferencias reales e independientes, cada una con su propio hash,
  registradas por separado. Riesgo de UX conocido, decisión pospuesta.

## 7. Verificación manual

Sin test runner en el repo. Verificación con dos sesiones reales en
paralelo, `npx netlify functions:serve` corriendo (si no, los `pushTx`
fallan en silencio — ver CLAUDE.md), dos wallets fondeadas en Arc Testnet:

- **Camino feliz:** A cobra, genera QR; B escanea y paga. A ve el pago
  reflejado sin recargar; ambos ven el mismo `hash` en Movimientos con
  `direction` opuesta y montos ARS/USDC coherentes.
- **Deep link:** repetir con B abriendo el link copiado en vez de escanear,
  incluyendo el caso deslogueado (login de Privy no debe perder `?pay=...`).
- **Edge cases de §6:** cámara denegada, QR corrupto, auto-pago, monto bajo
  mínimo, saldo insuficiente.
- **Migración de schema:** confirmar en un entorno de prueba que
  `UNIQUE(user_id, hash)` permite dos filas con igual `hash` y distinto
  `user_id` antes de aplicar contra la instancia real de Aiven.
- **Regresión:** enviar por voz y las conversiones manuales (`Convert`)
  siguen funcionando y persistiendo igual que antes.

## Fuera de alcance / decisiones explícitas

- Sin expiración de cotización — el ARS es lo fijo, el USDC se recalcula al
  confirmar el pago (no al generar el QR).
- Sin invalidación de link/QR tras el primer cobro (§6, pospuesto).
- Sin reconciliación de fondo para pagos recibidos con la pantalla cerrada.
- Conversión ARS↔USDC por voz: no existe hoy, no se agrega en este trabajo
  (hallazgo documentado en Contexto).
