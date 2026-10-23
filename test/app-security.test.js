import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createSecurityHandler} from '../netlify/functions/security.js';
import {authenticateIdentity,requireUnlock} from '../netlify/functions/lib/securityAuth.js';
import {validPin,createPin,verifyPin,hash,opaque,webauthnConfig} from '../netlify/functions/lib/securityCore.js';
import {acceptUnlock,clearUnlock,securityFetch,securitySnapshot,nativeSecurityOperation,securityApi,revokeUnlock} from '../src/securitySession.js';
import {startSecurityLifecycle} from '../src/securityLifecycle.js';

const env={SECURITY_PIN_PEPPER:'test-pepper-'.repeat(4),SECURITY_RP_ID:'localhost',SECURITY_ORIGINS:'http://localhost:5173'};
test('five digit PIN policy, leading zero, unique salts and pepper isolation',async()=>{
 for(const pin of ['12345','54321','00000','11111','23456','98765','1234','123456',12345,'abcde'])assert.equal(validPin(pin),false,String(pin));
 assert.equal(validPin('03927'),true);
 const a=await createPin('03927',env),b=await createPin('03927',env);
 assert.notEqual(a.salt,b.salt);assert.notEqual(a.key,b.key);assert.equal(a.version,1);
 assert.equal(await verifyPin('03927',a,env),true);assert.equal(await verifyPin('03928',a,env),false);
 assert.equal(await verifyPin('03927',a,{SECURITY_PIN_PEPPER:'other'.repeat(10)}),false);
 await assert.rejects(()=>createPin('03927',{}),{code:'security_not_configured'});
});
test('RP configuration requires explicit secure origins matching the RP',()=>{
 assert.deepEqual(webauthnConfig(env),{rpID:'localhost',origins:['http://localhost:5173']});
 for(const config of [{},{SECURITY_RP_ID:'example.com',SECURITY_ORIGINS:'https://evil.com'},
  {SECURITY_RP_ID:'example.com',SECURITY_ORIGINS:'http://example.com'},
  {SECURITY_RP_ID:'example.com',SECURITY_ORIGINS:'https://example.com/path'}])assert.throws(()=>webauthnConfig(config));
});
test('identity requires a verified Privy session, never a browser callback',async()=>{
 await assert.rejects(()=>authenticateIdentity({headers:{}},{verifyAuthToken:async()=>{throw Error();}}),{code:'unauthorized'});
 await assert.rejects(()=>authenticateIdentity({headers:{authorization:'Bearer fake'}},{verifyAuthToken:async()=>({userId:'a'})}),{code:'unauthorized'});
 assert.deepEqual(await authenticateIdentity({headers:{Authorization:'Bearer verified'}},{verifyAuthToken:async()=>({userId:'a',sessionId:'s'})}),{userId:'a',sessionId:'s'});
});

