import { PlatformError } from '../../../../src/platform/money.js';
import { createOnepay } from './onepay.js';
import { fetchPlatformQuote } from './fx.js';
import { assertService } from './config.js';
import { rampAdapters } from './ramps.js';

// Add a provider here and bind its capabilities in the country catalog. UI and
// ledger code consume the normalized contract, never provider-specific payloads.
export const PROVIDER_FACTORIES = { onepay: createOnepay };
export const FX_FACTORIES = { criptoya: ({ env, currency }) => () => fetchPlatformQuote({ env, currency }) };
export function withdrawalService(config, kind = config.services.bankWithdrawal?.available ? 'bank' : 'breb') {
  if (!['bank', 'breb'].includes(kind)) throw new PlatformError('invalid_destination', 400);
  const serviceId = kind === 'breb' ? 'brebWithdrawal' : 'bankWithdrawal';
  assertService(config, serviceId);
  const providerId = config.services[serviceId].provider;
  if (!providerId) throw new PlatformError('provider_not_integrated', 503);
  return { kind, serviceId, providerId };
}
export function countryProviders(config, env = process.env) {
  const cache = new Map();
  const get = id => {
    if (!PROVIDER_FACTORIES[id]) throw new PlatformError('provider_not_integrated', 503);
    if (!cache.has(id)) cache.set(id, PROVIDER_FACTORIES[id]({ env }));
    return cache.get(id);
  };
  const factory = FX_FACTORIES[env.FX_PROVIDER || config.country.fxProvider || 'criptoya'];
  if (!factory) throw new PlatformError('quote_provider_not_integrated', 503);
  const optional = id => id ? get(id) : null;
  return { providerFor: get, rampFor: rampAdapters(env), collectionProvider: optional(config.services.qrCollection?.provider),
    provider: optional(config.services.bankWithdrawal?.available ? config.services.bankWithdrawal.provider : config.services.brebWithdrawal?.provider),
    quote: factory({ env, currency: config.country.currency }) };
}
