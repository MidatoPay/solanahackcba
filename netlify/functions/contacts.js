import { guardLegacyHandler } from './lib/legacyCountry.js';
import {isAddress} from '@solana/kit';
import {authenticatePayment,getPaymentDb,json,errorResponse} from './lib/paymentRuntime.js';
import {PaymentError} from './lib/paymentCore.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateContactInput(body) {
  if(!body || typeof body!=='object' || Array.isArray(body))throw new PaymentError('invalid_contact',400);
  for(const [key,max] of [['name',100],['alias',64],['address',44],['note',500]]) {
    if(key==='note' && (body[key]===undefined || body[key]===null))continue;
    if(typeof body[key]!=='string' || body[key].length>max || /[\u0000-\u001f\u007f]/.test(body[key]))throw new PaymentError('invalid_contact',400);
  }
  if(!body.name.trim() || !body.alias.trim())throw new PaymentError('missing_fields',400);
  if(!isAddress(body.address.trim()))throw new PaymentError('invalid_address',400);
  return {name:body.name.trim(),alias:body.alias.trim().toLowerCase(),address:body.address.trim(),note:(body.note||'').trim()};
}
export function createContactsHandler(adapters={}) {
  return async event=>{
    try {
      const userId=await (adapters.authenticate || authenticatePayment)(event);
      if(!['GET','POST','PUT','DELETE'].includes(event.httpMethod))return json(405,{error:'method_not_allowed'});
      const db=adapters.db || getPaymentDb();
      if(event.httpMethod==='GET') {
        const {rows}=await db.query('SELECT id,name,alias,address,note FROM contacts WHERE user_id=$1 ORDER BY created_at DESC',[userId]);
        return json(200,{contacts:rows.map(row=>({...row,solanaCompatible:isAddress(row.address)}))});
      }
      let body;try{body=JSON.parse(event.body || '{}');}catch{throw new PaymentError('invalid_json',400);}
      if(!body || typeof body!=='object' || Array.isArray(body))throw new PaymentError('invalid_contact',400);
      if(['PUT','DELETE'].includes(event.httpMethod) && !uuid.test(body.id || ''))throw new PaymentError('invalid_contact_id',400);
      if(event.httpMethod==='DELETE') {
        const result=await db.query('DELETE FROM contacts WHERE id=$1 AND user_id=$2 RETURNING id',[body.id,userId]);
        return result.rows.length?json(200,{ok:true}):json(404,{error:'not_found'});
      }
      const c=validateContactInput(body);
      const {rows}=event.httpMethod==='POST'
        ? await db.query(`INSERT INTO contacts(user_id,name,alias,address,note) VALUES($1,$2,$3,$4,$5) RETURNING id,name,alias,address,note`,[userId,c.name,c.alias,c.address,c.note])
        : await db.query(`UPDATE contacts SET name=$1,alias=$2,address=$3,note=$4,updated_at=now() WHERE id=$5 AND user_id=$6 RETURNING id,name,alias,address,note`,[c.name,c.alias,c.address,c.note,body.id,userId]);
      return rows.length?json(200,{contact:{...rows[0],solanaCompatible:true}}):json(404,{error:'not_found'});
    }catch(error){if(error?.code==='23505')return json(400,{error:'alias_duplicate'});return errorResponse(error);}
  };
}
const legacyHandler =createContactsHandler();

export const handler = guardLegacyHandler(legacyHandler);