test('security API with PostgreSQL: factors, lockout, sessions, WebAuthn and recovery scopes',async t=>{
 const engine=new PGlite();await engine.waitReady;t.after(()=>engine.close());
 const migration=await readFile(new URL('../db/migrations/20261021_app_security.sql',import.meta.url),'utf8');
 await engine.exec(migration);await engine.exec(migration);
 const query=(sql,params=[])=>engine.query(sql,params);
 let tail=Promise.resolve();
 const pool={query,connect:async()=>{const previous=tail;let release;tail=new Promise(r=>{release=r;});await previous;return {query,release};}};
 const owner={userId:'did:privy:alice',sessionId:'alice-session'};
 const api=createSecurityHandler({pool:()=>pool,env,identity:async event=>event.owner || owner});
 let ip=0;
 const call=async(action,body={},headers={},who,handler=api)=>{
  const response=await handler({httpMethod:action==='status'?'GET':'POST',path:'/security/'+action,body:JSON.stringify(body),
   headers:{'x-nf-client-connection-ip':'test-ip-'+(++ip),...headers},owner:who});
  assert.equal(response.headers['Cache-Control'],'no-store');return {status:response.statusCode,...JSON.parse(response.body)};
 };
 let unlock;
 await t.test('new/existing users cannot access private APIs with Privy alone',async()=>{
  assert.equal((await call('status')).pin,false);
  await assert.rejects(()=>requireUnlock({headers:{authorization:'Bearer privy'}},owner,pool,env),{code:'app_locked'});
  await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':opaque()}},owner,pool,env),{code:'app_locked'});
  const result=await call('pin/enroll',{pin:'03927'});assert.equal(result.status,200);unlock=result.token;
  const stored=(await query('SELECT * FROM app_security_sessions')).rows[0];assert.notEqual(stored.token_hash,unlock);assert.equal(stored.token_hash,hash(unlock));
  assert.equal((await call('status')).pin,true);
  await requireUnlock({headers:{'x-app-unlock':unlock}},owner,pool,env);
  await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':unlock}},{...owner,sessionId:'other'},pool,env),{code:'app_locked'});
  await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':unlock}},{...owner,userId:'other'},pool,env),{code:'app_locked'});
 });
 await t.test('changes need a fresh factor; last method cannot be removed',async()=>{
  assert.equal((await call('pin/enroll',{pin:'92837'},{'x-app-unlock':unlock})).status,403);
  assert.equal((await call('methods/remove',{id:'pin'})).error,'last_factor_required');
 });
 await t.test('five concurrent incorrect PIN attempts commit and block for 15 minutes',async()=>{
  const results=await Promise.all(Array.from({length:5},()=>call('pin/verify',{pin:'92837'})));
  assert.equal(results.filter(result=>result.error==='incorrect_pin').length,5);
  const row=(await query('SELECT * FROM app_security_users WHERE user_id=$1',[owner.userId])).rows[0];
  assert.equal(row.failed_attempts,5);assert.ok(new Date(row.blocked_until).getTime()>Date.now()+14*60000);
  assert.equal((await call('pin/verify',{pin:'03927'})).error,'pin_blocked');
  assert.equal((await call('recovery/start',{})).error,'recovery_unavailable');
  await query("UPDATE app_security_users SET blocked_until=now()-interval '1 second' WHERE user_id=$1",[owner.userId]);
  assert.equal((await call('pin/verify',{pin:'92837'})).error,'incorrect_pin');
  assert.equal((await query('SELECT failed_attempts FROM app_security_users')).rows[0].failed_attempts,1);
  assert.equal((await call('pin/verify',{pin:'03927'})).scope,'unlock');
 });
 await t.test('opaque unlock renewal, expiration and revocation',async()=>{
  assert.equal((await call('renew',{}, {'x-app-unlock':unlock})).expiresIn,90);
  await call('lock',{}, {'x-app-unlock':unlock});
  await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':unlock}},owner,pool,env),{code:'app_locked'});
  unlock=(await call('pin/verify',{pin:'03927'})).token;
  await query("UPDATE app_security_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash(unlock)]);
  assert.equal((await call('renew',{}, {'x-app-unlock':unlock})).status,423);
  const absolute=(await call('pin/verify',{pin:'03927'})).token;
  await query("UPDATE app_security_sessions SET absolute_expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash(absolute)]);
  assert.equal((await call('renew',{}, {'x-app-unlock':absolute})).status,423);
 });
 await t.test('PIN change consumes a single-use management grant and invalidates all unlocks',async()=>{
  unlock=(await call('pin/verify',{pin:'03927'})).token;
  const grant=await call('pin/verify',{pin:'03927',purpose:'manage'});
  await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':grant.token}},owner,pool,env),{code:'app_locked'});
  assert.equal((await call('pin/enroll',{pin:'92837'},{'x-security-grant':grant.token})).status,200);
  assert.equal((await call('pin/enroll',{pin:'83726'},{'x-security-grant':grant.token})).status,403);
  await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':unlock}},owner,pool,env),{code:'app_locked'});
  assert.equal((await call('pin/verify',{pin:'03927'})).status,403);
 });
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});
 const cose=Buffer.concat([Buffer.from('a5010203262001215820','hex'),Buffer.from(jwk.x,'base64url'),Buffer.from('225820','hex'),Buffer.from(jwk.y,'base64url')]);
 const credentialId=opaque();
 function response(challenge,{origin=env.SECURITY_ORIGINS,rp=env.SECURITY_RP_ID,flags=5,counter=1,key=privateKey,userHandle}={}) {
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin}));
  const auth=Buffer.concat([createHash('sha256').update(rp).digest(),Buffer.from([flags]),Buffer.alloc(4)]);auth.writeUInt32BE(counter,33);
  const signature=sign('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),key);
  return {id:credentialId,rawId:credentialId,type:'public-key',clientExtensionResults:{},response:{clientDataJSON:client.toString('base64url'),authenticatorData:auth.toString('base64url'),signature:signature.toString('base64url'),...(userHandle?{userHandle}:{})}};
 }
 function registration(challenge,{origin=env.SECURITY_ORIGINS,rp=env.SECURITY_RP_ID,flags=69}={}) {
  const credential=Buffer.from(credentialId,'base64url'),length=Buffer.alloc(2);length.writeUInt16BE(credential.length);
  const auth=Buffer.concat([createHash('sha256').update(rp).digest(),Buffer.from([flags]),Buffer.alloc(4+16),length,credential,cose]);
  const attestation=Buffer.concat([Buffer.from('a363666d74646e6f6e656761747453746d74a068617574684461746158','hex'),Buffer.from([auth.length]),auth]);
  return {id:credentialId,rawId:credentialId,type:'public-key',clientExtensionResults:{},response:{
   clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.create',challenge,origin})).toString('base64url'),
   attestationObject:attestation.toString('base64url'),transports:['internal']}};
 }
 await t.test('passkey options demand UV and store single-use, expiring, session-bound challenges',async()=>{
  const grant=await call('pin/verify',{pin:'92837',purpose:'manage'});
  const options=await call('passkey/register-options',{}, {'x-security-grant':grant.token});
  assert.equal(options.options.authenticatorSelection.userVerification,'required');
  const saved=(await query('SELECT * FROM app_security_challenges WHERE id=$1',[options.challengeId])).rows[0];
  assert.ok(new Date(saved.expires_at).getTime()<Date.now()+301000);
  const other=await call('passkey/register',{challengeId:options.challengeId,response:{}},{},{...owner,sessionId:'other'});assert.equal(other.error,'invalid_challenge');
  assert.equal((await call('passkey/register',{challengeId:options.challengeId,response:{}})).error,'invalid_passkey');
  assert.equal((await call('passkey/register',{challengeId:options.challengeId,response:{}})).error,'invalid_challenge');
  // Test actual attestation verification, not a mocked success callback.
  for(const variation of [{origin:'https://evil.example'},{rp:'evil.example'},{flags:65}]) {
   const authorization=await call('pin/verify',{pin:'92837',purpose:'manage'});
   const attempt=await call('passkey/register-options',{}, {'x-security-grant':authorization.token});
   assert.equal((await call('passkey/register',{challengeId:attempt.challengeId,response:registration(attempt.options.challenge,variation)})).error,'invalid_passkey');
  }
  const authorization=await call('pin/verify',{pin:'92837',purpose:'manage'});
  const attempt=await call('passkey/register-options',{}, {'x-security-grant':authorization.token});
  assert.equal((await call('passkey/register',{challengeId:attempt.challengeId,response:registration(attempt.options.challenge)})).scope,'unlock');
  const savedKey=(await query('SELECT * FROM app_security_passkeys WHERE credential_id=$1',[credentialId])).rows[0];
  assert.equal(savedKey.credential.publicKey,cose.toString('base64url'));assert.deepEqual(savedKey.credential.transports,['internal']);
 });
 await t.test('real WebAuthn signatures reject wrong origin, RP, UV, key, user handle and foreign credential',async()=>{
  for(const variation of [{origin:'https://evil.example'},{rp:'evil.example'},{flags:1},{key:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey},{userHandle:'foreign'}]) {
   const options=await call('passkey/options');assert.equal(options.options.userVerification,'required');
   assert.equal((await call('passkey/verify',{challengeId:options.challengeId,response:response(options.options.challenge,variation)})).error,'invalid_passkey');
   assert.equal((await call('passkey/verify',{challengeId:options.challengeId,response:response(options.options.challenge)})).error,'invalid_challenge');
  }
  const foreign=await call('passkey/options');
  const foreignResponse=response(foreign.options.challenge);foreignResponse.id=opaque();
  assert.equal((await call('passkey/verify',{challengeId:foreign.challengeId,response:foreignResponse})).error,'invalid_passkey');
  const expired=await call('passkey/options');
  await query("UPDATE app_security_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.challengeId]);
  assert.equal((await call('passkey/verify',{challengeId:expired.challengeId,response:response(expired.options.challenge)})).error,'invalid_challenge');
  const options=await call('passkey/options');
  assert.equal((await call('passkey/verify',{challengeId:options.challengeId,response:response(options.options.challenge)})).scope,'unlock');
 });
 await t.test('passkey remains available during PIN lockout',async()=>{
  await query("UPDATE app_security_users SET blocked_until=now()+interval '15 minutes' WHERE user_id=$1",[owner.userId]);
  const options=await call('passkey/options');
  assert.equal((await call('passkey/verify',{challengeId:options.challengeId,response:response(options.options.challenge,{counter:2})})).scope,'unlock');
 });
 await t.test('fresh passkey verification can remove a blocked PIN and restore an alternate method',async()=>{
  const options=await call('passkey/options',{purpose:'manage'});
  const authorization=await call('passkey/verify',{challengeId:options.challengeId,response:response(options.options.challenge,{counter:3})});
  assert.equal(authorization.scope,'manage');
  const removed=await call('methods/remove',{id:'pin'},{'x-security-grant':authorization.token});
  assert.equal(removed.scope,'unlock');assert.equal((await call('status')).pin,false);
  assert.equal((await call('methods/remove',{id:credentialId})).error,'last_factor_required');
  const fresh=await call('passkey/options',{purpose:'manage'});
  const grant=await call('passkey/verify',{challengeId:fresh.challengeId,response:response(fresh.options.challenge,{counter:4})});
  assert.equal((await call('pin/enroll',{pin:'92837'},{'x-security-grant':grant.token})).scope,'unlock');
  assert.equal((await call('status')).pin,true);
 });
 await t.test('recovery adapter is server-bound and grants only factor enrollment',async()=>{
  let starts=0,verifications=0;
  const recovery={available:true,start:async({userId,challengeId})=>{assert.equal(userId,owner.userId);assert.ok(challengeId);starts++;return {providerChallenge:'server-only'};},
   verify:async({userId,state,code})=>{assert.equal(userId,owner.userId);assert.equal(state.providerChallenge,'server-only');verifications++;return code==='offline-otp';}};
  const handler=createSecurityHandler({pool:()=>pool,env,identity:async()=>owner,recovery});
  const start=await call('recovery/start',{destination:'arbitrary-ignored'}, {},undefined,handler);
  const recovered=await call('recovery/verify',{challengeId:start.challengeId,code:'offline-otp'},{},undefined,handler);
  assert.equal(recovered.scope,'recover');assert.equal(starts,1);assert.equal(verifications,1);
  await assert.rejects(()=>requireUnlock({headers:{'x-app-unlock':recovered.token}},owner,pool,env),{code:'app_locked'});
  assert.equal((await call('methods/remove',{id:'pin'},{'x-security-grant':recovered.token},undefined,handler)).status,403);
  const second=await call('recovery/start',{}, {},undefined,handler);
  const grant=await call('recovery/verify',{challengeId:second.challengeId,code:'offline-otp'},{},undefined,handler);
  assert.equal((await call('pin/enroll',{pin:'84726'},{'x-security-grant':grant.token},undefined,handler)).scope,'unlock');
  assert.equal((await query('SELECT * FROM app_security_passkeys')).rows.length,0);
  assert.equal((await call('pin/verify',{pin:'92837'})).status,403);
  assert.equal((await call('pin/verify',{pin:'84726'})).scope,'unlock');
 });
 await t.test('IP limit is shared across users and atomic in PostgreSQL',async()=>{
  const event={httpMethod:'POST',path:'/security/lock',headers:{'x-nf-client-connection-ip':'rate-test'},body:'{}'};
  await query("INSERT INTO app_security_limits VALUES($1,100,now()+interval '15 minutes')",['ip:'+hash('rate-test')]);
  assert.equal((await api(event)).statusCode,429);
 });
});

