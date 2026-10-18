import { PlatformError, decimal } from '../../../../src/platform/money.js';
import { prepareTreasuryPayout } from '../treasuryPayout.js';

// This settlement contract is for prefunded USDC on Solana. A new adapter must
// report its own liquidity/recipient and prepare a complete signed buy wire
// without broadcasting it. API-only settlement needs its own verified worker
// contract; it must never silently fall back to the treasury implementation.
export const RAMP_FACTORIES = {
  treasury: () => ({
    settlement: 'prefunded_solana',
    liquidity: deps => deps.liquidity(),
    sellDestination: deps => deps.treasury(),
    prepareBuy: (op, config, deps) => (deps.preparePayout || prepareTreasuryPayout)({
      to: op.wallet_address, rawAmount: op.usdc_raw, usdc: decimal(op.usdc_raw, 6), kind: 'buy',
      currency: op.currency, fiatAmount: decimal(op.fiat_minor), fxRate: op.quote.buy, factura: op.id,
    }),
  }),
};
export function rampAdapters(env = process.env) {
  const cache = new Map();
  return id => {
    if (!Object.hasOwn(RAMP_FACTORIES, id)) throw new PlatformError('ramp_provider_not_integrated', 503);
    if (!cache.has(id)) {
      const ramp = RAMP_FACTORIES[id]({ env });
      if (ramp?.settlement !== 'prefunded_solana' || !['liquidity', 'sellDestination', 'prepareBuy'].every(name => typeof ramp[name] === 'function'))
        throw new PlatformError('ramp_contract_not_integrated', 503);
      cache.set(id, ramp);
    }
    return cache.get(id);
  };
}
