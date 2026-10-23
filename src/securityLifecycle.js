import {securitySnapshot,observeSecurity,extendUnlock} from './securitySession.js';

// Separate from React so browser lifecycle ordering can be exercised with a
// deterministic event target and clock, without authenticating a real account.
export function startSecurityLifecycle({window,document,revoke,renew,onHidden,now=Date.now,
 every=setInterval,cancel=clearInterval}) {
 const hidden=()=>document.visibilityState!=='visible' || !document.hasFocus();
 const cover=()=>{
  const covered=hidden();onHidden(covered);
  document.documentElement.classList.toggle('mp-security-covered',covered);
  const state=securitySnapshot();
  if(covered && !state.native)revoke();
  else if(state.credential && now()>=state.deadline)revoke();
 };
 const leave=()=>{document.documentElement.classList.add('mp-security-covered');onHidden(true);revoke();};
 const bindings=[[document,'visibilitychange',cover],[window,'blur',cover],[window,'focus',cover],
  [window,'pagehide',leave],[window,'pageshow',cover],[window,'mp-security-lock',revoke]];
 for(const [target,name,listener] of bindings)target.addEventListener(name,listener);
 let nativeWasActive=securitySnapshot().native,pending=false;
 const stopObserve=observeSecurity(()=>{
  const state=securitySnapshot();
  const ended=nativeWasActive && !state.native;nativeWasActive=state.native;
  if(ended && hidden() && state.credential)revoke();
 });
 const timer=every(async()=>{
  const state=securitySnapshot();
  if(!state.credential)return;
  if(now()>=state.deadline){revoke();return;}
  if(hidden() || pending)return;
  const epoch=state.epoch;pending=true;
  try {
   const result=await renew(state.credential);
   if(securitySnapshot().epoch===epoch)extendUnlock(result.expiresIn);
  }catch{if(securitySnapshot().epoch===epoch)revoke();}
  finally{pending=false;}
 },30000);
 return()=>{cancel(timer);stopObserve();for(const [target,name,listener] of bindings)target.removeEventListener(name,listener);};
}
