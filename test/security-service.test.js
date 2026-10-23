import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,securityEnv} from './security-fixture.js';
import {requireUnlock} from '../netlify/functions/lib/securityAuth.js';
test('configured default recovery exposes availability without granting access',async t=>{
 const f=await fixture(t);const status=await f.call('status');
 assert.equal(status.recoveryAvailable,true);assert.equal(status.recoveryReady,false);assert.equal(status.recoveryEmail,null);
 await assert.rejects(()=>requireUnlock({headers:{}},f.owner,f.pool,securityEnv),{code:'app_locked'});
});
test('rollout uses exact server-owned DID membership and preserves enforcement by default',async t=>{
 const env={...securityEnv,SECURITY_ENFORCED:'false',SECURITY_PILOT_USER_IDS:'did:privy:fixture'};
 const f=await fixture(t,{env});
 assert.equal((await f.call('status')).enforced,true);
 assert.equal((await f.call('status',{}, {},{userId:'did:privy:fixture-extra',sessionId:'other'})).enforced,false);
 await assert.rejects(()=>requireUnlock({headers:{}},f.owner,f.pool,env),{code:'app_locked'});
 await requireUnlock({headers:{}},{userId:'other'},f.pool,env);
 await assert.rejects(()=>requireUnlock({headers:{}},{userId:'other'},f.pool,securityEnv),{code:'app_locked'});
});
