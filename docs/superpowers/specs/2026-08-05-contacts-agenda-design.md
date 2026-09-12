# Agenda de contactos — diseño

> **Actualización 2026-08-06:** la Sección 1 (modelo de datos y storage) fue
> reemplazada — pasa de `localStorage` a Postgres (Aiven) vía una Netlify
> Function, para que la agenda persista por usuario de Privy entre
> dispositivos. El resto del diseño (UI, integración con voz, i18n) no
> cambió. Ver también el plan de implementación actualizado en
> `docs/superpowers/plans/2026-08-05-contacts-agenda.md`.
>
> Nota: la versión `localStorage` de este diseño (Sección 1 original) ya se
> implementó y mergeó vía PR #5 (`jm-1-agenda`) antes de esta actualización.
> La migración a Postgres reemplaza esa implementación, no arranca de cero.

## Contexto

`src/App.jsx` usa un array hardcodeado `CONTACTS` (4 contactos fijos) para resolver a quién le vas a pagar cuando usás el flujo de voz. No hay forma de agregar, editar o borrar contactos desde la app.

Existe un branch (`santiago-1-agenda`, en `origin`) con una implementación de agenda, pero está escrito contra una versión del código con arquitectura distinta (`src/components/` separados) que nunca existió en este repo — no es aplicable como parche ni como base de merge. Este diseño es una implementación nueva, acotada a lo pedido: guardar contactos y direcciones de wallet, dentro de la arquitectura actual (todo en `App.jsx` + módulos de lógica en `src/*.js`, siguiendo el patrón ya usado por `arc.js`/`fx.js`/`flows.js`/`treasury.js`).

## Alcance

Incluye: alta/edición/borrado/búsqueda de contactos, persistencia en Postgres (Aiven) por usuario de Privy — recuperable entre dispositivos —, uso de esos contactos en el flujo de voz existente.

No incluye (fuera de alcance, no pedido): acciones rápidas de pagar/cobrar desde la agenda, rediseño del FAB de voz, extracción de `Home`/`BalanceCard` a componentes separados — eso era parte del branch de Santiago pero no de este pedido.

## 1. Modelo de datos y storage

### 1.1 Arquitectura

El browser no puede hablar Postgres directo (no hay driver client-side, y exponer
la connection string de Aiven en el bundle sería un agujero de seguridad). Se
agrega una capa de API, mismo patrón que `netlify/functions/rpc.js` /
`eth-rpc.js` ya usan para proxyear RPC:

```
Browser (App.jsx, src/contacts.js)
  │  fetch("/contacts", { headers: { Authorization: `Bearer <privy access token>` } })
  ▼
Netlify Function — netlify/functions/contacts.js
  │  1. Verifica el token con @privy-io/server-auth → obtiene user.id (DID)
  │  2. Ejecuta la query en Postgres, scopeada a ese user_id (nunca al que
  │     mande el cliente en el body/query — así no hay forma de pedir
  │     contactos ajenos falsificando un id)
  ▼
Aiven PostgreSQL 18 (SSL, CA cert vía env var)
```

Solo la Function tiene la connection string y `PRIVY_APP_SECRET`; nunca llegan
al browser.

### 1.2 Schema — `db/schema.sql`

Se corre a mano una vez contra Aiven (`psql` o su consola web); queda
versionado en el repo.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,           -- Privy DID (p.ej. "did:privy:abc123")
  name        TEXT NOT NULL,
  alias       TEXT NOT NULL,
  address     TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contacts_user_id_idx ON contacts (user_id);

