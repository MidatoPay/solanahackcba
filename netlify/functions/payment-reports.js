import { guardLegacyHandler } from './lib/legacyCountry.js';
import { authenticatePayment, getPaymentDb, json, errorResponse } from "./lib/paymentRuntime.js";
import { isPaymentAdmin, assertPaymentAdmin, reportFilters, listReportOperations, reportSummary } from "./lib/paymentReporting.js";
import { runPaymentPreflight } from "./lib/paymentPreflight.js";

export function createPaymentReportsHandler(overrides={}) {
 const dependencies={authenticatePayment,assertPaymentAdmin,runPaymentPreflight,...overrides};
 return async(event)=>{
  const {authenticatePayment,assertPaymentAdmin,runPaymentPreflight}=dependencies;
  try {
    if(event.httpMethod!=="GET") return json(405,{error:"method_not_allowed"});
    const userId=await authenticatePayment(event);
    const path=event.path.replace(/^\/\.netlify\/functions\/payment-reports/,"/payment-reports");
    if(path==="/payment-reports/access") return json(200,{authorized:isPaymentAdmin(userId),userId});
    assertPaymentAdmin(userId);
    if(path==="/payment-reports/readiness")return json(200,await runPaymentPreflight({userId}));
    const filters=reportFilters(event.queryStringParameters || {});
    if(path==="/payment-reports/operations") return json(200,await listReportOperations(getPaymentDb(),filters,event.queryStringParameters || {}));
    if(path==="/payment-reports/summary") return json(200,await reportSummary(getPaymentDb(),filters));
    return json(404,{error:"not_found"});
  } catch(error){return errorResponse(error);}
};
}
const legacyHandler =createPaymentReportsHandler();

export const handler = guardLegacyHandler(legacyHandler);
