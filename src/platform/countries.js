// Country configuration is data; provider code lives behind server-side adapters.
export const COUNTRY_CATALOG = {
  CO: {
    code: 'CO', name: 'Colombia', flag: '🇨🇴', currency: 'COP', locale: 'es-CO', timeZone: 'America/Bogota', fxProvider: 'criptoya',
    bankAccountSchema: { accountTypes: { SAVINGS: 'Ahorros', CHECKING: 'Corriente' }, numberPattern: '^\\d{4,30}$', maxAccounts: 5 },
    services: {
      qrCollection: { provider: 'onepay', label: 'QR Bre-B', rail: 'breb', available: true },
      onRamp: { provider: 'treasury', available: true },
      offRamp: { provider: 'treasury', fiatProvider: 'onepay', available: true },
      bankWithdrawal: { provider: 'onepay', rail: 'ach', available: true },
      brebWithdrawal: { provider: 'onepay', rail: 'breb', available: true },
      cryptoTransfer: { provider: 'solana', available: true },
      qrPayment: { available: false, reason: 'service_not_integrated' },
      bankPayment: { available: false, reason: 'service_not_integrated' },
      cardIssuing: { available: false, reason: 'service_not_integrated' },
    },
  },
  AR: { code: 'AR', name: 'Argentina', currency: 'ARS', locale: 'es-AR', timeZone: 'America/Argentina/Buenos_Aires',
    legacy: true, services: {} },
};
export function bankContactsAvailable(config) {
  return !!config.country.bankAccountSchema && ['bankWithdrawal', 'bankPayment'].some(id => config.services[id]?.enabled);
}
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'expired']);
export const OPERATION_LABELS = {
  collection: 'Cobro QR', buy: 'Compra de USDC', sell: 'Venta de USDC', withdrawal: 'Retiro bancario', transfer: 'Envío de USDC', receive: 'USDC recibidos',
};
export const STATUS_LABELS = {
  creating: 'Preparando operación', awaiting_payment: 'Esperando pago', paid: 'Pago recibido',
  awaiting_signature: 'Pendiente de tu firma', pending: 'En proceso', broadcasting: 'Enviando a Solana',
  confirmed: 'Confirmada; esperando finalización', completed: 'Completada', failed: 'No se completó',
  cancel_pending: 'Cancelación pendiente', canceled: 'Cancelada', expired: 'Vencida', manual_review: 'En revisión',
};
