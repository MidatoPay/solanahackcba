# Nombre de usuario Privy en el historial — diseño

## Contexto

Hoy la identificación de la contraparte en una transacción (`who`) tiene
sólo dos niveles: el nombre de un contacto guardado en la agenda propia
(`contacts`), o la address corta como fallback. No hay ningún concepto de
"nombre de cuenta Midato" — Privy no expone un username; lo que la app
muestra como nombre propio (`nombre` en `App.jsx`) se deriva 100% en el
cliente a partir del email/teléfono (`email.split("@")[0]`, capitalizado) y
nunca se manda al servidor.

Esto produce dos huecos concretos, encontrados al revisar el código:

1. **Reconciliación** (`netlify/functions/lib/reconcile.js`, del trabajo de
   background reconciliation): si quien envía una transferencia entrante es
   otro usuario de Midato pero no está guardado como contacto del receptor,
   se muestra la address corta — aunque la app sepa perfectamente quién es
   esa persona.
2. **QR de Cobrar** (`Charge` en `App.jsx`): el payload del QR/link manda
   `who: t("charge.merchantSelf")` — un label genérico ("Tu comercio"), no
   el nombre real de quien cobra. Quien escanea ve "Pagarle a Tu comercio"
   en vez del nombre de la persona.

Un tercer hueco relacionado, encontrado de paso: la detección **en vivo**
del que cobra (`handleChargeDetected`, mientras la pantalla de Cobrar está
abierta) escribe `who: "Tu comercio"` en su propia fila de transacción —
ni siquiera intenta identificar quién le pagó.

## Alcance

Agregar una columna `name` a la tabla `wallets` (ya existe, del trabajo de
reconciliación) con el nombre derivado del email/teléfono del usuario
(mismo cálculo que ya hace el cliente), poblada igual que `address` — vía
`GET /transactions`, gateada por el mismo chequeo de ownership que ya
protege esa tabla. Se usa en tres lugares:

1. **Reconciliación:** nueva prioridad de 3 niveles para `who` — contacto
   propio → `wallets.name` de la address emisora → address corta.
2. **QR/link de Cobrar:** el payload manda el nombre real de quien cobra en
   vez del label genérico. Arregla, sin tocarlas, dos pantallas que ya
   consumen ese mismo campo (la confirmación de `Pay` al escanear, y el
   "out" del pagador en `sendPayment`).
3. **Detección en vivo del que cobra:** se cambia el label sin sentido
   ("Tu comercio") por la address corta de quien pagó — no resuelve el
   nombre real en ese momento (decisión explícita, ver §2), pero deja de
   mostrar un dato incorrecto.

**Decisiones explícitas tomadas durante el diseño:**
- Se guarda el nombre **derivado** (ej. "Juan"), no el email/teléfono
  crudo — no se expone el dato de contacto real de nadie a otro usuario.
- El nombre real de otro usuario de Midato **sí se muestra** como
  contraparte aunque no esté guardado como contacto — mismo espíritu que
  la agenda, pero automático entre usuarios de la app.
- El nombre vive **sólo en Postgres**, nunca en el memo on-chain — así se
  puede corregir si el usuario cambia de email, y no se filtra
  públicamente vía ArcScan con carácter permanente.
- Por esa misma decisión, la detección en vivo (que corre 100% en el
  browser, sin acceso a Postgres) no puede resolver el nombre real sin
  agregar una llamada nueva al backend en cada detección — se decidió no
  agregarla; la detección en vivo usa address corta, y sólo la
  reconciliación de fondo (que sí tiene DB) resuelve el nombre real.

No incluye (fuera de alcance, no pedido): resolver el nombre real en la
detección en vivo (requeriría una llamada al backend en el hot path de
polling, descartado explícitamente); unicidad de nombres entre usuarios;
cualquier cambio a la agenda de contactos (`contacts`), que sigue siendo
un mecanismo separado y con prioridad más alta.

## 1. Storage y población

### 1.1 Schema — `db/schema.sql`

```sql
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS name TEXT;
```

Se agrega al final del archivo, después del bloque de `wallets` ya
existente. Idempotente (`IF NOT EXISTS`), mismo patrón que el resto del
archivo — no hace falta el `DO $$` que usó la migración de constraint de
`transactions`, `ADD COLUMN IF NOT EXISTS` ya cubre "no fallar si ya
corrió antes".

### 1.2 Población — `GET /transactions`

El `GET` ya acepta `?address=` (con el chequeo de ownership agregado en el
review de seguridad de la reconciliación: sólo se hace upsert si la
address pertenece al usuario autenticado, vía
`getPrivy().getUser(userId).linkedAccounts`). Se extiende a aceptar
también `?name=`, incluido en el mismo `UPSERT` gateado por
`if (owned)` — no hace falta un chequeo de ownership nuevo para el nombre,
ya viene protegido por estar dentro del mismo bloque: si el usuario probó
que es dueño de esa address, puede actualizar el nombre asociado a su
propia fila.

