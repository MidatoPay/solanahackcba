import React,{useCallback,useEffect,useRef,useState} from 'react';
import {useLinkEmail} from '@privy-io/react-auth';
import {startRegistration,startAuthentication,browserSupportsWebAuthn} from '@simplewebauthn/browser';
import {useLanguage} from './i18n.jsx';
import {securityCopy} from './securityCopy.js';
import {nativeSecurityOperation,observeSecurity,securitySnapshot,securityApi} from './securitySession.js';

function PinEntry({title,busy,locked,copy,onSubmit,onBack,error}) {
 const [pin,setPin]=useState('');
 return <form onSubmit={e=>{e.preventDefault();if(!busy && !locked && pin.length===5){onSubmit(pin);setPin('');}}}>
  <h2>{title}</h2><label className="mp-security-sr" htmlFor="security-pin">{copy.digits}</label>
  <input id="security-pin" autoFocus type="password" inputMode="numeric" pattern="[0-9]{5}" maxLength={5}
   autoComplete="off" value={pin} disabled={busy || locked} aria-describedby="security-error"
   onChange={e=>setPin(e.target.value.replace(/\D/g,'').slice(0,5))}/>
  <div className="mp-security-dots" aria-hidden="true">{Array.from({length:5},(_,i)=><span key={i}>{i<pin.length?'●':'○'}</span>)}</div>
  <div className="mp-security-keypad">{['1','2','3','4','5','6','7','8','9',copy.erase,'0'].map(key=><button type="button" key={key} disabled={busy || locked}
   onClick={()=>setPin(value=>key===copy.erase?value.slice(0,-1):(value+key).slice(0,5))}>{key}</button>)}</div>
  <p id="security-error" role="alert">{error}</p><button disabled={busy || locked || pin.length!==5}>{busy?copy.loading:copy.continue}</button>
  <button type="button" className="secondary" disabled={busy} onClick={onBack}>{copy.back}</button>
 </form>;
}

