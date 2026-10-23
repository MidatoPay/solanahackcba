import {randomInt,createHmac,timingSafeEqual} from 'node:crypto';
import {fail,opaque,hash,header} from './securityCore.js';
import {takeLimit} from './securityLimits.js';
import {getPaymentPrivy} from './paymentRuntime.js';

export const recoveryReady=user=>Boolean(user.recovery_email && user.recovery_verified_at);
export const maskEmail=email=>email?email.slice(0,1)+'***@'+email.split('@')[1]:null;
export function createRecoveryService({env=process.env,getUser=id=>getPaymentPrivy().getUser(id),request=fetch}={}) {
 const available=Boolean(env.RESEND_API_KEY && env.SECURITY_RECOVERY_FROM && env.SECURITY_RECOVERY_PEPPER?.length>=32 && env.SECURITY_RECOVERY_PEPPER!==env.SECURITY_PIN_PEPPER);
 const digest=(code,{id,userId,sessionId,purpose,version})=>{
  if(!available)throw fail('recovery_unavailable',503);
  return createHmac('sha256',env.SECURITY_RECOVERY_PEPPER).update(JSON.stringify([id,userId,sessionId,purpose,version,code])).digest();
 };
 return {
  available,
  async verifiedEmail(userId) {
   if(!available)throw fail('recovery_unavailable',503);
   let user;try{user=await getUser(userId);}catch{throw fail('recovery_identity_unavailable',503);}
   // Only a verified Privy email account, never browser or OAuth display data.
   const account=user?.linkedAccounts?.find(a=>a.type==='email' && a.address===user.email?.address && a.firstVerifiedAt);
   if(!account || typeof account.address!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.address))throw fail('verified_email_required',409);
   return account.address;
  },
  create(binding) {const code=String(randomInt(0,1000000)).padStart(6,'0');return {code,hmac:digest(code,binding).toString('hex')};},
  verify(code,expected,binding) {
   const actual=digest(typeof code==='string'?code:'',binding),stored=Buffer.from(expected || '','hex');
   return stored.length===actual.length && timingSafeEqual(stored,actual) && /^\d{6}$/.test(code);
  },
  async send({id,email,code,purpose}) {
   if(!available)throw fail('recovery_unavailable',503);
   try {
    const response=await request('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(8000),
     headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':'security-'+id},
     body:JSON.stringify({from:env.SECURITY_RECOVERY_FROM,to:[email],subject:purpose==='recovery'?'Recuperá tu acceso a MidatoPay':'Confirmá tu email de recuperación',
      text:`Tu código de MidatoPay es ${code}. Vence en cinco minutos. No lo compartas. Si no lo solicitaste, ignorá este mensaje.`})});
    if(!response.ok || !(await response.json()).id)throw new Error();
   }catch{throw fail('recovery_delivery_failed',503);}
  },
 };
}

// Returns a server-only delivery job; send after releasing the user row lock.
export async function recoveryAction({action,db,user,owner,total,body,event,service,email,grant,issue}) {
 if(!service.available)throw fail('recovery_unavailable',503);
 const purpose=action.startsWith('recovery-email/')?'recovery-email':'recovery';
 const binding={userId:owner.userId,sessionId:owner.sessionId,purpose,version:user.recovery_version};
 if(action.endsWith('/start')) {
  if(purpose==='recovery' && !recoveryReady(user))throw fail('recovery_contact_required',409);
  if(purpose==='recovery-email' && total)await grant(['manage'],false);
  await takeLimit(db,'otp:minute:'+hash(owner.userId),1,60);
  await takeLimit(db,'otp:hour:'+hash(owner.userId),5,3600);
  await takeLimit(db,'otp:ip:'+hash(header(event,'x-nf-client-connection-ip') || 'local'),100,3600);
  const id=opaque(),{code,hmac}=service.create({...binding,id});
  const destination=purpose==='recovery'?user.recovery_email:email;
  await db.query("UPDATE app_security_challenges SET state='consumed' WHERE user_id=$1 AND purpose=$2",[owner.userId,purpose]);
  await db.query(`INSERT INTO app_security_challenges(id,user_id,privy_session,purpose,payload,expires_at,state,contact_version)
   VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes','pending',$6)`,
   [id,owner.userId,owner.sessionId,purpose,JSON.stringify({hmac,email:destination,initial:!total,
    grantHash:total && purpose==='recovery-email'?hash(header(event,'x-security-grant')):null}),user.recovery_version]);
  return {delivery:{id,email:destination,code,purpose}};
 }
 await takeLimit(db,'otp:verify:'+hash(owner.userId),10,900);
 const {rows:[saved]}=await db.query(`SELECT * FROM app_security_challenges WHERE id=$1 AND user_id=$2 AND privy_session=$3
  AND purpose=$4 AND contact_version=$5 AND state='sent' AND expires_at>now() AND attempts<5 FOR UPDATE`,
  [typeof body.challengeId==='string'?body.challengeId:'',owner.userId,owner.sessionId,purpose,user.recovery_version]);
 if(!saved)throw fail('invalid_challenge');
 const verified=service.verify(body.code,saved.payload.hmac,{...binding,id:saved.id});
 await db.query(`UPDATE app_security_challenges SET attempts=attempts+1,state=CASE WHEN $2 OR attempts>=4 THEN 'consumed' ELSE state END WHERE id=$1`,[saved.id,verified]);
 if(!verified)throw fail('invalid_recovery_code',403);
 if(purpose==='recovery')return issue('recover');
 if(total || !saved.payload.initial) {
  if(hash(header(event,'x-security-grant'))!==saved.payload.grantHash)throw fail('factor_verification_required',403);
  await grant(['manage']);
 }
 await db.query(`UPDATE app_security_users SET recovery_email=$2,recovery_verified_at=now(),recovery_version=recovery_version+1 WHERE user_id=$1`,[owner.userId,saved.payload.email]);
 await db.query('DELETE FROM app_security_challenges WHERE user_id=$1',[owner.userId]);
 await db.query('UPDATE app_security_sessions SET revoked=true WHERE user_id=$1',[owner.userId]);
 return total?issue():{recoveryReady:true};
}
