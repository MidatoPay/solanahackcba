import {securityFetch as fetch} from './securitySession.js';
import { SOLANA } from "./chain.js";
export { canStartNewCharge } from "./chargeStatus.js";
const storageKey = (userId) => `mp_charge_${SOLANA.cluster}_${userId}`;
export function readChargeAttempt(userId) {
  try { return JSON.parse(localStorage.getItem(storageKey(userId))); } catch { return null; }
}
export function saveChargeAttempt(userId, attempt) {
  localStorage.setItem(storageKey(userId), JSON.stringify(attempt));
}
export function clearChargeAttempt(userId) { localStorage.removeItem(storageKey(userId)); }
export function prepareChargeAttempt(previous, value, wallet) {
  if (previous?.id) return previous;
  return { key:previous?.key || crypto.randomUUID(), ars:String(value).replace(",","."), wallet:previous?.wallet || wallet };
}
export function bindChargeAttempt(previous,charge,key) {
  if(!previous || previous.key!==key || (previous.id && previous.id!==charge.id))return previous;
  return {...previous,id:charge.id};
}
function diagnosticEndpoint(path) {
  try {
    const pathname=new URL(path,"http://localhost").pathname;
    if(/^\/charges(?:\/[0-9a-f-]{36}(?:\/cancel)?)?\/?$/i.test(pathname))
      return pathname.replace(/[0-9a-f-]{36}/i,":id");
    if(/^\/(?:merchant-pos|payment-reports\/[a-z-]+)\/?$/.test(pathname))return pathname;
  } catch { /* Do not log an unknown URL that could contain credentials. */ }
  return "payment_api";
}
function paymentApiError(path,options,{code,status=0,requestId=null,responseFormat="none"}) {
  const diagnostic={method:["GET","POST"].includes(options.method?.toUpperCase())?options.method.toUpperCase():"GET",
    endpoint:diagnosticEndpoint(path),status,code,message:chargeError(code),requestId,responseFormat};
  // An explicit allowlist of fields excludes tokens, cookies, bodies, QR data and private URLs.
  console.error("[MidatoPay pagos] Falló la solicitud",diagnostic);
  const error=new Error(diagnostic.message);
  Object.assign(error,{code,status,requestId,diagnostic});
  return error;
}
export async function chargeApi(path, token, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { "Content-Type":"application/json",
      Authorization:`Bearer ${token}`, ...options.headers }, signal:AbortSignal.timeout(25000) });
  } catch(error) {
    throw paymentApiError(path,options,{code:["TimeoutError","AbortError"].includes(error?.name)?"payment_request_timeout":"payment_network_error"});
  }
  const rawRequestId=response.headers.get("x-nf-request-id");
  const requestId=/^[A-Za-z0-9:_-]{1,128}$/.test(rawRequestId || "")?rawRequestId:null;
  let body,responseFormat;
  try {body=await response.json();responseFormat=body && typeof body==="object" && !Array.isArray(body)?"json":"unexpected_json";}
  catch {responseFormat="non_json";}
  if (!response.ok) {
    const code=typeof body?.error==="string" && /^[a-z][a-z0-9_]{0,95}$/.test(body.error)?body.error:"payment_service_unavailable";
    throw paymentApiError(path,options,{code,status:response.status,requestId,responseFormat});
  }
  if(responseFormat!=="json")throw paymentApiError(path,options,{code:"invalid_payment_response",status:response.status,requestId,responseFormat});
  return body;
}
export const CHARGE_ERRORS = {
  charge_configuration_changed:"La configuración de este cobro cambió. Estamos conciliando la operación; podés iniciar otro cobro.",
  solana_expired_requires_review:"La entrega de USDC requiere verificar su confirmación. Podés iniciar otro cobro.",
  solana_transaction_failed:"La transferencia de USDC falló y este cobro requiere revisión. Podés iniciar otro cobro.",
  invalid_treasury_secret_key:"TREASURY_SECRET_KEY no contiene una clave Solana válida. Revisá la variable privada de Functions.",
  solana_rpc_network_mismatch:"SOLANA_RPC apunta a una red distinta de VITE_SOLANA_CLUSTER. Revisá la configuración de Functions.",
  solana_rpc_unavailable:"El RPC de Solana no respondió correctamente. Conservamos el cobro para reintentar.",
  solana_rpc_timeout:"El RPC de Solana demoró demasiado en responder. Conservamos el cobro para reintentar.",
  mercadopago_invalid_response:"Mercado Pago devolvió una respuesta inesperada. Conservamos el intento para reintentar.",
  mercadopago_account_unavailable:"No se pudo verificar la cuenta vendedora con Mercado Pago. Intentá nuevamente.",
  invalid_mp_store_id:"MP_STORE_ID debe ser el ID numérico de la sucursal de la cuenta Mercado Pago configurada.",
  mercadopago_store_owner_mismatch:"La sucursal configurada en MP_STORE_ID pertenece a otra cuenta Mercado Pago.",
  mercadopago_store_inactive:"La sucursal Mercado Pago configurada está inactiva.",
  payment_request_timeout:"El servidor demoró demasiado en responder. Conservamos el mismo intento para reintentar.",
  payment_network_error:"No se pudo conectar con el servidor de pagos. Conservamos el mismo intento para reintentar.",
  invalid_payment_response:"El servidor de pagos devolvió una respuesta inesperada. Conservamos el mismo intento para reintentar.",
  missing_mp_store_id:"Falta MP_STORE_ID en Netlify: el ID de la sucursal Mercado Pago donde se crearán las cajas de los comercios.",
  merchant_email_required:"Vinculá un email a tu usuario Privy para crear la caja del comercio.",
  merchant_pos_pending:"La caja de tu comercio se está creando. Intentá nuevamente en unos segundos.",
  merchant_pos_mismatch:"La caja del comercio no coincide con la cuenta o sucursal registrada. Requiere revisión.",
  merchant_pos_already_assigned:"La caja ya está asociada a otro usuario Privy. Requiere revisión del administrador.",
  mercadopago_store_not_found:"La sucursal Mercado Pago no existe o no pertenece a la cuenta configurada. Revisá MP_STORE_ID.",
  mercadopago_pos_inactive:"La caja Mercado Pago del comercio está inactiva.",
  payment_schema_missing:"Faltan las tablas de cobros en PostgreSQL. Aplicá las migraciones de Mercado Pago.",
  payment_schema_outdated:"El esquema de PostgreSQL está desactualizado. Aplicá las migraciones de Mercado Pago.",
  payment_database_auth_failed:"PostgreSQL rechazó las credenciales del servidor.",
  payment_database_permission_denied:"El usuario de PostgreSQL no tiene permisos para consultar los cobros.",
  payment_database_tls_failed:"No se pudo validar el certificado TLS de PostgreSQL. Revisá AIVEN_PG_CA_CERT.",
  payment_database_unavailable:"El servidor no puede conectarse a PostgreSQL. Revisá la conexión de la base.",
  invalid_database_url:"AIVEN_PG_URL no contiene una URL PostgreSQL válida.",
  missing_aiven_pg_url:"Falta AIVEN_PG_URL en las variables de Functions de Netlify.",
  missing_aiven_pg_ca_cert:"Falta AIVEN_PG_CA_CERT en las variables de Functions de Netlify.",
  idempotency_conflict:"Este intento ya tiene un cobro con otro importe. Recuperá esa operación antes de iniciar otra.",
  payments_disabled:"Los cobros están deshabilitados hasta completar la configuración productiva.",
  quote_unavailable:"No se pudo consultar la cotización Chainlink. Intentá nuevamente más tarde.",
  quote_invalid_round:"La cotización Chainlink no contiene una ronda válida de USD/ARS.",
  quote_invalid_or_stale:"La cotización Chainlink no es válida o está vencida. El cobro queda detenido hasta tener una ronda vigente.",
  quote_stale:"La cotización Chainlink está vencida (supera CHAINLINK_MAX_AGE_SECONDS). El cobro queda detenido hasta tener una ronda vigente.",
  missing_eth_rpc_url:"Falta ETH_RPC_URL en las variables de Functions de Netlify. Configurá un RPC de Ethereum mainnet para la cotización.",
  invalid_eth_rpc_url:"ETH_RPC_URL debe ser una URL HTTP o HTTPS válida de un RPC de Ethereum mainnet.",
  missing_chainlink_max_age_seconds:"Falta CHAINLINK_MAX_AGE_SECONDS en las variables de Functions de Netlify: la antigüedad máxima permitida de la cotización, en segundos (recomendado 90000 = 25 horas).",
  invalid_chainlink_max_age_seconds:"CHAINLINK_MAX_AGE_SECONDS debe ser un número entero positivo de segundos (recomendado 90000 = 25 horas).",
  invalid_worker_secret:"INTERNAL_WORKER_SECRET debe tener al menos 32 caracteres.",
  invalid_conversion_fee:"CONVERSION_FEE_BPS debe ser 50 para la comisión de conversión del 0,5%.",
  treasury_not_configured:"Falta configurar la tesorería del servidor con TREASURY_SECRET_KEY.",
  insufficient_treasury:"No hay suficiente liquidez USDC para iniciar este cobro.",
  insufficient_treasury_sol:"La tesorería necesita SOL para completar las entregas.",
  mercadopago_pos_not_found:"La caja Mercado Pago no está configurada para esta cuenta.",
  mercadopago_pos_not_pdv:"La caja existe, pero debe configurarse con config.qr.operating_mode=pdv para cobrar con este QR.",
  mercadopago_invalid_pos_response:"Mercado Pago devolvió un formato de cajas inesperado. No se inició el cobro.",
  seller_account_mismatch:"La cuenta Mercado Pago no coincide con el vendedor configurado.",
  seller_is_test_account:"La cuenta Mercado Pago configurada es de prueba; se necesita un vendedor real para producción.",
  seller_is_not_test_account:"Para el ambiente de prueba se necesita un vendedor de prueba de Mercado Pago.",
  mercadopago_forbidden:"Mercado Pago rechazó los permisos de la cuenta vendedora.",
  mercadopago_http_403:"Mercado Pago rechazó los permisos de la cuenta vendedora.",
  mercadopago_http_401:"La credencial Mercado Pago no es válida.",
  mercadopago_idempotency_key_conflict:"El proveedor detectó un conflicto en este cobro. Requiere revisión.",
  mercadopago_missing_qr:"Mercado Pago no devolvió un QR. Se está cancelando la orden.",
  mercadopago_timeout:"La respuesta de Mercado Pago está pendiente. Conservamos el mismo intento.",
  user_payment_review:"Tu cuenta tiene un cobro que requiere revisión.",
  amount_below_minimum:"El importe neto debe equivaler al menos a 0,01 USDC.",
  invalid_amount:"Ingresá un importe positivo con hasta dos decimales.",
  invalid_amount_or_fee:"El importe debe estar entre 0 y $1.000.000 ARS.",
  wallet_not_owned:"La wallet no pertenece a la sesión actual.",
  payment_network_mismatch:"La red de la billetera y el ambiente Mercado Pago no coinciden.",
};
export function chargeError(code) {
  return CHARGE_ERRORS[code] || (/^missing_[a-z][a-z0-9_]{1,63}$/.test(code || "")
    ? `Falta ${code.slice(8).toUpperCase()} en las variables de Functions de Netlify para este despliegue.`
    : "El cobro no pudo actualizarse. Conservamos la operación para reintentar.");
}
