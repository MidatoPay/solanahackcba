// Polyfills que Privy necesita y el navegador no trae
import { Buffer } from "buffer";
if (typeof window !== "undefined") {
  if (!window.Buffer) window.Buffer = Buffer;
  if (!window.global) window.global = window;
  if (!window.process) window.process = { env: {} };
}

import React from "react";
import ReactDOM from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import App from "./App.jsx";
import { RPC_PROXY, WSS_URL } from "./chain.js";

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID || "";

function MissingAppId() {
  return (
    <div style={{ minHeight: "100vh", background: "#070B14", color: "#F2F5FA", fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ maxWidth: 460, lineHeight: 1.6 }}>
        <h2 style={{ marginBottom: 8 }}>Falta el App ID de Privy</h2>
        <p style={{ color: "#8A94A8", fontSize: 14 }}>
          Creá una app gratis en <b>dashboard.privy.io</b>, copiá el App ID y agregalo al archivo <code>.env</code>:
        </p>
        <pre style={{ background: "#0E1524", border: "1px solid #1C2740", borderRadius: 12, padding: 14, fontSize: 12, overflowX: "auto" }}>
VITE_PRIVY_APP_ID=tu_app_id
        </pre>
        <p style={{ color: "#8A94A8", fontSize: 13 }}>
          En el dashboard activá los métodos de login <b>Email</b> y <b>SMS</b>, habilitá <b>Embedded wallets</b> para <b>Solana</b>,
          y agregá el dominio (localhost y el de Netlify). Después reiniciá el servidor.
        </p>
      </div>
    </div>
  );
}

const solanaRpc = createSolanaRpc(RPC_PROXY);
const solanaRpcSubscriptions = createSolanaRpcSubscriptions(WSS_URL);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {APP_ID ? (
      <PrivyProvider
        appId={APP_ID}
        config={{
          loginMethods: ["email", "sms"],
          appearance: {
            theme: "dark",
            accentColor: "#4D9FFF",
            logo: undefined,
            walletList: [],
            walletChainType: "solana-only",
          },
          embeddedWallets: {
            solana: {
              createOnLogin: "users-without-wallets",
            },
            showWalletUIs: false,
          },
          solana: {
            rpcs: {
              "solana:devnet": {
                rpc: solanaRpc,
                rpcSubscriptions: solanaRpcSubscriptions,
              },
            },
          },
        }}
      >
        <App />
      </PrivyProvider>
    ) : (
      <MissingAppId />
    )}
  </React.StrictMode>
);
