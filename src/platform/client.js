export const messages = {
  ramp_provider_not_integrated: 'La rampa configurada todavía no tiene una integración habilitada.',
  ramp_contract_not_integrated: 'La rampa configurada necesita completar su integración antes de operar.',
  destination_provider_changed: 'El proveedor de este servicio cambió. Registra un destino con el proveedor actual antes de retirar.',
  invalid_contact: 'Ingresa nombre y alias de hasta 100 caracteres.',
  invalid_contact_wallet: 'Revisa la dirección Solana del contacto.',
  contact_destination_required: 'Agrega una wallet o una cuenta bancaria al contacto.',
  bank_contacts_unavailable: 'La agenda bancaria no está habilitada para este país.',
  invalid_bank_contact: 'Revisa banco, titular, tipo y número de cuenta. Puedes guardar hasta cinco cuentas por contacto.',
  duplicate_bank_contact: 'Esta cuenta ya está agregada al contacto.',
  contact_alias_exists: 'Ya tienes un contacto con ese alias. Edítalo o elige otro alias.',
  contact_not_found: 'El contacto ya no está disponible. Actualiza la agenda.',
  deployment_context_changed: 'La configuración del despliegue cambió. Actualiza la página antes de continuar.',
  attempt_closed: 'Esta solicitud fue cerrada de forma segura. Puedes iniciar otra.',
  unauthorized: 'Tu sesión venció. Vuelve a ingresar.',
  platform_database_not_configured: 'El entorno de pruebas todavía necesita su base de datos.',
  platform_migration_required: 'El entorno de pruebas necesita actualizar su esquema de datos.',
  platform_database_must_be_isolated: 'Colombia necesita una base de datos de pruebas independiente.',
  platform_service_unavailable: 'No pudimos conectar con el servicio. Reintenta en unos momentos.',
  sandbox_not_enabled: 'Este servicio todavía no está habilitado en el sandbox.',
  legal_acceptance_required: 'Revisa y acepta los documentos vigentes antes de continuar.',
  legal_documents_changed: 'Los documentos cambiaron. Actualiza la página para revisar la versión vigente.',
  quote_unavailable: 'La cotización no está disponible. Intenta nuevamente en unos momentos.',
  quote_expired: 'La cotización venció. Solicita una nueva antes de continuar.',
  invalid_amount: 'Ingresa un importe válido, sin separador de miles.',
  amount_out_of_range: 'Revisa el importe: cobros y retiros de 1.000 a 1.000.000 COP; conversiones desde 0,01 USDC.',
  invalid_conversion_policy: 'Revisa el porcentaje (0 a 100) o el importe fijo a convertir.',
  invalid_business_name: 'Ingresa un nombre de comercio de hasta 100 caracteres.',
  insufficient_cop: 'Tu saldo COP disponible no alcanza para esta operación.',
  insufficient_usdc: 'Tu saldo USDC disponible no alcanza, incluyendo envíos pendientes.',
  insufficient_treasury: 'La liquidez USDC de prueba no alcanza. Tus COP permanecen protegidos.',
  insufficient_onepay_liquidity: 'La liquidez COP de prueba no está disponible para este retiro o conversión.',
  treasury_sol_unavailable: 'La tesorería de prueba necesita SOL para cubrir la red.',
  primary_wallet_required: 'Espera a que tu wallet principal esté lista y sincronizada.',
  onepay_test_key_required: 'El sandbox todavía necesita la clave de prueba de OnePay.',
  onepay_credentials_or_permission: 'OnePay no pudo autorizar la operación de prueba.',
  onepay_unavailable: 'OnePay no respondió. Conservamos la operación para recuperarla.',
  onepay_validation_failed: 'OnePay no pudo validar los datos enviados. Revisa el beneficiario o el destino.',
  onepay_idempotency_pending: 'OnePay está recuperando la operación original. No la repitas.',
  onepay_cashout_failed: 'El retiro no se completó. Los COP regresaron al saldo disponible.',
  invalid_beneficiary: 'Revisa nombre, documento, correo, teléfono colombiano y fecha de nacimiento.',
  beneficiary_required: 'Primero registra los datos del beneficiario de prueba.',
  beneficiary_identity_already_saved: 'Los datos del beneficiario ya quedaron registrados. Recupera la identidad original.',
  destination_not_ready: 'Registra y selecciona un destino propio antes de retirar.',
  invalid_destination: 'Revisa los datos del destino.',
  breb_key_owner_mismatch: 'La llave Bre-B no está activa o no corresponde al beneficiario registrado.',
  transfer_daily_limit: 'Alcanzaste los dos envíos patrocinados del día. El cupo se renueva a medianoche de Colombia.',
  transfer_budget_exhausted: 'El patrocinio de red no está disponible temporalmente.',
  transfer_blockhash_expired: 'La preparación venció. Cancela la operación sin firmar y solicita una nueva cotización.',
  transfer_expired_requires_review: 'La transferencia requiere revisión. No la repitas hasta confirmar su estado.',
  conversion_failed_cop_returned: 'La conversión no se completó. Los COP regresaron al saldo disponible.',
  account_requires_reconciliation: 'Tu cuenta necesita conciliación antes de iniciar otra operación.',
};
export function errorMessage(code) { return messages[code] || 'No se pudo completar la solicitud. Revisa su estado en Actividad antes de repetirla.'; }
export async function platformRequest(path, getAccessToken, { body, ...options } = {}) {
  const token = await getAccessToken();
  if (!token) throw Object.assign(new Error(messages.unauthorized), { code: 'unauthorized' });
  let response;
  try { response = await fetch(`/platform${path}`, { ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }); }
  catch { throw Object.assign(new Error('No confirmamos la respuesta. Recupera la operación guardada antes de repetirla.'), { code: 'network_error' }); }
  let value;
  try { value = await response.json(); } catch { throw Object.assign(new Error('El servicio devolvió una respuesta inesperada.'), { code: 'network_error' }); }
  if (!response.ok) throw Object.assign(new Error(errorMessage(value.error)), { code: value.error, status: response.status });
  return value;
}
export function intentStore(storage, scope, userId) {
  const key = `midatopay:intent:${scope}:${userId}`;
  return {
    read() { try { const saved = JSON.parse(storage.getItem(key)); return saved && typeof saved.key === 'string' && typeof saved.path === 'string' ? saved : null; } catch { return null; } },
    save(value) { try { storage.setItem(key, JSON.stringify(value)); } catch { throw new Error('Habilita el almacenamiento local para recuperar operaciones si se interrumpe la conexión.'); } },
    clear() { storage.removeItem(key); },
  };
}
export function parseLocalCommand(text, currency = 'COP', contacts = []) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const charge = normalized.match(/\b(?:cobrar|cobra|cobro|charge|collect)\s+(\d+(?:[.,]\d+)?)/);
  if (charge && !/usdc|dolar|\busd\b/.test(normalized) && !new RegExp(`\\b${currency === 'COP' ? 'ars' : 'cop'}\\b`).test(normalized))
    return { intent: 'charge', amount: charge[1].replace(',', '.'), currency, confidence: 1 };
  const send = normalized.match(/\b(?:enviar|envia|send|transferir)\s+(\d+(?:[.,]\d+)?)\s*(?:usdc|dolar(?:es)?|usd)\s+a\s+/);
  if (!send) return null;
  const amount = send[1].replace(',', '.');
  const address = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0];
  if (address) return { intent: 'send', amount, currency: 'USDC', recipient: address, confidence: 1 };
  const recipient = normalized.slice(send.index + send[0].length).trim();
  const canonical = value => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const matches = contacts.filter(c => c.address && (canonical(c.alias) === recipient || canonical(c.name) === recipient));
  if (matches.length === 1) return { intent: 'send', amount, currency: 'USDC', recipient: matches[0].alias, confidence: 1 };
  return null;
}
export function csvReport(rows) {
  const escape = value => `"${String(value ?? '').replace(/^[=+\-@]/, "'$&").replaceAll('"', '""')}"`;
  const columns = ['ID','Comercio','Fecha','Operación','Estado','País','Moneda','Importe fiat','Comisión prevista','Comisión registrada','USDC','Proveedor','Referencia proveedor','Firma Solana'];
  return '\ufeff' + [columns, ...rows.map(r => [r.id,r.merchantId,r.createdAt,r.kind,r.status,r.country,r.currency,r.fiatAmount,r.feeFiat,r.earnedFee,r.usdcAmount,r.provider,r.providerId,r.signature])].map(row => row.map(escape).join(',')).join('\r\n');
}
