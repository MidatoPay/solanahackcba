import { guardLegacyHandler } from './lib/legacyCountry.js';
import {NETWORK} from '../../src/network.js';
import {authenticatePayment,getPaymentDb,json,errorResponse,kickWorker} from './lib/paymentRuntime.js';
import {PaymentError} from './lib/paymentCore.js';
import {createTransfer,submitTransfer,cancelUnsignedTransfer,publicTransfer,transferQuota} from './lib/transferService.js';
import {processTransfer} from './lib/transferWorker.js';
import {transfersEnabledFor} from './lib/transferAccess.js';

export function createTransfersHandler(adapters={}) {
 return async event=>{
  try {
   const userId=await (adapters.authenticate || authenticatePayment)(event);
   const path=event.path.replace(/^\/\.netlify\/functions\/transfers/,'/transfers');
   const match=path.match(/^\/transfers(?:\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\/(?:submit|cancel))?)?\/?$/i);
   if(!match)return json(404,{error:'not_found'});
   const db=adapters.db || getPaymentDb();
   if(event.httpMethod==='GET') {
    if(match[2])return json(405,{error:'method_not_allowed'});
    if(match[1]) {
     const t=(await db.query('SELECT * FROM wallet_transfers WHERE id=$1 AND user_id=$2 AND network=$3',[match[1],userId,NETWORK.cluster])).rows[0];
     if(!t)throw new PaymentError('transfer_not_found',404);
     if(t.signature && ['broadcasting','confirmed','manual_review'].includes(t.status))
      await (adapters.process || processTransfer)(t.id);
     const fresh=(await db.query('SELECT * FROM wallet_transfers WHERE id=$1',[t.id])).rows[0];
     return json(200,{transfer:publicTransfer(fresh,true),quota:await transferQuota(db,userId)});
    }
    const rows=(await db.query('SELECT * FROM wallet_transfers WHERE user_id=$1 AND network=$2 ORDER BY created_at DESC LIMIT 50',[userId,NETWORK.cluster])).rows;
    return json(200,{enabled:transfersEnabledFor(userId),transfers:rows.map(row=>publicTransfer(row)),quota:await transferQuota(db,userId)});
   }
   if(event.httpMethod!=='POST')return json(405,{error:'method_not_allowed'});
   let body;try{body=JSON.parse(event.body || '{}');}catch{throw new PaymentError('invalid_json',400);}
   if(!body || typeof body!=='object' || Array.isArray(body))throw new PaymentError('invalid_transfer',400);
   if(match[2]==='/cancel')return json(200,{transfer:publicTransfer(await (adapters.cancel || cancelUnsignedTransfer)(userId,match[1]))});
   if(match[2]) {
    const t=await (adapters.submit || submitTransfer)(userId,match[1],body.signedTransaction);
    // Submit commits the durable wire first; dispatch/transport failures cannot lose the transfer.
    await (adapters.kick || kickWorker)({functionName:'transfers-worker-background'});
    return json(202,{transfer:publicTransfer(t),quota:await transferQuota(db,userId)});
   }
   if(match[1])return json(405,{error:'method_not_allowed'});
   const key=event.headers?.['idempotency-key'] || event.headers?.['Idempotency-Key'];
   const t=await (adapters.create || createTransfer)(userId,body,key);
   return json(201,{transfer:publicTransfer(t,true),quota:await transferQuota(db,userId)});
  }catch(error){return errorResponse(error);}
 };
}
const legacyHandler =createTransfersHandler();

export const handler = guardLegacyHandler(legacyHandler);
