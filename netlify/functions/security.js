import { generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse } from '@simplewebauthn/server';
import { getPaymentDb,transaction,json,errorResponse } from './lib/paymentRuntime.js';
import { authenticateIdentity } from './lib/securityAuth.js';
import { createPin,verifyPin,opaque,hash,header,fail,webauthnConfig } from './lib/securityCore.js';
import { recoveryAdapter } from './lib/securityRecovery.js';
import { PaymentError } from './lib/paymentCore.js';
import {authenticationLimit,takeLimit,rateLimited} from './lib/securityLimits.js';

function securityError(error) {
 const response=errorResponse(error);
 if(error.status===429)response.headers['Retry-After']=String(error.retryAfter || 60);
 return response;
}

export function createSecurityHandler({identity=authenticateIdentity,pool=getPaymentDb,env=process.env,recovery=recoveryAdapter,
 webauthn={generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse}}={}) {
 return async event=>{
  try {
   // Identity is always required, including recovery and enrollment.
   const owner=await identity(event),dbPool=pool();
   const action=(event.path || '').replace(/^\/(?:\.netlify\/functions\/)?security\/?/,'') || 'status';
   if(!['GET','POST'].includes(event.httpMethod))throw fail('method_not_allowed',405);
   if((event.httpMethod==='GET')!==(action==='status'))throw fail('method_not_allowed',405);
   if((event.body || '').length>32768)throw fail('request_too_large',413);
   let body;try{body=JSON.parse(event.body || '{}');}catch{throw fail('invalid_json');}
   if(!body || typeof body!=='object' || Array.isArray(body))throw fail('invalid_json');
   // Trust only Netlify's edge-provided client address, never X-Forwarded-For.
   if(event.httpMethod==='POST' && !['renew','lock'].includes(action))await authenticationLimit(dbPool,owner,event);
   const result=await transaction(async db=>{
    await db.query('INSERT INTO app_security_users(user_id) VALUES($1) ON CONFLICT DO NOTHING',[owner.userId]);
    const {rows:[user]}=await db.query('SELECT * FROM app_security_users WHERE user_id=$1 FOR UPDATE',[owner.userId]);
    const {rows:keys}=await db.query('SELECT * FROM app_security_passkeys WHERE user_id=$1',[owner.userId]);
    const total=Number(Boolean(user.pin))+keys.length;
    const params=[owner.userId,owner.sessionId];
    async function issue(scope='unlock') {
     const token=opaque(),ttl=scope==='unlock'?90:300;
     await db.query(`INSERT INTO app_security_sessions(token_hash,user_id,privy_session,scope,expires_at,absolute_expires_at)
      VALUES($1,$2,$3,$4,now()+$5*interval '1 second',now()+interval '12 hours')`,[hash(token),...params,scope,ttl]);
     return {token,scope,expiresIn:ttl};
    }
    async function grant(allowed=['manage','recover']) {
     const token=header(event,'x-security-grant');
     const {rows}=await db.query(`DELETE FROM app_security_sessions WHERE token_hash=$1 AND user_id=$2 AND privy_session=$3
      AND scope IN ('manage','recover') AND NOT revoked AND expires_at>now() RETURNING scope`,[hash(token),...params]);
     if(!rows.length || !allowed.includes(rows[0].scope))throw fail('factor_verification_required',403);
     return rows[0].scope;
    }
    async function authorizeEnrollment() {return total?await grant():'initial';}
    async function enrolled(mode) {
     await db.query('DELETE FROM app_security_challenges WHERE user_id=$1',[owner.userId]);
     await db.query('UPDATE app_security_sessions SET revoked=true WHERE user_id=$1',[owner.userId]);
     return issue();
    }
    async function resetFactors() {
     await db.query('DELETE FROM app_security_passkeys WHERE user_id=$1',[owner.userId]);
     await db.query('UPDATE app_security_users SET pin=NULL,failed_attempts=0,blocked_until=NULL WHERE user_id=$1',[owner.userId]);
    }
    async function challenge(purpose,payload) {
     const id=opaque();
     await db.query(`INSERT INTO app_security_challenges(id,user_id,privy_session,purpose,payload,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')`,[id,...params,purpose,JSON.stringify(payload)]);
     return id;
    }
    async function consume(purpose) {
     if(typeof body.challengeId!=='string')throw fail('invalid_challenge');
     const {rows}=await db.query(`DELETE FROM app_security_challenges WHERE id=$1 AND user_id=$2 AND privy_session=$3
      AND purpose=$4 AND expires_at>now() RETURNING payload`,[body.challengeId,...params,purpose]);
     if(!rows.length)throw fail('invalid_challenge');
     return rows[0].payload;
    }
    // Return expected failures inside the transaction so attempts and consumed
    // challenges commit even when verification fails. Unexpected errors roll back.
    try {
     if(action==='status')return {enforced:env.SECURITY_ENFORCED!=='false',pin:Boolean(user.pin),
      passkeys:keys.map(key=>({id:key.credential_id})),blockedUntil:user.blocked_until,recoveryAvailable:recovery.available};
     if(action==='pin/enroll') {
      const verifier=await createPin(body.pin,env),mode=await authorizeEnrollment();
      if(mode==='recover')await resetFactors();
      await db.query('UPDATE app_security_users SET pin=$2,failed_attempts=0,blocked_until=NULL WHERE user_id=$1',[owner.userId,JSON.stringify(verifier)]);
      return enrolled(mode);
     }
     if(action==='pin/verify') {
      if(user.blocked_until && new Date(user.blocked_until)>new Date())throw rateLimited((new Date(user.blocked_until)-Date.now())/1000,'pin_blocked');
      if(!user.pin)throw fail('factor_not_registered',403);
      if(!await verifyPin(body.pin,user.pin,env)) {
       await db.query(`UPDATE app_security_users SET failed_attempts=CASE WHEN blocked_until<=now() THEN 1 ELSE failed_attempts+1 END,
        blocked_until=CASE WHEN (CASE WHEN blocked_until<=now() THEN 1 ELSE failed_attempts+1 END)>=5 THEN now()+interval '15 minutes' ELSE NULL END
        WHERE user_id=$1`,[owner.userId]);
       throw fail('incorrect_pin',403);
      }
      await db.query('UPDATE app_security_users SET failed_attempts=0,blocked_until=NULL WHERE user_id=$1',[owner.userId]);
      return issue(body.purpose==='manage'?'manage':'unlock');
     }
     if(action==='passkey/register-options') {
      const mode=await authorizeEnrollment(),{rpID}=webauthnConfig(env);
      const options=await webauthn.generateRegistrationOptions({rpName:'MidatoPay',rpID,userName:owner.userId,
       userID:new Uint8Array(Buffer.from(hash(owner.userId),'hex')),attestationType:'none',
       excludeCredentials:keys.filter(k=>k.rp_id===rpID).map(k=>({id:k.credential_id,transports:k.credential.transports})),
       authenticatorSelection:{residentKey:'preferred',userVerification:'required'}});
      return {options,challengeId:await challenge('register',{challenge:options.challenge,mode,rpID})};
     }
     if(action==='passkey/register') {
      const saved=await consume('register'),{rpID,origins}=webauthnConfig(env);
      if(saved.rpID!==rpID)throw fail('invalid_challenge');
      // Recheck setup after options were issued. Concurrent initial enrollments
      // cannot be used later to add an unauthorized factor.
      if(saved.mode==='initial' && total)throw fail('factor_verification_required',403);
      let result;try{result=await webauthn.verifyRegistrationResponse({response:body.response,expectedChallenge:saved.challenge,
       expectedOrigin:origins,expectedRPID:rpID,requireUserVerification:true});}catch{throw fail('invalid_passkey',403);}
      if(!result.verified || !result.registrationInfo?.userVerified)throw fail('invalid_passkey',403);
      const {credential,credentialDeviceType,credentialBackedUp,aaguid,origin}=result.registrationInfo;
      // Check uniqueness before recovery deletes anything.
      const existing=await db.query('SELECT credential_id FROM app_security_passkeys WHERE credential_id=$1',[credential.id]);
      if(existing.rows.length)throw fail('credential_already_registered',409);
      if(saved.mode==='recover')await resetFactors();
      await db.query('INSERT INTO app_security_passkeys(credential_id,user_id,rp_id,credential) VALUES($1,$2,$3,$4)',
       [credential.id,owner.userId,rpID,JSON.stringify({...credential,publicKey:Buffer.from(credential.publicKey).toString('base64url'),
        credentialDeviceType,credentialBackedUp,aaguid,verifiedOrigin:origin,userVerified:true,createdAt:new Date().toISOString()})]);
      return enrolled(saved.mode);
     }
     if(action==='passkey/options') {
      const {rpID}=webauthnConfig(env),allowed=keys.filter(k=>k.rp_id===rpID);
      if(!allowed.length)throw fail('factor_not_registered',403);
      const options=await webauthn.generateAuthenticationOptions({rpID,userVerification:'required',
       allowCredentials:allowed.map(k=>({id:k.credential_id,transports:k.credential.transports}))});
      return {options,challengeId:await challenge('authenticate',{challenge:options.challenge,rpID,scope:body.purpose==='manage'?'manage':'unlock'})};
     }
     if(action==='passkey/verify') {
      const saved=await consume('authenticate'),{rpID,origins}=webauthnConfig(env);
      const key=keys.find(k=>k.credential_id===body.response?.id && k.rp_id===rpID);
      if(!key || saved.rpID!==rpID)throw fail('invalid_passkey',403);
      const handle=body.response?.response?.userHandle;
      if(handle && handle!==Buffer.from(hash(owner.userId),'hex').toString('base64url'))throw fail('invalid_passkey',403);
      let result;try{result=await webauthn.verifyAuthenticationResponse({response:body.response,expectedChallenge:saved.challenge,
       expectedOrigin:origins,expectedRPID:rpID,requireUserVerification:true,
       credential:{...key.credential,publicKey:new Uint8Array(Buffer.from(key.credential.publicKey,'base64url'))}});}catch{throw fail('invalid_passkey',403);}
      if(!result.verified || !result.authenticationInfo?.userVerified)throw fail('invalid_passkey',403);
      await db.query('UPDATE app_security_passkeys SET credential=$2 WHERE credential_id=$1',
       [key.credential_id,JSON.stringify({...key.credential,counter:result.authenticationInfo.newCounter,
        userVerified:true,lastUsedAt:new Date().toISOString()})]);
      return issue(saved.scope);
     }
     if(action==='methods/remove') {
      if(total<=1)throw fail('last_factor_required',409);
      if(body.id!=='pin' && !keys.some(k=>k.credential_id===body.id))throw fail('factor_not_registered',404);
      await grant(['manage']);
      if(body.id==='pin')await db.query('UPDATE app_security_users SET pin=NULL WHERE user_id=$1',[owner.userId]);
      else await db.query('DELETE FROM app_security_passkeys WHERE credential_id=$1 AND user_id=$2',[body.id,owner.userId]);
      await db.query('DELETE FROM app_security_challenges WHERE user_id=$1',[owner.userId]);
      return enrolled('manage');
     }
     if(action==='renew' || action==='lock') {
      const token=header(event,'x-app-unlock');
      if(action==='lock') {
       await db.query('UPDATE app_security_sessions SET revoked=true WHERE token_hash=$1 AND user_id=$2 AND privy_session=$3',[hash(token),...params]);
       return {locked:true};
      }
      const {rows}=await db.query(`SELECT token_hash FROM app_security_sessions
       WHERE token_hash=$1 AND user_id=$2 AND privy_session=$3 AND scope='unlock' AND NOT revoked
       AND expires_at>now() AND absolute_expires_at>now() FOR UPDATE`,[hash(token),...params]);
      if(!rows.length)throw fail('app_locked',423);
      await takeLimit(db,'renew:'+hash(token),10,60);
      const {rows:[renewed]}=await db.query(`UPDATE app_security_sessions
       SET expires_at=LEAST(now()+interval '90 seconds',absolute_expires_at) WHERE token_hash=$1
       RETURNING extract(epoch from expires_at-now()) AS ttl`,[hash(token)]);
      return {expiresIn:Number(renewed.ttl)};
     }
     if(action==='recovery/start') {
      if(!recovery.available)throw fail('recovery_unavailable',503);
      const id=opaque();
      const state=await recovery.start({userId:owner.userId,challengeId:id});
      await db.query(`INSERT INTO app_security_challenges(id,user_id,privy_session,purpose,payload,expires_at)
       VALUES($1,$2,$3,'recovery',$4,now()+interval '5 minutes')`,[id,...params,JSON.stringify(state)]);
      return {challengeId:id};
     }
     if(action==='recovery/verify') {
      if(!recovery.available)throw fail('recovery_unavailable',503);
      const state=await consume('recovery');
      if(!await recovery.verify({userId:owner.userId,challengeId:body.challengeId,state,code:body.code}))throw fail('invalid_recovery_code',403);
      return issue('recover');
     }
     throw fail('not_found',404);
    }catch(error){if(error instanceof PaymentError)return {failure:error};throw error;}
   },dbPool);
   return result.failure?securityError(result.failure):json(200,result);
  }catch(error){return securityError(error);}
 };
}
export const handler=createSecurityHandler();
