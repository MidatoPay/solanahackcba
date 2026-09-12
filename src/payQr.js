// Payload del QR/link de cobro P2P: una URL con un único query param `pay`
// que codifica destinatario, nombre a mostrar, monto en ARS y factura.

import { isAddress } from "@solana/kit";

function encodeField(v) {
  return String(v).replace(/[,:]/g, "");
}

/** Arma la URL completa (usa el origin actual: funciona en dev y en prod). */
export function buildPayUrl({ addr, who, ars, factura }) {
  const payload = [
    `addr:${addr}`,
    `who:${encodeField(who)}`,
    `ars:${Number(ars)}`,
    `inv:${encodeField(factura)}`,
  ].join(",");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/?pay=${encodeURIComponent(payload)}`;
}

/**
 * Parsea una URL de cobro (o el string pegado a mano) y devuelve
 * { addr, who, ars, factura }, o null si no es un payload válido.
 */
export function parsePayUrl(input) {
  if (!input) return null;
  let payload;
  try {
    const url = new URL(input, typeof window !== "undefined" ? window.location.origin : undefined);
    payload = url.searchParams.get("pay");
  } catch {
    payload = null;
  }
  if (!payload) return null;

  const fields = {};
  for (const part of decodeURIComponent(payload).split(",")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    fields[part.slice(0, idx)] = part.slice(idx + 1);
  }

  const addr = fields.addr;
  const who = fields.who || "";
  const ars = Number(fields.ars);
  const factura = fields.inv || "";

  if (!addr || !isAddress(addr)) return null;
  if (!Number.isFinite(ars) || ars <= 0) return null;

  return { addr, who, ars, factura };
}

/** Alias propuesto para "guardar como contacto" a partir del nombre del QR. */
export function slugifyAlias(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);
}
