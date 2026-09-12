import { isAddress } from "@solana/kit";

// Cliente HTTP de la agenda de contactos, con cache stale-while-revalidate
// en localStorage. La fuente de verdad es Postgres (vía la Netlify Function
// en /contacts); el cache solo evita que la pantalla arranque vacía mientras
// carga. Ver docs/superpowers/specs/2026-08-05-contacts-agenda-design.md § 1.4.

const CACHE_PREFIX = "mp_contacts_cache_";
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

// El modelo de contacto en la UI usa `addr` (así ya lo consume App.jsx);
// la columna en Postgres es `address`. Estas dos funciones traducen en el
// borde de la red para no tener que renombrar el campo en toda la app.
function toWire({ name, alias, addr, note }) {
  return { name: name.trim(), alias: alias.trim().toLowerCase(), address: addr.trim(), note: (note || "").trim() };
}

function fromWire(row) {
  return { id: row.id, name: row.name, alias: row.alias, addr: row.address, note: row.note || "" };
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
 * Sirve el cache al instante (vía onCache, si hay algo cacheado) y en
 * paralelo pide la lista real a /contacts; la respuesta del server pisa el
 * cache y es lo que resuelve la promise. Si el request falla (red/DB caída),
 * se resuelve con lo que había en cache en vez de rechazar, para no romper
 * la pantalla — el server sigue siendo la fuente de verdad la próxima vez
 * que cargue bien.
 */
export function loadContacts(userId, token, onCache) {
  const cached = readCache(userId);
  if (onCache) onCache(cached);
  if (!userId || !token) return Promise.resolve(cached);
  return api("/contacts", token)
    .then(({ contacts }) => {
      const list = contacts.map(fromWire);
      writeCache(userId, list);
      return list;
    })
    .catch(() => cached);
}

export async function addContact(userId, token, list, data) {
  const { contact } = await api("/contacts", token, { method: "POST", body: JSON.stringify(toWire(data)) });
  const next = [fromWire(contact), ...list];
  writeCache(userId, next);
  return next;
}

export async function updateContact(userId, token, list, id, data) {
  const { contact } = await api("/contacts", token, { method: "PUT", body: JSON.stringify({ id, ...toWire(data) }) });
  const next = list.map((c) => (c.id === id ? fromWire(contact) : c));
  writeCache(userId, next);
  return next;
}

export async function removeContact(userId, token, list, id) {
  await api("/contacts", token, { method: "DELETE", body: JSON.stringify({ id }) });
  const next = list.filter((c) => c.id !== id);
  writeCache(userId, next);
  return next;
}

/** Resuelve un alias hablado a un contacto: match exacto primero, luego "contiene". */
export function findByAlias(list, alias) {
  const a = (alias || "").toLowerCase();
  if (!a) return null;
  return list.find((c) => c.alias === a) || list.find((c) => a.includes(c.alias)) || null;
}

export function searchContacts(list, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.alias.toLowerCase().includes(q));
}

export function validateContact({ name, alias, addr }, list, editingId) {
  const errors = {};
  if (!name || !name.trim()) errors.name = "required";

  const aliasNorm = (alias || "").trim().toLowerCase();
  if (!aliasNorm) {
    errors.alias = "required";
  } else if (list.some((c) => c.alias === aliasNorm && c.id !== editingId)) {
    errors.alias = "duplicate";
  }

  if (!addr || !isAddress(addr.trim())) errors.addr = "invalid";

  return { valid: Object.keys(errors).length === 0, errors };
}
