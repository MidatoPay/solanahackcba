import { guardLegacyHandler } from './lib/legacyCountry.js';
import { kickWorker } from "./lib/paymentRuntime.js";
const legacyHandler = async () => {
  await kickWorker();
  return { statusCode:200, body:"dispatched" };
};

export const handler = guardLegacyHandler(legacyHandler);
