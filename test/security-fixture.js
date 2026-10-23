import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {createSecurityHandler} from '../netlify/functions/security.js';
export const securityEnv={SECURITY_PIN_PEPPER:'test-pin-pepper-'.repeat(3),SECURITY_RECOVERY_PEPPER:'test-recovery-pepper-'.repeat(3),
 SECURITY_RP_ID:'localhost',SECURITY_ORIGINS:'http://localhost:5173',RESEND_API_KEY:'fixture',SECURITY_RECOVERY_FROM:'security@example.test'};
export async function fixture(t,options={}) {
 const engine=new PGlite();await engine.waitReady;t.after(()=>engine.close());
 for(const name of ['20261021_app_security.sql',...(options.recoveryMigration?['20261022_security_recovery.sql']:[])])
  await engine.exec(await readFile(new URL('../db/migrations/'+name,import.meta.url),'utf8'));
 const query=(sql,params=[])=>engine.query(sql,params);
 let tail=Promise.resolve();
 const pool={query,connect:async()=>{const previous=tail;let release;tail=new Promise(r=>{release=r;});await previous;return {query,release};}};
 const owner={userId:'did:privy:fixture',sessionId:'fixture-session'};
 const handler=createSecurityHandler({pool:()=>pool,env:securityEnv,identity:async e=>e.owner || owner,...options});
 const call=async(action,body={},headers={},who=owner)=>{
  const response=await handler({owner:who,httpMethod:action==='status'?'GET':'POST',path:'/security/'+action,
   headers:{'x-nf-client-connection-ip':'shared-ip',...headers},body:JSON.stringify(body)});
  return {status:response.statusCode,headers:response.headers,...JSON.parse(response.body)};
 };
 return {engine,query,pool,owner,handler,call};
}
