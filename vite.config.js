import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { publicSecretVariables } from "./scripts/public-env-policy.js";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const privateVariables=publicSecretVariables({...env,...process.env});
  if(privateVariables.length)throw new Error(`Variables privadas con prefijo público VITE_: ${privateVariables.join(", ")}. Usá los nombres privados de Functions y quitá estas variables del build.`);

  return {
    plugins: [react()],
    define: {
      global: "globalThis",
    },
    optimizeDeps: {
      esbuildOptions: { define: { global: "globalThis" } },
    },
    server: {
      proxy: {
        "/security": {target:"http://127.0.0.1:9999",changeOrigin:true,rewrite:path=>path.replace(/^\/security/,"/.netlify/functions/security")},
        "/quote": {target:"http://127.0.0.1:8888",changeOrigin:true},
        "/balance": {target:"http://127.0.0.1:8888",changeOrigin:true},
        "/wallet": {target:"http://127.0.0.1:9999",changeOrigin:true,rewrite:path=>path.replace(/^\/wallet/,"/.netlify/functions/wallet")},
        "/transfers": {target:"http://127.0.0.1:9999",changeOrigin:true,rewrite:path=>path.replace(/^\/transfers/,"/.netlify/functions/transfers")},
        "/treasury/export-access": {target:"http://127.0.0.1:9999",changeOrigin:true,rewrite:()=>"/.netlify/functions/treasury-export-access"},
        "/merchant-profile": {
          target:"http://127.0.0.1:9999",changeOrigin:true,
          rewrite:(path)=>path.replace(/^\/merchant-profile/,"/.netlify/functions/merchant-profile"),
        },
        "/merchant-pos": {
          target:"http://127.0.0.1:9999",changeOrigin:true,
          rewrite:(path)=>path.replace(/^\/merchant-pos/,"/.netlify/functions/merchant-pos"),
        },
        "/payment-reports": {
          target:"http://127.0.0.1:9999",changeOrigin:true,
          rewrite:(path)=>path.replace(/^\/payment-reports/,"/.netlify/functions/payment-reports"),
        },
        "/charges": {
          target: "http://127.0.0.1:9999", changeOrigin: true,
          rewrite: (path) => path.replace(/^\/charges/, "/.netlify/functions/charges"),
        },
        "/webhooks/mercadopago": {
          target: "http://127.0.0.1:9999", changeOrigin: true,
          rewrite: (path) => path.replace(/^\/webhooks\/mercadopago/, "/.netlify/functions/mercadopago-webhook"),
        },
        "/rpc": {
          target: "http://127.0.0.1:8888",
          changeOrigin: true,
        },
        "/eth-rpc": {
          target: "http://127.0.0.1:8888",
          changeOrigin: true,
        },
        "/contacts": {
          target: "http://127.0.0.1:9999",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/contacts/, "/.netlify/functions/contacts"),
        },
        "/transactions": {
          target: "http://127.0.0.1:9999",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/transactions/, "/.netlify/functions/transactions"),
        },
        "/treasury": {
          target: "http://127.0.0.1:9999",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/treasury/, "/.netlify/functions/treasury"),
        },
        "/parse-intent": {
          target: "http://127.0.0.1:9999",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/parse-intent/, "/.netlify/functions/parse-intent"),
        },
      },
    },
  };
});