export function SecurityPanel({getToken,onUnlocked,onClose,manage=false}) {
 const {lang}=useLanguage(),c=securityCopy[lang] || securityCopy.en;
 const {sendCode,linkWithCode}=useLinkEmail();
 const [status,setStatus]=useState(null),[view,setView]=useState('choose'),[first,setFirst]=useState(''),[grant,setGrant]=useState(null);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[challenge,setChallenge]=useState(null),[code,setCode]=useState('');
 const [email,setEmail]=useState(''),[retryAt,setRetryAt]=useState(0),[seconds,setSeconds]=useState(0);
 const [preparation,setPreparation]=useState('preparing'),[attempt,setAttempt]=useState(0);
 const prepared=useRef(null),mounted=useRef(false),running=useRef(false);
 const complete=useRef(onUnlocked);complete.current=onUnlocked;
 const supported=typeof window!=='undefined' && browserSupportsWebAuthn();
 const initial=status && !status.pin && !status.passkeys.length;
 const contactPending=status && !status.recoveryReady;
 const canEnroll=(initial || Boolean(grant)) && !contactPending;
 const canContact=initial || grant?.scope==='manage';
 const headers=grant?{'X-Security-Grant':grant.token}:{};
 const load=useCallback(async()=>{
  const result=await securityApi('status',getToken);
  if(mounted.current){setStatus(result);setError('');if(!manage && result.enforced===false)complete.current({scope:'bypass'});}
  return result;
 },[getToken,manage]);
 useEffect(()=>{mounted.current=true;load().catch(()=>{if(mounted.current)setError(c.error);});return()=>{mounted.current=false;prepared.current=null;};},[load,c.error]);
 useEffect(()=>{
  if(status?.enforced!==false || manage)return;
  const focus=()=>load().catch(()=>{});window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);
 },[status?.enforced,manage,load]);
 useEffect(()=>{
  const tick=()=>setSeconds(Math.max(0,Math.ceil((retryAt-Date.now())/1000)));
  tick();if(!retryAt)return;const id=setInterval(tick,1000);return()=>clearInterval(id);
 },[retryAt]);
 useEffect(()=>{
  const remaining=new Date(status?.blockedUntil || 0).getTime()-Date.now();if(remaining<=0)return;
  const timer=setTimeout(()=>setStatus(value=>({...value,blockedUntil:null})),remaining+50);return()=>clearTimeout(timer);
 },[status?.blockedUntil]);
 // Preparation happens on panel entry, outside the gesture handler. Everything
 // lives in this component's memory and is scoped to this epoch and Privy token.
 useEffect(()=>{
  let cancelled=false,timer;prepared.current=null;
  if(!supported){setPreparation('unsupported');return;}
  if(!status || view!=='choose' || busy || (contactPending && canContact) || (!canEnroll && !status.passkeys.length))return;
  const epoch=securitySnapshot().epoch;
  const stop=observeSecurity(()=>{if(securitySnapshot().epoch!==epoch){cancelled=true;prepared.current=null;setPreparation('expired');}});
  const invalidate=()=>{
   if(document.visibilityState==='visible' && document.hasFocus())return;
   cancelled=true;prepared.current=null;clearTimeout(timer);setPreparation('expired');
  };
  window.addEventListener('blur',invalidate);document.addEventListener('visibilitychange',invalidate);
  setPreparation('preparing');
  (async()=>{
   const token=await getToken();
   const result=await securityApi(canEnroll?'passkey/register-options':'passkey/options',()=>token,{purpose:manage || contactPending?'manage':'unlock'},headers);
   if(cancelled || !mounted.current || epoch!==securitySnapshot().epoch)return;
   prepared.current={...result,token,epoch,enroll:canEnroll,expiresAt:Date.now()+Math.min(result.expiresIn || 300,240)*1000};
   setPreparation('ready');timer=setTimeout(()=>{prepared.current=null;setPreparation('expired');},Math.min(result.expiresIn || 300,240)*1000);
  })().catch(e=>{if(!cancelled && mounted.current){setPreparation('failed');if(e.retryAfter)setRetryAt(Date.now()+e.retryAfter*1000);}});
  return()=>{cancelled=true;clearTimeout(timer);stop();prepared.current=null;window.removeEventListener('blur',invalidate);document.removeEventListener('visibilitychange',invalidate);};
 },[getToken,status,view,busy,grant,canEnroll,contactPending,canContact,manage,supported,attempt]);
 const act=async operation=>{
  if(running.current || seconds)return;
  running.current=true;setBusy(true);setError('');const epoch=securitySnapshot().epoch;
  try {
   const result=await operation();
   if(!mounted.current || securitySnapshot().epoch!==epoch)return;
   if(result?.scope==='manage' || result?.scope==='recover'){setGrant(result);setView('choose');}
   else if(result?.scope==='unlock'){
    if(onUnlocked(result)!==false)onClose?.();else{setView('choose');await load();}
   }else if(result?.recoveryReady){setGrant(null);setView('choose');await load();}
  }catch(e){if(mounted.current && securitySnapshot().epoch===epoch){
   if(e.retryAfter)setRetryAt(Date.now()+e.retryAfter*1000);
   if(e.code==='verified_email_required')setView('link-email');
   if(e.code==='factor_verification_required'){setGrant(null);setView('choose');}
   setError(c[e.code] || (e.name==='NotAllowedError' || e.code==='ERROR_CEREMONY_ABORTED'?c.cancelled:c.error));
   if(view==='confirm'){setFirst('');setView(initial?'create':'choose');}
  }}finally{running.current=false;if(mounted.current)setBusy(false);}
 };
 const api=(action,body)=>securityApi(action,getToken,body,headers);
 const passkey=()=>{
  const item=prepared.current;
  if(!item || item.epoch!==securitySnapshot().epoch || item.expiresAt<=Date.now()){prepared.current=null;setPreparation('expired');return;}
  prepared.current=null;
  return act(()=>{
   // Must remain synchronous up to startRegistration/startAuthentication for iOS 16–17.3.
   const pending=nativeSecurityOperation(()=>item.enroll?startRegistration({optionsJSON:item.options}):startAuthentication({optionsJSON:item.options}));
   return pending.then(response=>{
    if(!mounted.current || item.epoch!==securitySnapshot().epoch)throw Object.assign(new Error('app_locked'),{code:'app_locked'});
    return securityApi(item.enroll?'passkey/register':'passkey/verify',()=>item.token,{challengeId:item.challengeId,response},headers);
   });
  });
 };
 const startCode=purpose=>act(async()=>{
  const result=await api(purpose+'/start',{});
  if(mounted.current){setChallenge({...result,purpose});setCode('');setView('otp');}
 });
 const pinSubmit=pin=>{
  if(view==='create'){setFirst(pin);setError('');setView('confirm');return;}
  if(view==='confirm'){
   if(pin!==first){setFirst('');setView('create');setError(c.mismatch);return;}
   act(()=>api('pin/enroll',{pin}));setFirst('');return;
  }
  act(()=>api('pin/verify',{pin,purpose:manage || contactPending?'manage':'unlock'}));
 };
 const disabled=busy || seconds>0;
 return <div className="mp-security"><section aria-label={c.title}>
  <img src="/logo/logo.png" alt="MidatoPay" width="170"/><h1>{manage?c.title:contactPending?c.completeSetup:grant?.scope==='recover'?c.resetMethod:initial?c.setup:c.locked}</h1>
  {!status?<><p role="status">{error || c.loading}</p><button onClick={()=>load().catch(()=>setError(c.error))}>{c.retry}</button></>:
   ['create','confirm','pin'].includes(view)?<PinEntry key={view} copy={c} busy={disabled}
    locked={view==='pin' && status.blockedUntil && new Date(status.blockedUntil)>new Date()}
    error={error} title={view==='create'?c.create:view==='confirm'?c.confirm:c.verify} onSubmit={pinSubmit}
    onBack={()=>{setFirst('');setView('choose');setError('');}}/>:
   view==='link-email'?<form onSubmit={e=>{e.preventDefault();act(async()=>{await nativeSecurityOperation(()=>sendCode({email}));if(mounted.current)setView('link-code');});}}>
    <p>{c.linkInfo}</p><label>{c.email}<input required type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>
    <button disabled={disabled}>{c.continue}</button><button type="button" onClick={()=>setView('choose')}>{c.back}</button>
   </form>:view==='link-code'?<form onSubmit={e=>{e.preventDefault();act(async()=>{await nativeSecurityOperation(()=>linkWithCode({code}));if(mounted.current){setCode('');setView('choose');}});}}>
    <p>{c.linkCode}</p><label>{c.recoveryCode}<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value)}/></label>
    <button disabled={disabled || !code}>{c.continue}</button><button type="button" onClick={()=>{setCode('');setView('choose');}}>{c.back}</button>
   </form>:view==='otp'?<form onSubmit={e=>{e.preventDefault();act(()=>api(challenge.purpose+'/verify',{challengeId:challenge.challengeId,code}));setCode('');}}>
    <p>{c.sent} {challenge.email}</p><label>{c.recoveryCode}<input maxLength={6} pattern="[0-9]{6}" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} autoComplete="one-time-code" inputMode="numeric"/></label>
    <button disabled={disabled || code.length!==6}>{c.continue}</button><button type="button" disabled={disabled} onClick={()=>startCode(challenge.purpose)}>{c.resend}</button>
    <button type="button" disabled={busy} onClick={()=>{setCode('');setView('choose');}}>{c.back}</button>
   </form>:<>
    {contactPending && <p>{canContact?c.confirmContactInfo:c.contactRequired}</p>}
    {contactPending && canContact?<button disabled={disabled || !status.recoveryAvailable} onClick={()=>startCode('recovery-email')}>{c.confirmEmail}</button>:<>
     <p>{canEnroll?c.choose:manage?c.manageInfo:c.verify}</p>
     {(canEnroll || status.passkeys.length>0) && <>
      <button disabled={disabled || preparation!=='ready'} onClick={passkey}>{canEnroll && manage?c.addDevice:c.device}</button>
      <p role="status">{preparation==='ready'?c.deviceInfo:c[preparation]}</p>
      {['failed','expired'].includes(preparation) && <button disabled={disabled} onClick={()=>setAttempt(n=>n+1)}>{c.retry}</button>}
     </>}
     {(canEnroll || status.pin) && <button disabled={disabled || (!canEnroll && status.blockedUntil && new Date(status.blockedUntil)>new Date())}
      onClick={()=>{setError('');setView(canEnroll?'create':'pin');}}>{canEnroll?c.addPin:c.pin}</button>}
    </>}
    {!status.recoveryAvailable && <p role="status">{c.unavailable}</p>}
    {status.recoveryEmail && <p>{c.email}: {status.recoveryEmail}</p>}
    {manage && grant?.scope==='manage' && <>
     <button disabled={disabled || !status.recoveryAvailable} onClick={()=>startCode('recovery-email')}>{c.updateEmail}</button>
     {[...(status.pin?[{id:'pin'}]:[]),...status.passkeys].map((factor,i)=><button className="secondary" key={factor.id} disabled={disabled || Number(status.pin)+status.passkeys.length<=1}
      onClick={()=>act(()=>api('methods/remove',{id:factor.id}))}>{c.remove} {factor.id==='pin'?'PIN':`Passkey ${i+1}`}</button>)}
    </>}
    {!initial && !grant && <button className="secondary" disabled={disabled || !status.recoveryReady || !status.recoveryAvailable} onClick={()=>startCode('recovery')}>{c.recover}</button>}
   </>}
  {!['pin','create','confirm'].includes(view) && <p id="security-error" role="alert">{error}</p>}
  {seconds>0 && <p role="status">{c.wait} {seconds} s</p>}
  {onClose && view==='choose' && <button className="secondary" disabled={busy} onClick={onClose}>{c.back}</button>}
 </section></div>;
}
