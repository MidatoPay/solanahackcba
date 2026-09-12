// Proxy al RPC de Ethereum Mainnet — necesario para leer el Price Feed
// Chainlink desde el browser sin CORS. Replica el patrón de rpc.js (Arc).
const TARGET = process.env.VITE_ETH_RPC || "https://ethereum.publicnode.com";

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
