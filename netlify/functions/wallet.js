import { guardLegacyHandler } from './lib/legacyCountry.js';
import { authenticatePayment,json,errorResponse } from './lib/paymentRuntime.js';
import { syncPrimaryWallet } from './lib/primaryWallet.js';
export function createWalletHandler(adapters={}) {
  return async event=>{
    try {
      const userId=await (adapters.authenticate || authenticatePayment)(event);
      if(event.httpMethod!=='GET')return json(405,{error:'method_not_allowed'});
      return json(200,{wallet:await (adapters.sync || syncPrimaryWallet)(userId)});
    }catch(error){return errorResponse(error);}
  };
}
const legacyHandler =createWalletHandler();

export const handler = guardLegacyHandler(legacyHandler);
