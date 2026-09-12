# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install # install deps
cp .env.example .env # then fill in VITE_PRIVY_APP_ID (required to run)
npm run dev # start Vite dev server (localhost:5173)
npm run build # production build
npm run preview # preview the production build
```

There is no lint script, no test runner, and no test files in this repo — don't assume `npm test` or `npm run lint` exist.

**Contacts agenda and transaction history need a second process.** Unlike `/rpc`/`/eth-rpc`, `/contacts` and `/transactions` have no public fallback — they're Netlify Functions backed by Postgres, and one must actually be running for the agenda/history to load in dev. Without it, `/contacts` and `/transactions` GET/POST calls fail — and since `pushTx`'s persistence call is wrapped in `.catch(() => {})`, transaction saves fail *silently*: the Activity tab just won't persist across refresh, with no visible error in the UI or console. Run in a separate terminal:

```bash
npx netlify functions:serve # serves netlify/functions/* on :9999; vite.config.js proxies /contacts and /transactions there
```

### Required env vars (`.env`, see `.env.example`)

- `VITE_PRIVY_APP_ID` — required. Without it, `src/main.jsx` renders a "missing App ID" screen instead of the app. Enable **Solana** embedded wallets in the Privy dashboard.
- `VITE_ANTHROPIC_API_KEY` — optional. Without it, voice/text commands fall back to a local regex parser (`localParse` in `src/App.jsx`).
- `VITE_SOLANA_RPC` — optional HTTPS RPC (Triton/Helius). Without it, the Vite/Netlify `/rpc` proxy forwards to the public Solana **devnet** RPC, which rate-limits.
- `VITE_SOLANA_WSS` — optional WSS for Privy subscriptions (default public devnet WSS).
- `VITE_ETH_RPC` — optional. Ethereum RPC for the Chainlink USD/ARS feed via `/eth-rpc`.
- `VITE_TREASURY_SECRET_KEY` — Solana keypair (base58 or JSON byte array) for Convert ARS→USDC payouts. Devnet only; exposed to the browser in this demo.
- `AIVEN_PG_URL`, `AIVEN_PG_CA_CERT`, `PRIVY_APP_SECRET` — required for the contacts agenda and transaction history. Server-side only, no `VITE_` prefix.

Also see `SOLANA-RULES.md` at the repo root.

## Architecture

This is a client-only Vite + React SPA (no backend router) demonstrating voice-driven **USDC (SPL)** payments on **Solana Devnet**. It's a demo/prototype — API key for Anthropic may ship to the browser; treasury secret is demo-only. FX (ARS per USDC) is read from the Chainlink USD/ARS feed on Ethereum Mainnet via `latestAnswer()` (`src/priceFeed.js`), with an off-chain fallback if the Ethereum RPC fails.

**Almost the entire app lives in `src/App.jsx`**. Navigation is plain `useState` tab-switching — there is no router.

Supporting files:
- `src/chain.js` — Solana cluster constants, USDC mint (devnet Circle), explorer helpers, RPC/WSS URLs.
- `src/solana.js` — Kit RPC client, USDC ATA balance, build/sign/send SPL transfers + Memo, fee estimate, incoming-transfer detection.
- `src/priceFeed.js` — Chainlink USD/ARS feed reader via `/eth-rpc` (ethers only here).
- `src/fx.js` — ARS↔USDC quotes on top of the Chainlink rate.
- `src/treasury.js` — collector wallet (`VITE_TREASURY_SECRET_KEY`) for Convert payouts.
- `src/fiatRail.js` — simulated ARS payment rail.
- `src/flows.js` — `runConvertArsToUsdc`, `runConvertUsdcToArs` orchestration.
- `src/payQr.js` — P2P charge QR/link payload (`buildPayUrl`/`parsePayUrl`) with Solana addresses.
- `src/contacts.js` / `src/transactions.js` — Postgres clients via Netlify Functions + localStorage SWR cache.
- `db/schema.sql` — contacts/transactions/wallets DDL.
- `src/main.jsx` — polyfills, PrivyProvider configured for **Solana-only** embedded wallets + Kit RPC.
- `vite.config.js` — proxies `/rpc` → Solana RPC and `/eth-rpc` → Ethereum RPC.

### Auth & wallet

Privy handles login (email/SMS) and provisions an **embedded Solana wallet**. `App.jsx` uses `useWallets` / `useSignAndSendTransaction` from `@privy-io/react-auth/solana`. Balance is USDC ATA balance via Kit; sends go through `sendUsdc(wallet, signAndSendTransaction, opts)`.

### Payment mechanic

USDC is an **SPL token** (Circle mint on devnet in `src/chain.js`). A payment is `CreateIdempotent ATA` (if needed) + `TransferChecked` + optional `Memo` (`MIDATO|v1|…`). Fees are paid in **SOL**, not USDC.

**Cobrar is P2P.** Charge generates a QR/link for the collector's Solana address and ARS amount. The payer pays with `sendUsdc`. While the QR screen is open, the collector polls USDC balance and, on a balance-diff, runs `findIncomingTransfer` (recent signatures on the ATA) to attribute the signature before recording it. Table uniqueness remains `UNIQUE(user_id, hash)`.

### Voice → intent parsing

Unchanged: `SpeechRecognition` + `claudeParse` / `localParse`. Settlement calls `sendUsdc` on Solana.

## Deployment (Netlify)

Static site via `netlify.toml`. Functions: `rpc.js` (Solana), `eth-rpc.js` (Ethereum/Chainlink), `contacts.js`, `transactions.js`, `reconcile-wallets.js` (SPL USDC via Solana RPC).

Required Netlify env: `VITE_PRIVY_APP_ID`, optional `VITE_SOLANA_RPC` / `VITE_SOLANA_WSS` / `VITE_ANTHROPIC_API_KEY` / `VITE_ETH_RPC` / `VITE_TREASURY_SECRET_KEY`, plus `AIVEN_PG_URL` / `AIVEN_PG_CA_CERT` / `PRIVY_APP_SECRET`. Add the deployed domain under Privy **Domains**. Run `db/schema.sql` once against Aiven.
