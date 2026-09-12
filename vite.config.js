import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // RPC de Solana Devnet. Poné VITE_SOLANA_RPC en .env (Triton/Helius) para
  // no depender del RPC público (que limita las consultas).
  const target = env.VITE_SOLANA_RPC || env.VITE_ARC_RPC || "https://api.devnet.solana.com";
  // RPC de Ethereum Mainnet para el Price Feed Chainlink USD/ARS.
  const ethTarget = env.VITE_ETH_RPC || "https://ethereum.publicnode.com";

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
      },
    },
  };
});
