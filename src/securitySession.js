// Unlock credentials deliberately never enter storage, URLs, logs or caches.
let credential=null,epoch=0,deadline=0,owner=null,privyCredential=null;
const unlockIdentities=new WeakMap();
const nativeOperations=new Set();
const listeners=new Set();
export const securitySnapshot=()=>({credential,epoch,native:[...nativeOperations].some(operation=>operation.epoch===epoch),deadline,owner});
export const observeSecurity=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
const emit=()=>listeners.forEach(listener=>listener());
export function acceptUnlock(value,userId=owner) {
 epoch++;credential=value.token;privyCredential=unlockIdentities.get(value) || null;owner=userId;deadline=Date.now()+value.expiresIn*1000;emit();
}
export function extendUnlock(seconds){deadline=Date.now()+seconds*1000;emit();}
export function clearUnlock() {
 const old=credential;credential=null;privyCredential=null;owner=null;deadline=0;epoch++;emit();return old;
}
export function revokeUnlock(getToken) {
 // Capture the identity that acquired this unlock before Privy changes users.
 const identityToken=privyCredential,token=clearUnlock();
 if(!token)return Promise.resolve();
 return securityApi('lock',identityToken?()=>identityToken:getToken,{}, {'X-App-Unlock':token});
}
export async function nativeSecurityOperation(operation) {
 const active={epoch};nativeOperations.add(active);emit();
 // Bound the exception even if a browser/device never resolves its native UI.
 const timer=setTimeout(()=>{if(active.epoch===epoch)clearUnlock();},120000);
 try{return await operation();}finally{clearTimeout(timer);nativeOperations.delete(active);emit();}
}
export const securityHeaders=()=>credential?{'X-App-Unlock':credential}:{};
export const requestSecurityLock=()=>window.dispatchEvent(new Event('mp-security-lock'));
export async function securityFetch(path,options={}) {
 if(typeof window!=='undefined' && !credential)throw new Error('app_locked');
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
 const started=epoch;
 const token=await getToken();
 if(started!==epoch && action!=='lock')throw new Error('app_locked');
 const response=await fetch('/security/'+action,{method:body===undefined?'GET':'POST',cache:'no-store',keepalive:action==='lock',
  headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...extra},
  body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();
 if(started!==epoch && action!=='lock')throw new Error('app_locked');
 if(!response.ok){const error=new Error(data.error || 'security_unavailable');error.code=data.error;throw error;}
 if(data.scope==='unlock')unlockIdentities.set(data,token);
 if(action==='renew' && extra['X-App-Unlock']===credential)privyCredential=token;
 return data;
}
