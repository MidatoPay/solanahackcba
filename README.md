# MidatoPay × Solana — Voice Payments

Login con email o teléfono (Privy) → wallet embebida Solana → pagos por voz en USDC
(SPL) que se liquidan de verdad en Solana Devnet, verificables en Solana Explorer.

## Setup

```bash
npm install
cp .env.example .env   # completá las claves (ver abajo)
npm run dev
```

### Claves necesarias en .env

| Variable | De dónde sale | ¿Obligatoria? |
|---|---|---|
| `VITE_PRIVY_APP_ID` | dashboard.privy.io → tu app | Sí, sin esto no hay login |
| `VITE_ANTHROPIC_API_KEY` | console.anthropic.com | No (sin ella usa parser local) |
| `VITE_SOLANA_RPC` | Triton / Helius (HTTPS) | No (sin ella usa el RPC público de devnet, que limita) |
| `VITE_SOLANA_WSS` | Mismo provider (WSS) | No (default: wss público de devnet) |
| `VITE_ETH_RPC` | RPC Ethereum Mainnet | No (sin ella usa publicnode; necesario para el FX Chainlink) |
| `VITE_TREASURY_SECRET_KEY` | Keypair Solana de la recaudadora (base58 o JSON) | Sí para Convertir ARS→USDC (solo devnet) |

### Configurar Privy (3 minutos)

1. Entrá a https://dashboard.privy.io y creá una app
2. **Login methods**: activá Email y SMS
3. **Embedded wallets**: activá creación automática de wallets **Solana**
4. **Domains**: agregá `http://localhost:5173`
5. Copiá el App ID al `.env`

## Usar la app

1. Entrar con email o teléfono → recibís un código → se crea tu wallet Solana sola
2. Inicio → copiar dirección → https://faucet.circle.com → **Solana Devnet** → pedir USDC
3. Necesitás un poco de SOL en la wallet para fees (`solana airdrop 2` o faucet de SOL)
4. Voz 🎙 → "enviar 1 dólar a katy" → Firmar y enviar
5. El recibo trae la signature con link a https://explorer.solana.com/?cluster=devnet

Usá **Chrome o Edge** para el micrófono. En Safari necesitás Dictado activado
(Configuración del Sistema → Teclado) y permiso de micrófono para localhost.

## Stack

Cliente `@solana/kit` v8, Privy embedded Solana, USDC mint de Circle en devnet,
memo SPL para la factura, Postgres (contactos/historial) sin cambios.
