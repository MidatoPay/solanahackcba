import { guardLegacyHandler } from './lib/legacyCountry.js';
import { authenticatePayment,paymentSettings,json,errorResponse } from "./lib/paymentRuntime.js";
import { ensureMerchantPos,publicMerchantPos } from "./lib/merchantPos.js";

const legacyHandler =async(event)=>{
  try {
    const userId=await authenticatePayment(event);
    if(event.httpMethod!=="POST")return json(405,{error:"method_not_allowed"});
    const pos=await ensureMerchantPos(userId,paymentSettings());
    return json(200,{pos:publicMerchantPos(pos)});
  } catch(error){return errorResponse(error);}
};

export const handler = guardLegacyHandler(legacyHandler);
