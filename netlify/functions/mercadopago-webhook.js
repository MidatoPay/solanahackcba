import { guardLegacyHandler } from './lib/legacyCountry.js';
import { verifyWebhook } from "./lib/paymentCore.js";
import { paymentSettings, getPaymentDb, json, errorResponse, kickWorker } from "./lib/paymentRuntime.js";

const legacyHandler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  try {
    if (Buffer.byteLength(event.body || "") > 65536) return json(413, { error:"payload_too_large" });
    const settings = paymentSettings();
    const received = verifyWebhook(event, process.env.MP_WEBHOOK_SECRET);
    // Body is not signed. Identity and amounts are checked using GET /v1/orders.
    await getPaymentDb().query(`INSERT INTO payment_inbox(environment,event_key,order_id,payload)
      VALUES($1,$2,$3,$4) ON CONFLICT(environment,event_key) DO NOTHING`,
      [settings.environment, received.key, received.id, received.body]);
    await kickWorker();
    return json(200, { received: true });
  } catch (error) { return errorResponse(error); }
};

export const handler = guardLegacyHandler(legacyHandler);
