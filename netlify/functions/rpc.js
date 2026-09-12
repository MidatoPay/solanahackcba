// Proxy al RPC de Solana Devnet — replica en producción lo que vite.config.js
// hace en desarrollo (evitar bloqueos CORS del navegador contra el RPC).
// Target configurable desde el dashboard de Netlify con VITE_SOLANA_RPC.
const TARGET = process.env.VITE_SOLANA_RPC || process.env.VITE_ARC_RPC || "https://api.devnet.solana.com";

export const handler = async (event) => {
  try {
    const res = await fetch(TARGET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: event.body,
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { "Content-Type": "application/json" },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: String(err?.message || err) }),
    };
  }
};
