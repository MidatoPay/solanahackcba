import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { networkConfig } from "./src/network.js";
import { publicSecretVariables } from "./scripts/public-env-policy.js";

export default defineConfig(({ mode }) => {
  // Colombia launchers load .env.colombia explicitly. Vite must not merge the
  // unrelated legacy .env (including its public variables) into that build.
  const envDir = process.env.APP_COUNTRY === "CO" ? false : process.cwd();
  const env = { ...(envDir ? loadEnv(mode, envDir, "") : {}), ...process.env };
  const privateVariables=publicSecretVariables({...env,...process.env});
  if(privateVariables.length)throw new Error(`Variables privadas con prefijo público VITE_: ${privateVariables.join(", ")}. Usá los nombres privados de Functions y quitá estas variables del build.`);
  // RPC de Solana Devnet. Poné VITE_SOLANA_RPC en .env (Triton/Helius) para
  // no depender del RPC público (que limita las consultas).
  const target = env.SOLANA_RPC || env.VITE_SOLANA_RPC || networkConfig(env.VITE_SOLANA_CLUSTER || "devnet").rpc;
  // RPC de Ethereum Mainnet para el Price Feed Chainlink USD/ARS.
  const ethTarget = env.ETH_RPC_URL || env.VITE_ETH_RPC || "https://ethereum.publicnode.com";

  return {
    envDir,
    plugins: [react()],
    define: {
      global: "globalThis",
    },
    optimizeDeps: {
      esbuildOptions: { define: { global: "globalThis" } },
    },
    server: {
      watch: { ignored: ['**/.netlify/**'] },
      fs: {
        // Keep Vite's credential-file defaults and also protect local tooling
        // configs/binaries when a developer forwards this server through ngrok.
        deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.netlify/**'],
      },
      proxy: {
        "/app-config": {target:"http://127.0.0.1:9999",changeOrigin:true,rewrite:()=>"/.netlify/functions/app-config"},
        "/platform": {target:"http://127.0.0.1:9999",changeOrigin:true,rewrite:path=>path.replace(/^\/platform/,"/.netlify/functions/platform")},
        "/webhooks/onepay": {target:"http://127.0.0.1:9999",changeOrigin:true,rewrite:()=>"/.netlify/functions/onepay-webhook"},
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
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rpc/, ""),
        },
        "/eth-rpc": {
          target: ethTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/eth-rpc/, ""),
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
