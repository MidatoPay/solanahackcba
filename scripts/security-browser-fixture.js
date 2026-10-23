// Explicit local-only test server. Does not load .env or contact Privy/payment providers.
import {createServer} from 'node:http';
import {readFile,mkdir,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {PGlite} from '@electric-sql/pglite';
import {createSecurityHandler} from '../netlify/functions/security.js';
import {requireUnlock} from '../netlify/functions/lib/securityAuth.js';
import {json,errorResponse} from '../netlify/functions/lib/paymentRuntime.js';
import {opaque} from '../netlify/functions/lib/securityCore.js';
import {createRecoveryService} from '../netlify/functions/lib/securityRecovery.js';

const port=5187,output=resolve('.netlify/security-browser-fixture');
await mkdir(output,{recursive:true});
await build({entryPoints:['test/browser/security-fixture.jsx'],outfile:resolve(output,'bundle.js'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',
 define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'offline-identities',setup(builder){
  builder.onResolve({filter:/^@privy-io\/react-auth(?:\/solana)?$/},()=>({path:resolve('test/browser/privy-fixture.jsx')}));
  builder.onResolve({filter:/^@simplewebauthn\/browser$/},()=>({path:'passkey-cancel',namespace:'fixture'}));
  builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
   export const browserSupportsWebAuthn=()=>true;
   export async function startRegistration(){await new Promise(r=>setTimeout(r,150));throw new DOMException('Fixture cancellation','NotAllowedError');}
   export const startAuthentication=startRegistration;
  `,loader:'js'}));
 }}]});
if(process.argv.includes('--build-only'))process.exit(0);
const engine=new PGlite();await engine.waitReady;
await engine.exec(await readFile('db/migrations/20261021_app_security.sql','utf8'));
await engine.exec(await readFile('db/migrations/20261022_security_recovery.sql','utf8'));
const query=(sql,params=[])=>engine.query(sql,params);let tail=Promise.resolve();
const pool={query,connect:async()=>{const previous=tail;let release;tail=new Promise(r=>{release=r;});await previous;return {query,release};}};
const env={SECURITY_PIN_PEPPER:opaque(),SECURITY_RECOVERY_PEPPER:opaque(),RESEND_API_KEY:'fixture',SECURITY_RECOVERY_FROM:'fixture@example.test',SECURITY_RP_ID:'localhost',SECURITY_ORIGINS:`http://localhost:${port}`};
const identity=async event=>{
 const token=event.headers.authorization;
 const id=token==='Bearer fixture-alice'?'alice':token==='Bearer fixture-bob'?'bob':null;
 if(!id)throw Object.assign(new Error(),{fixtureUnauthorized:true});
 return {userId:`did:privy:fixture-${id}`,sessionId:`fixture-session-${id}`};
};
// Explicitly local-only mail sink: exposes test OTPs solely in this fixture.
const mailbox=[];
const recovery=createRecoveryService({env,getUser:async userId=>{
 const email=userId.endsWith('bob')?'bob@example.test':'alice@example.test';
 return {email:{address:email},linkedAccounts:[{type:'email',address:email,firstVerifiedAt:new Date()}]};
},request:async(_url,options)=>{const mail=JSON.parse(options.body);mailbox.push({to:mail.to,code:mail.text.match(/\b\d{6}\b/)[0]});return new Response('{"id":"fixture"}');}});
const handler=createSecurityHandler({identity,pool:()=>pool,env,recovery});
let offline=false,privateReads=0,privateDenied=0;
const publicAssets=new Map();
for(const directory of ['logo','monedas'])for(const file of await readdir(resolve('public',directory)))
 if(/\.(png|svg|webp)$/.test(file))publicAssets.set(`/${directory}/${file}`,resolve('public',directory,file));
const state=async()=>({offline,privateReads,privateDenied,mailbox,users:(await query('SELECT user_id, pin IS NOT NULL AS pin, failed_attempts,blocked_until FROM app_security_users')).rows,
 liveUnlocks:(await query("SELECT count(*)::integer AS count FROM app_security_sessions WHERE scope='unlock' AND NOT revoked AND expires_at>now()")).rows[0].count});
const server=createServer(async(request,response)=>{
 const url=new URL(request.url,`http://localhost:${port}`),path=url.pathname;
 if(request.headers.origin && request.headers.origin!==env.SECURITY_ORIGINS){response.writeHead(403);response.end();return;}
 const send=result=>{response.writeHead(result.statusCode,result.headers);response.end(result.body);};
 try {
  if(path==='/') {response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});response.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MidatoPay — pruebas locales</title><link rel="stylesheet" href="/bundle.css"><style>body{margin:0;font-family:Poppins,sans-serif}.mp-overlay{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`);return;}
  if(path==='/away'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<h1>Otra pestaña de prueba</h1><button onclick="window.close()">Volver a la prueba</button>');return;}
  if(['/bundle.js','/bundle.css'].includes(path) || publicAssets.has(path)){
   response.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'image/png','Cache-Control':'no-store'});
   response.end(await readFile(path.startsWith('/bundle')?resolve(output,path.slice(1)):publicAssets.get(path)));return;
  }
  if(path.startsWith('/fixture/') && request.method==='POST') {
   if(path==='/fixture/offline')offline=true;
   else if(path==='/fixture/online')offline=false;
   else if(path==='/fixture/expire-lockout')await query("UPDATE app_security_users SET blocked_until=now()-interval '1 second' WHERE blocked_until IS NOT NULL");
   else if(path==='/fixture/revoke')await query('UPDATE app_security_sessions SET revoked=true');
   else if(path==='/fixture/expire-recovery-window')await query("UPDATE app_security_limits SET expires_at=now()-interval '1 second' WHERE key LIKE 'otp:minute:%'");
   else if(path!=='/fixture/state'){send(json(404,{}));return;}
   send(json(200,await state()));return;
  }
  if(offline){send(json(503,{error:'fixture_offline'}));return;}
  const event={path,httpMethod:request.method,headers:{...request.headers,'x-nf-client-connection-ip':'fixture-edge'}};
  if(path==='/fixture/private') {
   try {const owner=await identity(event);await requireUnlock(event,owner,pool,env);privateReads++;send(json(200,{message:'API privada autorizada'}));}
   catch{privateDenied++;send(json(423,{error:'app_locked'}));}return;
  }
  if(path.startsWith('/security/')) {
   let body='';for await(const chunk of request){body+=chunk;if(body.length>32768){send(json(413,{}));return;}}
   send(await handler({...event,body}));return;
  }
  send(json(404,{}));
 }catch(error){send(errorResponse(error));}
});
server.listen(port,'127.0.0.1',()=>console.log(`Fixture local: http://localhost:${port} — PostgreSQL efímero; sin proveedores externos.`));