test('client keeps unlock in memory, discards late fetch bodies, bounds native operations',async t=>{
 const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;clearUnlock();});
 acceptUnlock({token:opaque(),expiresIn:90},'alice');
 let finish;
 globalThis.fetch=async(_,options)=>{assert.equal(options.headers['X-App-Unlock'],securitySnapshot().credential);return new Promise(resolve=>{finish=resolve;});};
 const request=securityFetch('/contacts');clearUnlock();finish(new Response('{}'));
 await assert.rejects(()=>request,/app_locked/);
 acceptUnlock({token:opaque(),expiresIn:90},'alice');
 globalThis.fetch=async()=>new Response('{"private":true}');
 const response=await securityFetch('/contacts');clearUnlock();await assert.rejects(()=>response.json(),/app_locked/);
 const original=securitySnapshot().epoch;
 await nativeSecurityOperation(async()=>{assert.equal(securitySnapshot().native,true);});
 assert.equal(securitySnapshot().native,false);assert.equal(securitySnapshot().epoch,original);
 let finishNative;
 const oldOperation=nativeSecurityOperation(()=>new Promise(resolve=>{finishNative=resolve;}));
 assert.equal(securitySnapshot().native,true);
 clearUnlock();acceptUnlock({token:'new-user-token',expiresIn:90},'bob');
 assert.equal(securitySnapshot().native,false,'old user dialogs cannot exempt a new session from locking');
 finishNative();await oldOperation;
 assert.equal(securitySnapshot().credential,'new-user-token');
});