-- UNIQUE de tabla no acepta expresiones — el alias case-insensitive único
-- por usuario se garantiza con un índice único aparte, no un constraint.
CREATE UNIQUE INDEX contacts_user_alias_uidx ON contacts (user_id, LOWER(alias));
```

El índice único `contacts_user_alias_uidx` es la garantía de fondo para
alias duplicado; la validación en JS (abajo) sigue existiendo para dar el
error lindo en el form antes de pegarle al server.

### 1.3 API — `netlify/functions/contacts.js`

Un handler, ruteado por método HTTP. Todas las queries filtran por
`WHERE user_id = $1`, con el `user_id` que sale de verificar el token.

| Método | Acción |
|---|---|
| `GET /contacts` | Lista los contactos del usuario del token |
| `POST /contacts` | Alta — body `{ name, alias, address, note }` |
| `PUT /contacts` | Edición — body `{ id, name, alias, address, note }` |
| `DELETE /contacts` | Borrado — body `{ id }` |

(`id` va en el body, no en la URL — las Netlify Functions clásicas no
parsean path params, así se evita depender de redirects con `:splat`.)

Errores: `401` si el token no verifica, `400` si falla validación (alias
duplicado mapeado desde el `UNIQUE` de Postgres, campos faltantes), `500`
genérico para errores de DB sin exponer detalle interno.

Conexión a Postgres vía `pg`, con SSL usando el CA cert de Aiven (no
`rejectUnauthorized: false` — valida la identidad real del server).

### 1.4 Cliente — `src/contacts.js`

Mismo rol que antes (módulo de lógica separado de la UI, patrón
`fx.js`/`treasury.js`/`arc.js`), pero ahora es un cliente HTTP con cache en
`localStorage` en vez de dueño directo del storage:

```js
Contact = { id, name, alias, address, note }
```

- Sin campo `ini`: las iniciales se derivan de `name` al vuelo, igual que ya
  hace `Mas` con el avatar del usuario.
- **Cache stale-while-revalidate**, clave `mp_contacts_cache_<user_id>`: al
  cargar la pantalla se muestra el cache al instante (si existe) mientras se
  dispara el `GET /contacts` real en paralelo; la respuesta del server pisa
  el cache y el estado en memoria. El server siempre gana — no hay merge ni
  resolución de conflictos.
- Los writes (alta/edición/borrado) esperan la confirmación del `POST`/
  `PUT`/`DELETE` antes de actualizar cache y estado — no hay optimistic
  updates, así se evita mostrar un cambio que después el server rechaza
  (p.ej. alias duplicado).
- Arranca **vacía** para cuentas nuevas — no hay contactos semilla. El array
  `CONTACTS` hardcodeado se elimina de `App.jsx`.

Funciones exportadas (misma forma que el diseño original, ahora async donde
implica red, y reciben el access token de Privy para autenticar el request):
- `loadContacts(userId, token)` — sirve cache si existe, dispara
  `GET /contacts`, actualiza cache+devuelve la lista fresca cuando responde.
- `addContact(userId, token, data)`, `updateContact(userId, token, id, data)`,
  `removeContact(userId, token, id)` — `POST`/`PUT`/`DELETE` contra la
  Function; actualizan el cache local solo tras la confirmación del server.
- `findByAlias(list, alias)` — case-insensitive, sigue siendo un helper puro
  sobre el array en memoria, usado por el parser de voz.
- `validateContact({ name, alias, address }, list, editingId)` — sin cambios:
  `name` requerido, `alias` requerido/único case-insensitive, `address` debe
  pasar `ethers.isAddress(...)`. Sigue corriendo client-side antes del
  request, como primera línea de feedback.

### 1.5 Dependencias y env vars nuevas

- `pg` (node-postgres) — cliente Postgres, usado solo en la Function.
- `@privy-io/server-auth` — verificación del access token server-side.
- Netlify CLI (dev dependency) — para `netlify functions:serve` en local.

```bash
# .env / .env.example — server-side only, SIN prefijo VITE_
AIVEN_PG_URL=postgres://user:pass@host:port/dbname
# Sin `?sslmode=require`: pg-connection-string lo interpreta como
# verify-full y pisa el `ssl.ca` explícito de abajo (rompe la conexión
# aunque el CA cert sea válido). El código en contacts.js lo saca de
# todas formas por las dudas, pero mejor no incluirlo acá.
AIVEN_PG_CA_CERT="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
# En una sola línea con \n literales (dotenv no soporta multilínea sin
# comillas); netlify/functions/contacts.js hace .replace(/\\n/g, "\n").
PRIVY_APP_SECRET=...   # dashboard de Privy — distinto de VITE_PRIVY_APP_ID (pública)
```

En Netlify (producción) se configuran en el dashboard del sitio, igual que
las `VITE_*` existentes.

### 1.6 Dev workflow

A diferencia de `/rpc` (que en dev pega directo al RPC público sin necesitar
la Function), acá no hay fallback posible sin la Function corriendo — Postgres
no es accesible directo desde el browser en ningún entorno.

- `vite.config.js` suma un proxy: `/contacts` → `http://localhost:9999/.netlify/functions/contacts`
  (puerto default de `netlify functions:serve`).
