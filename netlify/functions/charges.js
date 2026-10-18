import { guardLegacyHandler } from './lib/legacyCountry.js';
import { PaymentError, publicCharge } from "./lib/paymentCore.js";
import { authenticatePayment, paymentSettings, getPaymentDb, json, errorResponse, kickWorker } from "./lib/paymentRuntime.js";
import { createCharge, getCharge, getChargeAttempt } from "./lib/paymentService.js";
import { listOwnCharges } from "./lib/paymentReporting.js";

export function createChargesHandler(overrides={}) {
  const dependencies={authenticatePayment,paymentSettings,getPaymentDb,kickWorker,createCharge,getCharge,getChargeAttempt,listOwnCharges,...overrides};
  return async (event) => {
  const {authenticatePayment,paymentSettings,getPaymentDb,kickWorker,createCharge,getCharge,getChargeAttempt,listOwnCharges}=dependencies;
  try {
    const userId = await authenticatePayment(event), settings = paymentSettings();
    const path = event.path.replace(/^\/\.netlify\/functions\/charges/, "/charges");
    const match = path.match(/^\/charges(?:\/([0-9a-f-]{36})(\/cancel)?)?\/?$/i);
    if (!match) return json(404, { error: "not_found" });
    if (event.httpMethod === "GET") {
      const key = event.queryStringParameters?.attempt;
      if (!match[1] && key) {
        const charge = await getChargeAttempt(key,userId,settings);
        return json(200,{ charge: charge ? publicCharge(charge) : null });
      }
      if (match[1]) {
        if (match[2]) return json(405, { error: "method_not_allowed" });
        const charge = await getCharge(match[1], userId, settings);
        return json(200, { charge: publicCharge(charge) });
      }
      return json(200,await listOwnCharges(getPaymentDb(),userId,settings,event.queryStringParameters || {}));
    }
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
    if (match[1] && match[2]) {
      const charge = await getCharge(match[1], userId, settings);
      if (!["creating","awaiting_payment","cancel_pending"].includes(charge.status)) throw new PaymentError("charge_not_cancelable", 409);
      await getPaymentDb().query("UPDATE charges SET cancel_requested=true,next_attempt_at=now() WHERE id=$1", [charge.id]);
      await kickWorker();
      return json(202, { charge: publicCharge({ ...charge, status: "cancel_pending" }) });
    }
    if (match[1]) return json(405, { error: "method_not_allowed" });
    let input;
    try { input = JSON.parse(event.body || "{}"); } catch { throw new PaymentError("invalid_json", 400); }
    const key = event.headers?.["idempotency-key"] || event.headers?.["Idempotency-Key"];
    // Commit the intent and return before external order creation. The protected worker
    // uses this same saved key/body; polling recovers QR creation after slow responses.
    const charge = await createCharge(userId, input, key);
    await kickWorker();
    return json(charge.qr_data ? 201 : 202, { charge: publicCharge(charge) });
  } catch (error) { return errorResponse(error); }
  };
}
const legacyHandler =createChargesHandler();

export const handler = guardLegacyHandler(legacyHandler);