test('page lifecycle covers immediately, relocks on return, pauses renewal and exempts only native operations',async t=>{
 const window=new EventTarget(),document=new EventTarget(),classes=new Set();
 let focused=true,heartbeat,covered=false,revoked=0,renewals=0,clock=Date.now();
 document.visibilityState='visible';document.hasFocus=()=>focused;
 document.documentElement={classList:{add:value=>classes.add(value),toggle:(value,on)=>on?classes.add(value):classes.delete(value)}};
 let renew=async()=>{renewals++;return {expiresIn:90};};
 const stop=startSecurityLifecycle({window,document,now:()=>clock,onHidden:value=>{covered=value;},
  revoke:()=>{revoked++;clearUnlock();},renew:token=>renew(token),every:callback=>{heartbeat=callback;return 1;},cancel:id=>assert.equal(id,1)});
 t.after(()=>{stop();clearUnlock();});
 const unlock=()=>acceptUnlock({token:opaque(),expiresIn:90},'alice');
 unlock();focused=false;window.dispatchEvent(new Event('blur'));
 assert.ok(classes.has('mp-security-covered'));assert.equal(covered,true);assert.equal(securitySnapshot().credential,null);
 focused=true;window.dispatchEvent(new Event('focus'));assert.equal(classes.has('mp-security-covered'),false);assert.equal(securitySnapshot().credential,null);
 unlock();await heartbeat();assert.equal(renewals,1);
 const before=revoked;
 await nativeSecurityOperation(async()=>{
  focused=false;window.dispatchEvent(new Event('blur'));assert.ok(securitySnapshot().credential);assert.equal(revoked,before);
  await heartbeat();assert.equal(renewals,1);
  focused=true;window.dispatchEvent(new Event('focus'));assert.ok(securitySnapshot().credential);
 });
 assert.equal(revoked,before);assert.equal(securitySnapshot().native,false);
 await nativeSecurityOperation(async()=>{focused=false;document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));});
 assert.equal(securitySnapshot().credential,null,'native exception must end with the operation');
 focused=true;document.visibilityState='visible';window.dispatchEvent(new Event('focus'));
 unlock();await nativeSecurityOperation(async()=>{window.dispatchEvent(new Event('pagehide'));assert.equal(securitySnapshot().credential,null);});
 assert.ok(classes.has('mp-security-covered'));window.dispatchEvent(new Event('pageshow'));assert.equal(securitySnapshot().credential,null);
 unlock();clock=securitySnapshot().deadline+1;await heartbeat();assert.equal(securitySnapshot().credential,null);
 clock=Date.now();unlock();let finish;renew=()=>new Promise(resolve=>{finish=resolve;});
 const pending=heartbeat();window.dispatchEvent(new Event('mp-security-lock'));finish({expiresIn:90});await pending;
 assert.equal(securitySnapshot().credential,null);assert.equal(securitySnapshot().deadline,0);
 unlock();renew=async()=>{throw new Error('offline');};await heartbeat();assert.equal(securitySnapshot().credential,null);
});

