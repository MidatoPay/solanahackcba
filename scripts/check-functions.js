import { zipFunctions } from "@netlify/zip-it-and-ship-it";
import { resolve,sep } from "node:path";
import { spawnSync } from "node:child_process";
import { readFile,writeFile,mkdir,mkdtemp,rm } from "node:fs/promises";
Object.assign(process.env,{
 MP_ENVIRONMENT:process.env.VITE_SOLANA_CLUSTER==="mainnet-beta"?"production":"test",
 MP_ACCESS_TOKEN:"offline-check-token",MP_USER_ID:"123",MP_WEBHOOK_SECRET:"offline-check-webhook",
 SOLANA_RPC:"https://example.invalid",INTERNAL_WORKER_SECRET:"x".repeat(32)
});
// Any accidental remote request makes this check fail immediately.
globalThis.fetch=async()=>{throw new Error("Network access is forbidden in the packaged Functions check");};

// Package exactly as Netlify does; smoke checks never authenticate or move money.
const artifactsRoot=resolve(".netlify");
await mkdir(artifactsRoot,{recursive:true});
const output=await mkdtemp(resolve(artifactsRoot,"functions-review-"));
if(!output.startsWith(artifactsRoot+sep))throw new Error("Invalid Functions artifacts path");
try {
const functions=await zipFunctions("netlify/functions",output,{
 config:{"*":{nodeBundler:"esbuild"}},archiveFormat:"none"
});
const entries=[];
for(const name of ['rpc','eth-rpc','balance','quote']) {
 const fn=functions.find(entry=>entry.name===name);
 if(fn?.runtimeAPIVersion!==2 || !fn.trafficRules || !fn.routes?.some(route=>route.pattern==='/'+name))throw new Error(`Missing packaged rate limit for ${name}`);
}
for(const name of ["security","wallet","contacts","balance","quote","rpc","eth-rpc","treasury","treasury-export-access","transfers","transfers-worker-background","charges","merchant-pos","merchant-profile","payment-reports","mercadopago-webhook","payments-worker-background"]) {
 const entry=functions.find(fn=>fn.name===name);
 if(!entry)throw new Error(`Missing packaged function: ${name}`);
 await writeFile(resolve(entry.path,"package.json"),JSON.stringify({type:entry.runtimeAPIVersion===2?'module':'commonjs'}));
 let source=resolve(entry.path,entry.entryFilename || `${name}.js`);
 if(entry.runtimeAPIVersion===2) {
  // The generated AWS entry point requires the Lambda runtime. Smoke-test the
  // packaged application module referenced by it, using real Request/Response.
  const wrapper=await readFile(source,'utf8');
  const match=/getLambdaHandler\(\s*['"]([^'"]+)['"]/.exec(wrapper);
  if(!match)throw new Error(`Missing packaged fetch handler for ${name}`);
  source=resolve(entry.path,match[1]);
 }
 entries.push({name,path:source,v2:entry.runtimeAPIVersion===2});
}
// Functions run in isolated Lambda processes. Keep smoke checks isolated too,
// particularly when mixing CJS and native ESM dependency graphs.
for(const entry of entries) {
const smoke=spawnSync(process.execPath,["--input-type=commonjs","-e",`
 globalThis.fetch=async()=>{throw new Error("Network access is forbidden in the Functions check");};
 (async()=>{
  for(const {name,path,v2} of JSON.parse(process.argv[1])) {
   console.log('Checking '+name);
   const method=["mercadopago-webhook","quote"].includes(name)?"POST":"GET";
   let status;
   if(v2) {
    const module=await import(require('node:url').pathToFileURL(path).href);
    const result=await module.default(new Request('https://example.invalid/.netlify/functions/'+name,{method,body:method==='POST'?'{}':undefined}));
    status=result.status;
   }else {
    const module=require(path),handler=module.handler || module.default?.handler;
    status=(await handler({path:"/.netlify/functions/"+name,httpMethod:method,headers:{},body:"{}"})).statusCode;
   }
   if(![400,401,403,405].includes(status))throw new Error("Authentication check failed: "+name);
  }
 })().then(()=>process.exit(0)).catch(error=>{console.error(error.message);process.exit(1);});
`,JSON.stringify([entry])],{encoding:"utf8",stdio:'inherit',timeout:60000});
if(smoke.status!==0)throw new Error(`Packaged Functions smoke check failed (exit ${smoke.status ?? smoke.error?.code}): ${smoke.stderr?.trim() || smoke.stdout?.trim().split('\n').slice(-3).join(', ') || 'No diagnostic output'}`);
}
console.log(`Packaged ${functions.length} Functions; protected endpoints reject unauthenticated requests.`);
} finally {
 // Remove only the unique directory created by this invocation, inside .netlify.
 await rm(output,{recursive:true,force:true});
}
