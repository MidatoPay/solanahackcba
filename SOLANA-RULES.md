# Solana rules for this repo

## Stack
- Client: `@solana/kit` v8+ with plugins (`createClient().use(...)`). Do not use `@solana/web3.js` v1 or `@solana/wallet-adapter-*` in new code; if there is legacy, isolate it in an adapter module.
- Programs: none required for MidatoPay payments (SPL USDC transfer + Memo). Anchor only if we add onchain rules later.
- Default network: **devnet**. Mainnet only when explicitly asked.
- RPC: the URL comes from `.env` / `VITE_SOLANA_RPC` (Triton/Helius). Never hardcode keys, never commit them. Browser traffic goes through `/rpc` (Vite proxy / Netlify function).
- Wallets: Privy embedded Solana (`embeddedWallets.solana.createOnLogin`). Keys never leave the wallet.
- Tokens: identify USDC by **mint + token program** per cluster (`src/chain.js`), never by symbol. Verify mint/owner/decimals on every token account.
- FX: Chainlink USD/ARS on Ethereum Mainnet via `/eth-rpc` (ethers only for that read). Do not invent an oracle.

## Client and transactions
- Before signing: show recipient, amount, token (USDC mint), fee payer and cluster. Estimate fee in SOL. Only then send.
- Fresh blockhash when signing; confirm against signature status before resending (never blind-resend).
- `maxSupportedTransactionVersion: 1` when reading transactions.
- Onchain goes the minimum: the payment + memo/reference. Personal data stays in Postgres.

## Product
- Embedded wallet by default; prefer app-paid gas (fee sponsorship) when adding production hardening.
- Do not issue an app token. Do not write an AMM/bridge/oracle/custody.