test('revocation requests survive document unloading using keepalive',async t=>{
 const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
 let request;
 globalThis.fetch=async(path,options)=>{request={path,...options};return new Response('{"locked":true}',{headers:{'Content-Type':'application/json'}});};
 await securityApi('lock',async()=> 'fixture-identity',{}, {'X-App-Unlock':'fixture-unlock'});
 assert.equal(request.path,'/security/lock');assert.equal(request.method,'POST');assert.equal(request.keepalive,true);
 assert.equal(request.cache,'no-store');
});

test('changing Privy users revokes the old unlock with its own identity, including renewed tokens',async t=>{
 const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;clearUnlock();});
 const requests=[];
 globalThis.fetch=async(path,options)=>{
  requests.push({path,options});
  return new Response(JSON.stringify(path.endsWith('/pin/verify')?{token:opaque(),scope:'unlock',expiresIn:90}:{expiresIn:90}));
 };
 const result=await securityApi('pin/verify',async()=> 'alice-old-identity',{pin:'03927'});
 acceptUnlock(result,'alice');
 await securityApi('renew',async()=> 'alice-renewed-identity',{}, {'X-App-Unlock':result.token});
 await revokeUnlock(async()=> 'bob-new-identity');
 assert.equal(requests.at(-1).path,'/security/lock');
 assert.equal(requests.at(-1).options.headers.Authorization,'Bearer alice-renewed-identity');
 assert.equal(requests.at(-1).options.headers['X-App-Unlock'],result.token);
 assert.equal(securitySnapshot().credential,null);
});
