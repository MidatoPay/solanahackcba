// Unlock credentials deliberately never enter storage, URLs, logs or caches.
let credential=null,epoch=0,deadline=0,owner=null,privyCredential=null,bypass=false,privySession=null;
const unlockIdentities=new WeakMap();
const nativeOperations=new Set();
const listeners=new Set();
export const securitySnapshot=()=>({credential,epoch,bypass,native:[...nativeOperations].some(operation=>operation.epoch===epoch),
 nativeState:[...nativeOperations].find(operation=>operation.epoch===epoch)?.state || null,deadline,owner});
export const observeSecurity=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
const emit=()=>listeners.forEach(listener=>listener());
export function acceptUnlock(value,userId=owner) {
 epoch++;bypass=value.scope==='bypass';credential=value.token || null;privyCredential=unlockIdentities.get(value) || null;owner=userId;deadline=Date.now()+(value.expiresIn || 0)*1000;emit();
}
// Client-side parsing only invalidates local state; the server verifies JWTs.
export function bindPrivySession(token) {
 let next=null;
 try {const claims=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(claims.sub && claims.sid)next=claims.sub+':'+claims.sid;}catch{}
 if(privySession && next!==privySession)clearUnlock();
 privySession=next;
}
export function extendUnlock(seconds){deadline=Date.now()+seconds*1000;emit();}
export function clearUnlock() {
 const old=credential;credential=null;privyCredential=null;owner=null;bypass=false;deadline=0;epoch++;
 for(const operation of [...nativeOperations])operation.cancel(false);
 emit();return old;
}
export function revokeUnlock(getToken) {
 // Capture the identity that acquired this unlock before Privy changes users.
 const identityToken=privyCredential,token=clearUnlock();
 if(!token)return Promise.resolve();
 return securityApi('lock',identityToken?()=>identityToken:getToken,{}, {'X-App-Unlock':token});
}
export function nativeSecurityOperation(operation,{window=globalThis.window,document=globalThis.document,
 now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,onDiscard=()=>{}}={}) {
 return new Promise((resolve,reject)=>{
  const active={epoch,state:'open',cancel:null};let boundTimer,focusTimer,value,failure,settled=false,hasValue=false;
  const discard=result=>{try{onDiscard(result);}catch{}};
  const report=reason=>window?.dispatchEvent(new CustomEvent('mp-security-dialog-error',{detail:reason}));
  const cleanup=()=>{
   clearTimer(boundTimer);clearTimer(focusTimer);
   window?.removeEventListener('focus',focus);window?.removeEventListener('pagehide',cancel);
   document?.removeEventListener('visibilitychange',visibility);
   nativeOperations.delete(active);emit();
  };
  const cancel=(lock=true)=>{
   if(settled)return;settled=true;active.state='cancelled';
   // Keep the native exception until clearUnlock has invalidated its epoch.
   if(lock && active.epoch===epoch)clearUnlock();
   if(hasValue)discard(value);
   cleanup();report('interrupted');reject(Object.assign(new Error('app_locked'),{code:'app_locked'}));
  };
  active.cancel=cancel;
  const finish=()=>{
   if(settled)return;
   if(active.epoch!==epoch || (credential && now()>=deadline) || (document && document.visibilityState!=='visible')){cancel();return;}
   settled=true;active.state=failure?'cancelled':'finished';cleanup();if(failure){report('cancelled');reject(failure);}else resolve(value);
  };
  const focus=()=>{if(active.state==='waiting_focus' && document?.hasFocus())finish();};
  const visibility=()=>{if(active.state==='waiting_focus' && document?.visibilityState!=='visible')cancel();};
  nativeOperations.add(active);emit();
  window?.addEventListener('focus',focus);window?.addEventListener('pagehide',cancel);
  document?.addEventListener('visibilitychange',visibility);
  boundTimer=setTimer(()=>cancel(),credential?Math.min(120000,Math.max(0,deadline-now())):120000);
  let pending;
  // Invoke immediately in the native click stack: no token, network or await here.
  try{pending=operation();}catch(error){pending=Promise.reject(error);}
  const complete=()=>{
   if(settled)return;
   if(document?.visibilityState==='visible' && !document.hasFocus()){
    active.state='waiting_focus';emit();focusTimer=setTimer(()=>cancel(),2000);
   }else finish();
  };
  Promise.resolve(pending).then(result=>{if(settled){discard(result);return;}value=result;hasValue=true;complete();},error=>{failure=error;complete();});
 });
}
export const securityHeaders=()=>credential?{'X-App-Unlock':credential}:{};
export const requestSecurityLock=()=>window.dispatchEvent(new Event('mp-security-lock'));
export async function securityFetch(path,options={}) {
 if(credential && Date.now()>=deadline){clearUnlock();throw new Error('app_locked');}
 if(typeof window!=='undefined' && !credential && !bypass)throw new Error('app_locked');
 if(typeof document!=='undefined' && (document.visibilityState!=='visible' || !document.hasFocus()))throw new Error('app_inactive');
 const started=epoch;
 const response=await fetch(path,{...options,cache:'no-store',headers:{...options.headers,...securityHeaders()}});
 const check=()=>{if(started!==epoch)throw new Error('app_locked');};
 check();
 if(response.status===423)clearUnlock();
 const ok=response.ok;
 Object.defineProperty(response,'ok',{get(){check();return ok;}});
 for(const method of ['json','text','arrayBuffer']) {
  if(typeof response[method]!=='function')continue;
  const original=response[method].bind(response);
  response[method]=async()=>{check();const value=await original();check();return value;};
 }
 return response;
}
export async function securityApi(action,getToken,body,extra={}) {
 const started=epoch,requestedAt=Date.now();
 const token=await getToken();
 if(action!=='lock')bindPrivySession(token);
 if(started!==epoch && action!=='lock')throw new Error('app_locked');
 const response=await fetch('/security/'+action,{method:body===undefined?'GET':'POST',cache:'no-store',keepalive:action==='lock',
  headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...extra},
  body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();
 if(started!==epoch && action!=='lock')throw new Error('app_locked');
 if(!response.ok){const error=new Error(data.error || 'security_unavailable');error.code=data.error;error.retryAfter=Number(response.headers.get('Retry-After')) || 0;throw error;}
 if(data.expiresIn && (data.scope==='unlock' || action==='renew'))data.expiresIn=Math.max(0,data.expiresIn-(Date.now()-requestedAt)/1000);
 if((data.scope==='unlock' || action==='renew') && data.expiresIn<=0)throw Object.assign(new Error('app_locked'),{code:'app_locked'});
 if(data.scope==='unlock')unlockIdentities.set(data,token);
 if(action==='renew' && extra['X-App-Unlock']===credential)privyCredential=token;
 return data;
}
