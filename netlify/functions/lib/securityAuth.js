import { getPaymentDb,getPaymentPrivy } from './paymentRuntime.js';
import { fail,header,hash } from './securityCore.js';

export async function authenticateIdentity(event,client) {
 const token=header(event,'authorization').replace(/^Bearer\s+/i,'').trim();
 if(!token)throw fail('unauthorized',401);
 let claims;try{claims=await (client || getPaymentPrivy()).verifyAuthToken(token);}catch{throw fail('unauthorized',401);}
 if(!claims.userId || !claims.sessionId)throw fail('unauthorized',401);
 return {userId:claims.userId,sessionId:claims.sessionId};
}
export async function requireUnlock(event,identity,db,env=process.env) {
 if(env.SECURITY_ENFORCED==='false')return;
 const token=header(event,'x-app-unlock');
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw fail('app_locked',423);
 const {rows}=await (db || getPaymentDb()).query(`SELECT token_hash FROM app_security_sessions
  WHERE token_hash=$1 AND user_id=$2 AND privy_session=$3 AND scope='unlock'
  AND NOT revoked AND expires_at>now() AND absolute_expires_at>now()`,[hash(token),identity.userId,identity.sessionId]);
 if(!rows.length)throw fail('app_locked',423);
}