- Flujo local: `netlify functions:serve` en una terminal, `npm run dev` en
  otra. Documentado en CLAUDE.md.

## 2. UI — pantalla de Agenda + nav

### Pestaña nueva

Barra de navegación pasa de 4 a 5 tabs: `Home · Movimientos · Stack · Agenda · Más`, más el FAB de voz flotante (sin cambios, sigue siendo la única puerta al flujo de voz).

### Fix de layout en `.mp-nav`

Hoy el hueco para el FAB se logra con `marginRight`/`marginLeft` hardcodeados en los índices 1 y 2 de un array de 4 tabs — no escala a 5 tabs. Se reemplaza por un spacer explícito: el array de tabs se separa en dos mitades (`Math.floor(tabs.length / 2)` a la izquierda, el resto a la derecha) con un `div` de ancho fijo invisible en el medio, dentro del mismo contenedor `flex`. Con 5 tabs queda 2 a la izquierda (Home, Movimientos) y 3 a la derecha (Stack, Agenda, Más). El FAB sigue posicionado con `left: 50%` vía CSS existente, sin cambios en `index.html`.

### `ContactsScreen` (nuevo componente en `App.jsx`, mismo estilo que `Movimientos`/`Stack`)

- Buscador simple arriba (filtra por nombre o alias, client-side).
- Botón "+ Agregar contacto" abre un formulario inline (no modal): nombre, alias, dirección, nota opcional.
- Tocar una fila de la lista abre el mismo formulario en modo edición, prellenado. Dentro del form en modo edición, botón "Borrar contacto".
- Errores de validación inline bajo cada campo, mismo patrón visual que ya usan `Charge`/`Convert` para sus errores (`Card` con fondo `#FDECEA`, texto `C.red`).
- Cada fila: círculo con inicial + nombre + alias + dirección corta (`short()`), botón de copiar dirección reutilizando el patrón ya usado en `Home`.

## 3. Integración con el flujo de voz

- `AppInner` agrega estado `contacts`, cargado con `loadContacts(user.id, token)` (DID de Privy, no la wallet) en un `useEffect` keyed en `user.id` — mismo patrón que el `useEffect` de `arsBalance`, pero keyed en el usuario logueado en vez de la wallet.
- `contacts` + sus mutadores (`addContact`/`updateContact`/`removeContact`, que ya persisten contra la Function internamente) se pasan a `ContactsScreen`.
- `contacts` (solo lectura) se pasa a `Voice`.
- `localParse` y `claudeParse` dejan de leer la constante global `CONTACTS`; reciben la lista de aliases como parámetro para construir el prompt / regex de matching.
- `Voice.analyze` resuelve el contacto con `findByAlias(contacts, recipient)` en vez de `CONTACTS.find(...)`.
- Caso especial: si `contacts.length === 0` y el usuario intenta un pago por voz, mensaje específico ("Todavía no cargaste contactos — andá a Agenda") en vez del genérico "no encontré ese alias", en los dos idiomas.

## 4. i18n

Nuevas claves en `src/i18n.jsx`, agregadas en paralelo a `en` y `es` (mismo patrón que el resto del archivo):

- `nav.agenda` — label de la pestaña.
- `agenda.title`, `agenda.subtitle`, `agenda.searchPlaceholder`, `agenda.addButton`.
- `agenda.form.*` — labels de campos (nombre, alias, dirección, nota), botones (guardar/cancelar/borrar).
- `agenda.errors.*` — mensajes de validación (nombre requerido, alias requerido, alias duplicado, dirección inválida).
- `agenda.empty` — estado vacío ("Todavía no tenés contactos").
- `voice.noContactsYet` — mensaje específico para el caso de agenda vacía en el flujo de voz.

No se toca `Charge`, `Convert`, `Success` ni `Movimientos` — no usan contactos.

## Fuera de alcance / decisiones explícitas

- No se migran los 4 contactos hardcodeados como semilla — la agenda arranca vacía (decisión explícita del usuario).
- No se implementa el branch `santiago-1-agenda` tal cual ni se hace merge con `--allow-unrelated-histories` — es una reimplementación acotada sobre la arquitectura actual.