Cap defensivo antes de guardar: `String(name).slice(0, 60)`. No es dato de
un tercero (como los memos del review de seguridad) — es lo que el propio
usuario autenticado declara de sí mismo — pero un cap barato evita
sorpresas de un email con formato raro.

### 1.3 Cliente

- `src/transactions.js`'s `loadTransactions(userId, token, address, name,
  onCache)` — gana el parámetro `name`, mandado como
  `encodeURIComponent(name)` en la query string, mismo patrón que
  `address`.
- `src/App.jsx`'s efecto de carga (el mismo que ya pasa `address`) pasa
  también `nombre` (ya calculado en `AppInner`, sin cálculo nuevo).
- Autocorrección natural: si el usuario cambia de email, `nombre` cambia
  del lado del cliente, y la próxima carga de `GET /transactions` pisa el
  valor viejo en `wallets.name` — sin lógica adicional.

## 2. Uso — reconciliación, QR, y detección en vivo

### 2.1 Reconciliación — `netlify/functions/lib/reconcile.js`

`who` pasa de 2 a 3 niveles de prioridad:

```
1. contacto propio (SELECT name FROM contacts WHERE user_id = $1 AND LOWER(address) = LOWER($2))
2. wallets.name de la address emisora, SELECT name FROM wallets WHERE LOWER(address) = LOWER($1)  [nuevo]
3. address corta (fallback actual)
```

El nivel 2 se consulta sólo si el nivel 1 no matcheó — no agrega una
query extra en el caso común (contacto ya guardado).

### 2.2 QR/link de Cobrar — `Charge` en `App.jsx`

`Charge` gana la prop `nombre` (ya calculado en `AppInner`, se pasa igual
que `address`/`fxRate` hoy). La llamada a `buildPayUrl` pasa de:

```js
buildPayUrl({ addr: address, who: t("charge.merchantSelf"), ars, factura })
```

a:

```js
buildPayUrl({ addr: address, who: nombre, ars, factura })
```

Esto arregla, sin tocarlas, dos pantallas que ya leen `qr.who`:
- La confirmación de `Pay` al escanear (`t("pay.payTo", qr.who || short(qr.addr))`).
- El "out" del pagador en `sendPayment`, vía `parsed.contact.name` (que ya
  viene de `qr.who`).

### 2.3 Detección en vivo — `handleChargeDetected` / `findIncomingTransfer`

`findIncomingTransfer` (en `src/arc.js`) gana `from` en su objeto de
retorno — el dato ya está disponible en el bloque escaneado
(`tx.from`), sólo hace falta incluirlo:

```js
return { hash: tx.hash, block: blockNumber, fee, from: tx.from };
```

`handleChargeDetected`, al armar la entrada para `pushTx`, cambia:

```js
who: t("charge.merchantSelf"),
```

por:

```js
who: short(found.from),
```

No resuelve el nombre real (decisión explícita en §Alcance — evita una
llamada al backend en el hot path de polling), pero deja de mostrar un
label que no identifica a nadie.

## 3. Errores y edge cases

- **Usuario nuevo sin fila en `wallets.name` todavía:** reconciliación cae
  al fallback de address corta hasta que esa persona loguee al menos una
  vez después de este cambio — mismo comportamiento de "bootstrap" ya
  aceptado para el resto de la reconciliación (mapeo `user_id → address`).
- **Dos usuarios con el mismo nombre derivado** (ej. dos emails que
  arrancan con "Juan"): no hay unicidad ni se necesita — es sólo un label
  de display; un contacto personal desambigua si hace falta, igual que
  hoy con nombres de contacto duplicados.
- **Ownership del nombre:** cubierto por el mismo gate `if (owned)` que ya
  protege `address` — no es una superficie nueva de ataque.
- **`name` con caracteres raros en la query string:** `encodeURIComponent`
  del lado del cliente, cap de 60 caracteres del lado del servidor antes
  de guardar.

## Fuera de alcance / decisiones explícitas

- Resolver el nombre real en la detección en vivo del que cobra — requiere
  una llamada al backend en el hot path de polling; se decidió
  explícitamente no agregarla. La corrección real llega vía reconciliación
  de fondo (siempre que la pantalla de Cobrar no haya escrito la fila
  primero con el hash — ver la limitación ya documentada en el spec de
  reconciliación sobre `ON CONFLICT DO NOTHING`).
- Nombre en el memo on-chain — decisión explícita de mantenerlo sólo en
  Postgres, por privacidad (no queda pegado para siempre a una tx pública)
  y corregibilidad (se puede actualizar si el usuario cambia de email).
- Unicidad de nombres, verificación de identidad, o cualquier noción de
  "username" reservado — es un label de display derivado, no una
  identidad verificada.
