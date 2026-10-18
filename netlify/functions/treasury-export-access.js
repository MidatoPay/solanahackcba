import { guardLegacyHandler } from './lib/legacyCountry.js';
import { authenticatePayment,json,errorResponse } from './lib/paymentRuntime.js';
import { assertPaymentAdmin } from './lib/paymentReporting.js';
import { resolvePrimaryWallet } from './lib/primaryWallet.js';
import { getTreasuryAddress } from './lib/treasuryPayout.js';
export function createTreasuryExportAccessHandler(adapters={}) {
  return async event=>{
    try {
      const userId=await (adapters.authenticate || authenticatePayment)(event);
      (adapters.assertAdmin || assertPaymentAdmin)(userId);
      if(event.httpMethod!=='GET')return json(405,{error:'method_not_allowed'});
      const primary=await (adapters.primary || resolvePrimaryWallet)(userId);
      const treasury=await (adapters.treasury || getTreasuryAddress)();
      const authorized=Boolean(treasury && primary.address===treasury);
      return json(200,{authorized,address:authorized?treasury:null});
    }catch(error){return errorResponse(error);}
  };
}
const legacyHandler =createTreasuryExportAccessHandler();

export const handler = guardLegacyHandler(legacyHandler);
