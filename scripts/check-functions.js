import { zipFunctions } from "@netlify/zip-it-and-ship-it";
import { resolve,sep } from "node:path";
import { spawnSync } from "node:child_process";
import { writeFile,mkdir,mkdtemp,rm } from "node:fs/promises";
Object.assign(process.env,{
 MP_ENVIRONMENT:process.env.VITE_SOLANA_CLUSTER==="mainnet-beta"?"production":"test",
 MP_ACCESS_TOKEN:"offline-check-token",MP_USER_ID:"123",MP_WEBHOOK_SECRET:"offline-check-webhook",
 SOLANA_RPC:"https://example.invalid",INTERNAL_WORKER_SECRET:"x".repeat(32),
 APP_COUNTRY:"CO",APP_ENVIRONMENT:"sandbox",VITE_SOLANA_CLUSTER:"devnet",PLATFORM_ENABLED:"false",
 ONEPAY_WEBHOOK_TOKEN:"offline-check-token",ONEPAY_WEBHOOK_SECRET:"offline-check-secret"
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
for(const name of ["wallet","contacts","treasury-export-access","transfers","transfers-worker-background","charges","merchant-pos","merchant-profile","payment-reports","mercadopago-webhook","payments-worker-background","platform","onepay-webhook","platform-worker-background","app-config"]) {
 const entry=functions.find(fn=>fn.name===name);
 if(!entry)throw new Error(`Missing packaged function: ${name}`);
 // Netlify's runtime loads these bundles as CJS, outside this repo's type=module.
 await writeFile(resolve(entry.path,"package.json"),JSON.stringify({type:"commonjs"}));
 entries.push({name,path:resolve(entry.path,`${name}.js`)});
}
// Exit the child before cleanup: Windows locks loaded native addons until exit.
const smoke=spawnSync(process.execPath,["--input-type=commonjs","-e",`
 globalThis.fetch=async()=>{throw new Error("Network access is forbidden in the Functions check");};
 (async()=>{
  for(const {name,path} of JSON.parse(process.argv[1])) {
   const module=require(path),handler=module.handler || module.default?.handler;
   const result=await handler({path:"/.netlify/functions/"+name,httpMethod:["mercadopago-webhook","onepay-webhook"].includes(name)?"POST":"GET",headers:{},body:"{}"});
   if(name==="app-config") {
    if(result.statusCode!==200 || JSON.parse(result.body).country.code!=="CO")throw new Error("Public configuration check failed");
    continue;
   }
   if(![400,401,403,405].includes(result.statusCode))throw new Error("Authentication check failed: "+name);
  }
 })().catch(()=>{process.exitCode=1;});
`,JSON.stringify(entries)],{encoding:"utf8",timeout:30000});
if(smoke.status!==0)throw new Error(`Packaged Functions smoke check failed (exit ${smoke.status ?? smoke.error?.code}).`);
console.log(`Packaged ${functions.length} Functions; protected endpoints reject unauthenticated requests.`);
} finally {
 // Remove only the unique directory created by this invocation, inside .netlify.
 await rm(output,{recursive:true,force:true});
}
