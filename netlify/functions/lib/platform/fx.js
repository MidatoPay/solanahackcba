import { PlatformError, units, decimal } from '../../../../src/platform/money.js';

export function normalizeQuotes(body, { now = Date.now(), maxAgeSeconds = 300, currency = 'COP' } = {}) {
  const nowSeconds = Math.floor(now / 1000);
  const valid = Object.entries(body || {}).flatMap(([exchange, q]) => {
    if (!q || !Number.isSafeInteger(q.time) || q.time > nowSeconds + 30 || nowSeconds - q.time > maxAgeSeconds) return [];
    if (![q.totalAsk, q.totalBid].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) || q.totalBid > q.totalAsk) return [];
    return [{ exchange, buy: units(q.totalAsk.toFixed(8), 8), sell: units(q.totalBid.toFixed(8), 8), time: q.time }];
  });
  if (valid.length < 2) throw new PlatformError('quote_unavailable', 503);
  const median = key => {
    const sorted = valid.map(q => q[key]).sort((a, b) => a < b ? -1 : a > b ? 1 : 0), m = Math.floor(sorted.length / 2);
    return decimal(sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2n, 8);
  };
  return { source: 'criptoya', currency, asset: 'USDC', volume: '1', indicative: true,
    buy: median('buy'), sell: median('sell'), updatedAt: new Date(Math.min(...valid.map(q => q.time)) * 1000).toISOString(),
    fetchedAt: new Date(now).toISOString(), sources: valid.map(q => ({ exchange: q.exchange, time: q.time })) };
}
const cache = new Map(), inFlight = new Map();
export async function fetchPlatformQuote({ request = fetch, now = Date.now, env = process.env, currency = 'COP' } = {}) {
  if (!/^[A-Z]{3}$/.test(currency)) throw new PlatformError('invalid_quote_currency', 503);
  const ttl = Number(env.FX_CACHE_TTL_SECONDS || 60), maxAge = Number(env.FX_MAX_AGE_SECONDS || 300);
  if (![ttl, maxAge].every(n => Number.isSafeInteger(n) && n > 0 && n <= 600)) throw new PlatformError('invalid_fx_config', 503);
  const validAt = now();
  const key = `${currency}:${maxAge}`, cached = cache.get(key);
  if (cached && validAt >= cached.at && validAt - cached.at < ttl * 1000 && validAt - Date.parse(cached.value.updatedAt) <= maxAge * 1000) return cached.value;
  if (!inFlight.has(key)) inFlight.set(key, Promise.resolve().then(async () => {
    try {
      const response = await request(`https://criptoya.com/api/usdc/${currency.toLowerCase()}/1`, { signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error();
      const value = normalizeQuotes(await response.json(), { now: now(), maxAgeSeconds: maxAge, currency });
      cache.set(key, { value, at: now() }); return value;
    } catch (error) { throw error instanceof PlatformError ? error : new PlatformError('quote_unavailable', 503); }
    finally { inFlight.delete(key); }
  }));
  return inFlight.get(key);
}
export function resetQuoteCache() { cache.clear(); inFlight.clear(); }
