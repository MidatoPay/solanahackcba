import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture,securityEnv} from './security-fixture.js';
import {createRecoveryService} from '../netlify/functions/lib/securityRecovery.js';
import {requireUnlock} from '../netlify/functions/lib/securityAuth.js';
import {hash,createPin} from '../netlify/functions/lib/securityCore.js';

async function recoveryFixture(t,options={}) {
 const messages=[];let email='alice@example.test',verified=true,failure=false,onSend;
 const recovery=createRecoveryService({env:securityEnv,getUser:async()=>({email:email?{address:email}:null,
  linkedAccounts:email?[{type:'email',address:email,firstVerifiedAt:verified?new Date():null}]:[]}),request:async(url,options)=>{
  assert.equal(url,'https://api.resend.com/emails');assert.equal(options.method,'POST');assert.ok(options.signal);
  if(onSend)await onSend();if(failure)throw new Error('timeout');
  const data=JSON.parse(options.body);messages.push({...data,code:data.text.match(/\b\d{6}\b/)[0]});return new Response('{"id":"fixture"}');
 }});
 const f=await fixture(t,{recovery,...options});
 const resetLimits=()=>f.query('DELETE FROM app_security_limits');
 const contact=async(headers={})=>{
  const start=await f.call('recovery-email/start',{},headers);assert.equal(start.status,200);
  return f.call('recovery-email/verify',{challengeId:start.challengeId,code:messages.at(-1).code},headers);
 };
 return {...f,messages,recovery,contact,resetLimits,setEmail:value=>{email=value;},setVerified:value=>{verified=value;},setFailure:value=>{failure=value;},onSend:fn=>{onSend=fn;}};
}
test('email and SMS onboarding: verified Privy email is mandatory and browser destinations are ignored',async t=>{
 const f=await recoveryFixture(t);
 assert.equal((await f.call('pin/enroll',{pin:'03927'})).error,'recovery_contact_required');
 f.setEmail(null);assert.equal((await f.call('recovery-email/start',{email:'attacker@example.test'})).error,'verified_email_required');
 f.setEmail('sms-linked@example.test');f.setVerified(false);
 assert.equal((await f.call('recovery-email/start')).error,'verified_email_required');f.setVerified(true);
 const start=await f.call('recovery-email/start',{email:'attacker@example.test',destination:'attacker@example.test'});
 assert.deepEqual(f.messages[0].to,['sms-linked@example.test']);assert.equal(start.email,'s***@example.test');
 const row=(await f.query('SELECT * FROM app_security_challenges WHERE id=$1',[start.challengeId])).rows[0];
 assert.match(row.payload.hmac,/^[a-f0-9]{64}$/);assert.equal(row.payload.code,undefined);
 assert.equal((await f.call('recovery-email/verify',{challengeId:start.challengeId,code:f.messages[0].code})).recoveryReady,true);
 assert.equal((await f.call('status')).recoveryReady,true);
 const unlock=await f.call('pin/enroll',{pin:'03927'});assert.equal(unlock.scope,'unlock');
 await requireUnlock({headers:{'x-app-unlock':unlock.token}},f.owner,f.pool,securityEnv);
 await f.query('UPDATE app_security_users SET recovery_verified_at=NULL');
 await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':unlock.token}},f.owner,f.pool,securityEnv),{code:'app_locked'});
});
test('contact is pinned; historical factors require verification to configure or change it',async t=>{
 const f=await recoveryFixture(t);await f.call('status');
 await f.query('UPDATE app_security_users SET pin=$1',[JSON.stringify(await createPin('03927',securityEnv))]);
 assert.equal((await f.call('recovery/start')).error,'recovery_contact_required');
 assert.equal((await f.call('recovery-email/start')).error,'factor_verification_required');
 const authorization=await f.call('pin/verify',{pin:'03927'});assert.equal(authorization.scope,'manage');
 const unlock=await f.contact({'x-security-grant':authorization.token});assert.equal(unlock.scope,'unlock');
 f.setEmail('changed@example.test');await f.resetLimits();
 await f.call('recovery/start');assert.deepEqual(f.messages.at(-1).to,['alice@example.test']);
 assert.equal((await f.call('recovery-email/start')).error,'factor_verification_required');
 await f.resetLimits();const grant=await f.call('pin/verify',{pin:'03927',purpose:'manage'});
 assert.equal((await f.contact({'x-security-grant':grant.token})).scope,'unlock');
 assert.equal((await f.query('SELECT recovery_email,recovery_version FROM app_security_users')).rows[0].recovery_email,'changed@example.test');
 assert.equal((await f.call('renew',{}, {'x-app-unlock':unlock.token})).status,423);
});
test('OTP wrong, fifth error, replay, resend, expiration, purpose and identity/session binding',async t=>{
 const f=await recoveryFixture(t);await f.contact();await f.call('pin/enroll',{pin:'03927'});await f.resetLimits();
 const start=await f.call('recovery/start'),code=f.messages.at(-1).code;
 const verify=(challengeId,code,owner=f.owner,purpose='recovery')=>f.call(purpose+'/verify',{challengeId,code},{},owner);
 assert.equal((await verify(start.challengeId,code,{...f.owner,userId:'foreign'})).error,'invalid_challenge');
 assert.equal((await verify(start.challengeId,code,{...f.owner,sessionId:'foreign'})).error,'invalid_challenge');
 assert.equal((await verify(start.challengeId,code,f.owner,'recovery-email')).error,'invalid_challenge');
 const wrong=code==='000000'?'111111':'000000';
 for(let i=0;i<5;i++)assert.equal((await verify(start.challengeId,wrong)).error,'invalid_recovery_code');
 assert.equal((await verify(start.challengeId,code)).error,'invalid_challenge');
 const consumed=(await f.query('SELECT state,attempts FROM app_security_challenges WHERE id=$1',[start.challengeId])).rows[0];
 assert.deepEqual(consumed,{state:'consumed',attempts:5});await f.resetLimits();
 const old=await f.call('recovery/start'),oldCode=f.messages.at(-1).code;
 await f.query("UPDATE app_security_limits SET expires_at=now()-interval '1 second' WHERE key LIKE 'otp:minute:%'");
 const next=await f.call('recovery/start'),nextCode=f.messages.at(-1).code;
 assert.equal((await verify(old.challengeId,oldCode)).error,'invalid_challenge');
 const grant=await verify(next.challengeId,nextCode);assert.equal(grant.scope,'recover');assert.equal(grant.expiresIn,300);
 assert.equal((await verify(next.challengeId,nextCode)).error,'invalid_challenge');
 await f.resetLimits();const expired=await f.call('recovery/start');
 await f.query("UPDATE app_security_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.challengeId]);
 assert.equal((await verify(expired.challengeId,f.messages.at(-1).code)).error,'invalid_challenge');
});
test('recover cannot access private APIs or remove factors; atomic reset revokes sessions and is single use',async t=>{
 const f=await recoveryFixture(t);await f.contact();const old=await f.call('pin/enroll',{pin:'03927'});await f.resetLimits();
 await f.query("INSERT INTO app_security_passkeys VALUES('fixture-key',$1,'localhost','{}')",[f.owner.userId]);
 const start=await f.call('recovery/start'),grant=await f.call('recovery/verify',{challengeId:start.challengeId,code:f.messages.at(-1).code});
 const headers={'x-security-grant':grant.token};
 await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':grant.token}},f.owner,f.pool,securityEnv),{code:'app_locked'});
 assert.equal((await f.call('methods/remove',{id:'pin'},headers)).status,403);
 // An unexpected database failure after reset must roll back factors AND grant.
 await f.engine.exec(`CREATE FUNCTION fail_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;
  CREATE TRIGGER fail_reset BEFORE UPDATE ON app_security_users FOR EACH ROW WHEN (NEW.pin IS NOT NULL) EXECUTE FUNCTION fail_reset();`);
 assert.equal((await f.call('pin/enroll',{pin:'84726'},headers)).status,503);
 assert.equal((await f.query('SELECT * FROM app_security_passkeys')).rows.length,1);
 assert.equal((await f.query('SELECT * FROM app_security_sessions WHERE token_hash=$1',[hash(grant.token)])).rows.length,1);
 await f.engine.exec('DROP TRIGGER fail_reset ON app_security_users;');
 const result=await f.call('pin/enroll',{pin:'84726'},headers);assert.equal(result.scope,'unlock');
 assert.equal((await f.call('pin/enroll',{pin:'92837'},headers)).status,403);
 assert.equal((await f.query('SELECT * FROM app_security_passkeys')).rows.length,0);
 assert.equal((await f.query('SELECT * FROM app_security_challenges')).rows.length,0);
 assert.equal((await f.call('renew',{}, {'x-app-unlock':old.token})).status,423);
 assert.equal((await f.call('pin/verify',{pin:'84726'})).scope,'unlock');
});
test('delivery failures/timeouts grant nothing; delivery runs outside the database transaction',async t=>{
 const f=await recoveryFixture(t);await f.contact();await f.call('pin/enroll',{pin:'03927'});await f.resetLimits();
 const before=(await f.query('SELECT pin FROM app_security_users')).rows[0].pin;
 let acquired=false;
 f.onSend(async()=>{const connection=await f.pool.connect();acquired=true;connection.release();});
 f.setFailure(true);assert.equal((await f.call('recovery/start')).error,'recovery_delivery_failed');assert.equal(acquired,true);
 const challenge=(await f.query("SELECT * FROM app_security_challenges WHERE purpose='recovery'")).rows[0];assert.equal(challenge.state,'failed');
 assert.equal((await f.call('recovery/verify',{challengeId:challenge.id,code:'000000'})).error,'invalid_challenge');
 assert.deepEqual((await f.query('SELECT pin FROM app_security_users')).rows[0].pin,before);
 assert.equal((await f.query("SELECT * FROM app_security_sessions WHERE scope='recover'")).rows.length,0);
});
test('OTP budgets are persistent and migration is idempotent over historical factors',async t=>{
 const f=await recoveryFixture(t);await f.contact();await f.call('pin/enroll',{pin:'03927'});await f.resetLimits();
 const original=(await f.query('SELECT * FROM app_security_users')).rows[0];
 const migration=await readFile(new URL('../db/migrations/20261022_security_recovery.sql',import.meta.url),'utf8');
 await f.engine.exec(migration);await f.engine.exec(migration);
 assert.deepEqual((await f.query('SELECT * FROM app_security_users')).rows[0],original);
 assert.equal((await f.call('recovery/start')).status,200);
 const limited=await f.call('recovery/start');assert.equal(limited.status,429);assert.ok(+limited.headers['Retry-After']>0);
 await f.resetLimits();
 for(let i=0;i<5;i++){
  assert.equal((await f.call('recovery/start')).status,200);
  await f.query("UPDATE app_security_limits SET expires_at=now()-interval '1 second' WHERE key LIKE 'otp:minute:%'");
 }
 assert.equal((await f.call('recovery/start')).status,429);
 await f.resetLimits();
 for(let i=0;i<10;i++)assert.equal((await f.call('recovery/verify',{challengeId:'absent',code:'000000'})).status,400);
 assert.equal((await f.call('recovery/verify',{challengeId:'absent',code:'000000'})).status,429);
});
test('passkey recovery consumes the grant only at registration, rechecks expiry and revokes competing challenges',async t=>{
 const f=await recoveryFixture(t,{webauthn:{generateRegistrationOptions:async()=>({challenge:'fixture'}),verifyRegistrationResponse:async()=>({verified:true,
  registrationInfo:{userVerified:true,credential:{id:'recovered-key',publicKey:new Uint8Array([1,2]),counter:0},origin:securityEnv.SECURITY_ORIGINS}})}});
 await f.contact();const old=await f.call('pin/enroll',{pin:'03927'});await f.resetLimits();
 const start=await f.call('recovery/start'),grant=await f.call('recovery/verify',{challengeId:start.challengeId,code:f.messages.at(-1).code});
 const headers={'x-security-grant':grant.token},options=await f.call('passkey/register-options',{},headers);
 assert.equal((await f.query('SELECT * FROM app_security_sessions WHERE token_hash=$1',[hash(grant.token)])).rows.length,1);
 await f.query("UPDATE app_security_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash(grant.token)]);
 assert.equal((await f.call('passkey/register',{challengeId:options.challengeId,response:{}},headers)).error,'factor_verification_required');
 assert.ok((await f.query('SELECT pin FROM app_security_users')).rows[0].pin);
 await f.resetLimits();const next=await f.call('recovery/start');
 const fresh=await f.call('recovery/verify',{challengeId:next.challengeId,code:f.messages.at(-1).code});
 const a=await f.call('passkey/register-options',{}, {'x-security-grant':fresh.token});
 const b=await f.call('passkey/register-options',{}, {'x-security-grant':fresh.token});
 assert.equal((await f.call('passkey/register',{challengeId:a.challengeId,response:{}})).scope,'unlock');
 assert.equal((await f.call('passkey/register',{challengeId:b.challengeId,response:{}})).error,'invalid_challenge');
 assert.equal((await f.query('SELECT pin FROM app_security_users')).rows[0].pin,null);
 assert.equal((await f.call('renew',{}, {'x-app-unlock':old.token})).status,423);
});
test('contact version and IP sending budgets cannot be bypassed, service never uses the PIN pepper',async t=>{
 const f=await recoveryFixture(t);await f.contact();await f.call('pin/enroll',{pin:'03927'});await f.resetLimits();
 const start=await f.call('recovery/start'),code=f.messages.at(-1).code;
 await f.query('UPDATE app_security_users SET recovery_version=recovery_version+1');
 assert.equal((await f.call('recovery/verify',{challengeId:start.challengeId,code})).error,'invalid_challenge');
 await f.resetLimits();await f.query("INSERT INTO app_security_limits VALUES($1,100,now()+interval '1 hour')",['otp:ip:'+hash('shared-ip')]);
 assert.equal((await f.call('recovery/start',{}, {'x-forwarded-for':'spoofed'})).status,429);
 const unavailable=createRecoveryService({env:{...securityEnv,SECURITY_RECOVERY_PEPPER:securityEnv.SECURITY_PIN_PEPPER}});
 assert.equal(unavailable.available,false);
});
