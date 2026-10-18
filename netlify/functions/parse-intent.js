// Proxy server-side a Anthropic para el parser de voz.
// ANTHROPIC_API_KEY vive solo acá (sin prefijo VITE_).

import { PrivyClient } from "@privy-io/server-auth";

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

function anthropicKey() {
  // Preferir nombre sin VITE_. Fallback VITE_* solo para migrar .env local;
  // al no referenciarse en el client, Vite no lo mete en el bundle.
  return (process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY || "").trim();
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

function buildPrompt(text, lang, aliases) {
  const list = Array.isArray(aliases) ? aliases.map(String) : [];
  const prompt = lang === "en"
    ? `You are MidatoPay's voice payment agent. Extract the intent from this English command and respond ONLY with valid JSON, no markdown or extra text.

Command: "${text}"

Valid contact aliases: ${list.join(", ")}

Exact format:
{"intent":"send"|"charge"|"unknown","amount":<number or null>,"currency":"USDC"|"ARS","recipient":"<closest matching contact alias or null>","confidence":<0 to 1>}

Rules: "charge"/"collect" means the user wants to request/collect a payment, not send one — recipient is always null for "charge". "dollars", "usd" or "usdc" → USDC. "pesos" or "ars" → ARS. If the currency isn't stated or is unclear, default to USDC for "send" — never guess ARS — and to ARS for "charge". Match the alias even if misheard (e.g. "caty" → "katy").`
    : `Sos el agente de pagos por voz de MidatoPay. Extraé la intención de este comando en español rioplatense y respondé SOLO con JSON válido, sin markdown ni texto extra.

Comando: "${text}"

Contactos válidos (alias): ${list.join(", ")}

Formato exacto:
{"intent":"send"|"charge"|"unknown","amount":<número o null>,"currency":"USDC"|"ARS","recipient":"<alias del contacto más parecido o null>","confidence":<0 a 1>}

Reglas: "cobrar"/"charge"/"collect" significa que el usuario quiere solicitar un pago, no enviarlo — recipient siempre es null para "charge". "dólares", "usd" o "usdc" → USDC. "pesos" o "ars" → ARS. Si la moneda no está clara o no se menciona, default a USDC para "send" — nunca asumas ARS — y a ARS para "charge". Matcheá el alias aunque esté mal transcripto (ej: "caty" → "katy").`;
  const currency = process.env.APP_COUNTRY === 'AR' ? 'ARS' : 'COP';
  return prompt.replaceAll('ARS', currency).replaceAll('ars', currency.toLowerCase())
    .replace('español rioplatense', currency === 'COP' ? 'español de Colombia' : 'español rioplatense');
}

export const handler = async (event) => {
  const method = event.httpMethod || event.method || "GET";

  if (method === "GET") {
    return json(200, { configured: Boolean(anthropicKey()) });
  }

  if (method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const userId = await authenticate(event);
  if (!userId) return json(401, { error: "unauthorized" });

  const key = anthropicKey();
  if (!key) return json(503, { error: "no-key" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const text = String(body.text || "").trim();
  if (!text || text.length > 500) return json(400, { error: "invalid_text" });
  const lang = body.lang === "en" ? "en" : "es";
  const aliases = Array.isArray(body.aliases) ? body.aliases.slice(0, 100) : [];

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{ role: "user", content: buildPrompt(text, lang, aliases) }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return json(502, { error: data?.error?.message || `anthropic_${res.status}` });
    }
    const raw = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return json(200, { intent: parsed });
  } catch {
    return json(503, { error: 'intent_parser_unavailable' });
  }
};
