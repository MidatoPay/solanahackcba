// All financial calculations use integers. Number is reserved for presentation.
export class PlatformError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export function units(value, decimals = 2) {
  if (typeof value !== 'string' || !new RegExp(`^\\d{1,12}(?:\\.\\d{1,${decimals}})?$`).test(value))
    throw new PlatformError('invalid_amount', 400);
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (result > 9223372036854775807n) throw new PlatformError('invalid_amount', 400);
  return result;
}
export function decimal(value, decimals = 2) {
  const raw = BigInt(value), sign = raw < 0n ? '-' : '', n = raw < 0n ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  return `${sign}${n / scale}.${String(n % scale).padStart(decimals, '0')}`;
}
export function conversionPolicy(value = { mode: 'percentage', value: '100' }) {
  if (!value || !['percentage', 'fixed'].includes(value.mode)) throw new PlatformError('invalid_conversion_policy', 400);
  const raw = units(value.value);
  if (value.mode === 'percentage' && raw > 10000n || value.mode === 'fixed' && raw > 100000000n)
    throw new PlatformError('invalid_conversion_policy', 400);
  return { mode: value.mode, value: decimal(raw) };
}
export function conversionQuote(amountMinor, rate, direction = 'buy') {
  const amount = BigInt(amountMinor), rateRaw = units(String(rate), 8);
  if (amount <= 0n || rateRaw <= 0n || !['buy', 'sell'].includes(direction)) throw new PlatformError('invalid_quote', 400);
  if (direction === 'buy') {
    const fee = (amount * 50n + 5000n) / 10000n;
    return { fiatMinor: String(amount), feeMinor: String(fee), usdcRaw: String((amount - fee) * 1000000000000n / rateRaw) };
  }
  // For sell, amountMinor is actually the six-decimal USDC input.
  const gross = amount * rateRaw / 1000000000000n;
  const fee = (gross * 50n + 5000n) / 10000n;
  return { fiatMinor: String(gross - fee), feeMinor: String(fee), usdcRaw: String(amount) };
}
export function splitQuote(amountMinor, policy, rate) {
  const amount = BigInt(amountMinor), saved = conversionPolicy(policy);
  let converted = saved.mode === 'percentage' ? amount * units(saved.value) / 10000n : units(saved.value);
  if (converted > amount) converted = amount;
  let quote = { fiatMinor: '0', feeMinor: '0', usdcRaw: '0' }, skipped = false;
  if (converted > 0n) {
    quote = conversionQuote(converted, rate);
    if (BigInt(quote.usdcRaw) < 10000n) { converted = 0n; quote = { fiatMinor: '0', feeMinor: '0', usdcRaw: '0' }; skipped = true; }
  }
  return { ...quote, convertedMinor: String(converted), retainedMinor: String(amount - converted), policy: saved, skipped };
}
export function fiatAmount(value, minimum = 100000n) {
  const amount = units(value);
  if (amount < minimum || amount > 100000000n) throw new PlatformError('amount_out_of_range', 400);
  return String(amount);
}
export function formatMoney(value, currency = 'COP', locale = 'es-CO') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0));
}
