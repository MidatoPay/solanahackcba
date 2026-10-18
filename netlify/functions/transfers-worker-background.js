import { guardLegacyHandler } from './lib/legacyCountry.js';
import {internalAuthorized} from './lib/paymentRuntime.js';
import {runTransferWorker} from './lib/transferWorker.js';
const legacyHandler =async event=>{
 if(event.httpMethod!=='POST' || !internalAuthorized(event))return {statusCode:401,body:'unauthorized'};
 await runTransferWorker({budgetMs:550000});return {statusCode:200,body:'ok'};
};

export const handler = guardLegacyHandler(legacyHandler);
