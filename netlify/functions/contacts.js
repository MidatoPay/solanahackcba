// API de la agenda de contactos — puente entre el browser y Postgres (Aiven).
// El browser nunca ve la connection string ni el secret de Privy: esta
// Function es la única pieza que los tiene. Ver
// docs/superpowers/specs/2026-08-05-contacts-agenda-design.md § 1.

import pkg from "pg";
import { PrivyClient } from "@privy-io/server-auth";

const { Pool } = pkg;

let pool;
function getPool() {
  if (!pool) {
    const connectionString = (process.env.AIVEN_PG_URL || "").replace(/[?&]sslmode=[^&]*/, "");
    pool = new Pool({
      // `sslmode=require` en la connection string hace que pg-connection-string
      // arme su propia config SSL y pise el objeto `ssl` de abajo (incluso con
      // rejectUnauthorized: true, termina rechazando el CA cert real como si
      // fuera self-signed) — se lo saca acá y el `ssl` explícito manda solo.
      connectionString,
      ssl: {
        // Env vars no soportan multilínea sin comillas de forma portable
        // (dotenv corta en el primer salto de línea) — el CA cert se guarda
        // en una sola línea con \n literales y se reconstruye acá.
        ca: (process.env.AIVEN_PG_CA_CERT || "").replace(/\\n/g, "\n"),
        rejectUnauthorized: true,
        // Aiven hostea varios servicios en el mismo endpoint y decide qué
        // certificado presentar según el SNI. `pg` abre el socket TCP
        // primero y recién después lo sube a TLS pasándole ese socket ya
        // conectado — en ese modo Node NO deriva el SNI del host solo, hay
        // que pasarlo. Sin esto, Aiven devuelve un cert autofirmado
        // genérico (no el firmado por el Project CA de arriba) y la
        // conexión truena con "self-signed certificate in certificate
        // chain" pese a que el CA cert es el correcto.
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

function rowToContact(row) {
  return { id: row.id, name: row.name, alias: row.alias, address: row.address, note: row.note || "" };
}

export const handler = async (event) => {
  const userId = await authenticate(event);
  if (!userId) return json(401, { error: "unauthorized" });

  const db = getPool();

  try {
    if (event.httpMethod === "GET") {
      const { rows } = await db.query(
        "SELECT id, name, alias, address, note FROM contacts WHERE user_id = $1 ORDER BY created_at DESC",
        [userId]
      );
      return json(200, { contacts: rows.map(rowToContact) });
    }

    if (event.httpMethod === "POST") {
      const { name, alias, address, note } = JSON.parse(event.body || "{}");
      if (!name?.trim() || !alias?.trim() || !address?.trim()) {
        return json(400, { error: "missing_fields" });
      }
      const { rows } = await db.query(
        `INSERT INTO contacts (user_id, name, alias, address, note)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, alias, address, note`,
        [userId, name.trim(), alias.trim().toLowerCase(), address.trim(), (note || "").trim()]
      );
      return json(200, { contact: rowToContact(rows[0]) });
    }

    if (event.httpMethod === "PUT") {
      const { id, name, alias, address, note } = JSON.parse(event.body || "{}");
      if (!id || !name?.trim() || !alias?.trim() || !address?.trim()) {
        return json(400, { error: "missing_fields" });
      }
      const { rows } = await db.query(
        `UPDATE contacts SET name = $1, alias = $2, address = $3, note = $4, updated_at = now()
         WHERE id = $5 AND user_id = $6
         RETURNING id, name, alias, address, note`,
        [name.trim(), alias.trim().toLowerCase(), address.trim(), (note || "").trim(), id, userId]
      );
      if (rows.length === 0) return json(404, { error: "not_found" });
      return json(200, { contact: rowToContact(rows[0]) });
    }

    if (event.httpMethod === "DELETE") {
      const { id } = JSON.parse(event.body || "{}");
      if (!id) return json(400, { error: "missing_fields" });
      const { rowCount } = await db.query("DELETE FROM contacts WHERE id = $1 AND user_id = $2", [id, userId]);
      if (rowCount === 0) return json(404, { error: "not_found" });
      return json(200, { ok: true });
    }

    return json(405, { error: "method_not_allowed" });
  } catch (err) {
    if (err?.code === "23505") {
      return json(400, { error: "alias_duplicate" });
    }
    return json(500, { error: "server_error" });
  }
};
