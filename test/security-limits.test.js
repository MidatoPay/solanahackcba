import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './security-fixture.js';
import {hash,opaque} from '../netlify/functions/lib/securityCore.js';
import {takeLimit} from '../netlify/functions/lib/securityLimits.js';

for(const count of [4,20])test(`${count} sessions sharing an IP renew for 30 simulated minutes`,async t=>{
 const {query,call}=await fixture(t);
 const sessions=[];
 for(let i=0;i<count;i++) {
  const owner={userId:'user-'+i,sessionId:'session-'+i},token=opaque();
  await query('INSERT INTO app_security_users(user_id) VALUES($1)',[owner.userId]);
  await query(`INSERT INTO app_security_sessions VALUES($1,$2,$3,'unlock',now()+interval '90 seconds',now()+interval '12 hours',false)`,[hash(token),owner.userId,owner.sessionId]);
  sessions.push({owner,token});
 }
 for(let tick=0;tick<60;tick++) {
  for(const {owner,token} of sessions)assert.equal((await call('renew',{}, {'x-app-unlock':token},owner)).status,200);
  // Advance PostgreSQL deadlines together by the heartbeat interval.
  await query("UPDATE app_security_limits SET expires_at=expires_at-interval '30 seconds'");
  await query("UPDATE app_security_sessions SET expires_at=expires_at-interval '30 seconds',absolute_expires_at=absolute_expires_at-interval '30 seconds'");
 }
 assert.equal((await query("SELECT * FROM app_security_limits WHERE key LIKE 'auth:%'")).rows.length,0);
});
test('authentication exhaustion cannot prevent idempotent lock or valid renewal',async t=>{
 const {query,call,owner}=await fixture(t);
 const token=opaque();
 await call('status');
 await query(`INSERT INTO app_security_sessions VALUES($1,$2,$3,'unlock',now()+interval '90 seconds',now()+interval '12 hours',false)`,[hash(token),owner.userId,owner.sessionId]);
 await query("INSERT INTO app_security_limits VALUES($1,60,now()+interval '15 minutes')",['auth:user:'+hash(owner.userId)]);
 assert.equal((await call('pin/verify',{pin:'03927'})).status,429);
 assert.equal((await call('renew',{}, {'x-app-unlock':token})).status,200);
 for(let i=0;i<2;i++)assert.equal((await call('lock',{}, {'x-app-unlock':token})).status,200);
 assert.equal((await call('renew',{}, {'x-app-unlock':token})).status,423);
});
test('atomic counters, Retry-After, renewal identity isolation and trusted IP',async t=>{
 const {query,call,owner}=await fixture(t);
 const results=await Promise.allSettled(Array.from({length:20},()=>takeLimit({query},'concurrent',10,60)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,10);
 assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.retryAfter>0));
 const token=opaque();await call('status');
 await query(`INSERT INTO app_security_sessions VALUES($1,$2,$3,'unlock',now()+interval '90 seconds',now()+interval '12 hours',false)`,[hash(token),owner.userId,owner.sessionId]);
 for(let i=0;i<12;i++)assert.equal((await call('renew',{}, {'x-app-unlock':token},{...owner,sessionId:'foreign'})).status,423);
 assert.equal((await query('SELECT * FROM app_security_limits WHERE key=$1',['renew:'+hash(token)])).rows.length,0);
 for(let i=0;i<10;i++)assert.equal((await call('renew',{}, {'x-app-unlock':token})).status,200);
 const denied=await call('renew',{}, {'x-app-unlock':token});assert.equal(denied.status,429);assert.ok(Number(denied.headers['Retry-After'])>0);
 await query("INSERT INTO app_security_limits VALUES($1,1000,now()+interval '15 minutes')",['auth:ip:'+hash('shared-ip')]);
 assert.equal((await call('pin/verify',{}, {'x-forwarded-for':'different-ip'})).status,429);
});
