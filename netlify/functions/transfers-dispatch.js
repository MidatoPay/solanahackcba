import { guardLegacyHandler } from './lib/legacyCountry.js';
import {kickWorker} from './lib/paymentRuntime.js';
const legacyHandler =async()=>{
 const result=await kickWorker({functionName:'transfers-worker-background'});
 return {statusCode:result.accepted?200:503,body:JSON.stringify(result)};
};

export const handler = guardLegacyHandler(legacyHandler);
