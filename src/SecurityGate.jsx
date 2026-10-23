import React,{useCallback,useEffect,useRef,useState} from 'react';
import {usePrivy} from '@privy-io/react-auth';
import {startRegistration,startAuthentication,browserSupportsWebAuthn} from '@simplewebauthn/browser';
import {useLanguage} from './i18n.jsx';
import {securityCopy} from './securityCopy.js';
import {acceptUnlock,revokeUnlock,nativeSecurityOperation,observeSecurity,securitySnapshot,securityApi} from './securitySession.js';
import {startSecurityLifecycle} from './securityLifecycle.js';
import './security.css';

function PinEntry({title,busy,locked,copy,onSubmit,onBack,error}) {
 const [pin,setPin]=useState('');
 return <form onSubmit={e=>{e.preventDefault();if(pin.length===5){onSubmit(pin);setPin('');}}}>
  <h2>{title}</h2>
  <label className="mp-security-sr" htmlFor="security-pin">{copy.digits}</label>
  <input id="security-pin" autoFocus type="password" inputMode="numeric" pattern="[0-9]{5}" maxLength={5}
   autoComplete="off" value={pin} disabled={busy || locked} aria-describedby="security-error"
   onChange={e=>setPin(e.target.value.replace(/\D/g,'').slice(0,5))} />
  <div className="mp-security-dots" aria-hidden="true">{Array.from({length:5},(_,i)=><span key={i}>{i<pin.length?'●':'○'}</span>)}</div>
  <div className="mp-security-keypad">{['1','2','3','4','5','6','7','8','9',copy.erase,'0'].map(key=><button type="button" key={key} disabled={busy || locked}
   onClick={()=>setPin(value=>key===copy.erase?value.slice(0,-1):(value+key).slice(0,5))}>{key}</button>)}</div>
  <p id="security-error" role="alert">{error}</p>
  <button disabled={busy || locked || pin.length!==5}>{busy?copy.loading:copy.continue}</button>
  <button type="button" className="secondary" disabled={busy} onClick={onBack}>{copy.back}</button>
 </form>;
}

export function SecurityPanel({getToken,onUnlocked,onClose,manage=false}) {
 const {lang}=useLanguage(),c=securityCopy[lang] || securityCopy.en;
 const [status,setStatus]=useState(null),[view,setView]=useState('choose'),[first,setFirst]=useState(''),[grant,setGrant]=useState(null);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[recoveryId,setRecoveryId]=useState(null),[code,setCode]=useState('');
 const mounted=useRef(true);
 useEffect(()=>()=>{mounted.current=false;},[]);
 const api=(action,body)=>securityApi(action,getToken,body,grant?{'X-Security-Grant':grant}:{});
 const load=useCallback(async()=>{
  try {const result=await securityApi('status',getToken);if(mounted.current)setStatus(result);}
  catch {if(mounted.current)setError(c.error);}
 },[getToken,c.error]);
 useEffect(()=>{mounted.current=true;load();},[load]);
 useEffect(()=>{
  const remaining=new Date(status?.blockedUntil || 0).getTime()-Date.now();
  if(remaining<=0)return;
  const timer=setTimeout(()=>setStatus(value=>({...value,blockedUntil:null})),remaining+50);
  return()=>clearTimeout(timer);
 },[status?.blockedUntil]);
 const initial=status && !status.pin && !status.passkeys.length;
 const canEnroll=initial || Boolean(grant);
 const act=async operation=>{
  if(busy)return;setBusy(true);setError('');const epoch=securitySnapshot().epoch;
  try {
   const result=await operation();
   if(!mounted.current || securitySnapshot().epoch!==epoch) return;
   if(result?.scope==='manage'){setGrant(result.token);setView('choose');}
   else if(result?.scope==='recover'){setGrant(result.token);setView('choose');}
   else if(result?.scope==='unlock'){
    if(onUnlocked(result)===false){setView('choose');await load();}
    else onClose?.();
   }
  }catch(e){if(mounted.current){
   setGrant(null);setError(c[e.code] || (e.code==='recovery_unavailable'?c.unavailable:c.error));
   if(view==='confirm'){setFirst('');setView(initial?'create':'choose');}
   load();
  }}
  finally{if(mounted.current)setBusy(false);}
 };
 const passkey=()=>act(async()=>{
  const epoch=securitySnapshot().epoch;
  const current=()=>{if(epoch!==securitySnapshot().epoch || !mounted.current)throw new Error('app_locked');};
  if(canEnroll) {
   const {options,challengeId}=await api('passkey/register-options',{});
   const response=await nativeSecurityOperation(()=>startRegistration({optionsJSON:options}));
   current();
   return api('passkey/register',{challengeId,response});
  }
  const {options,challengeId}=await api('passkey/options',{purpose:manage?'manage':'unlock'});
  const response=await nativeSecurityOperation(()=>startAuthentication({optionsJSON:options}));
  current();
  return api('passkey/verify',{challengeId,response});
 });
 const pinSubmit=pin=>{
  if(view==='create'){setError('');setFirst(pin);setView('confirm');return;}
  if(view==='confirm') {
   if(pin!==first){setFirst('');setView('create');setError(c.mismatch);return;}
   act(()=>api('pin/enroll',{pin}));setFirst('');return;
  }
  act(()=>api('pin/verify',{pin,purpose:manage?'manage':'unlock'}));
 };
 const supported=typeof window!=='undefined' && browserSupportsWebAuthn();
 return <div className="mp-security"><section aria-label={c.title}>
  <img src="/logo/logo.png" alt="MidatoPay" width="170" />
  <h1>{manage?c.title:initial?c.setup:c.locked}</h1>
  {!status?<><p role="status">{busy?c.loading:error || c.loading}</p><button onClick={load}>{c.retry}</button></>:
   ['create','confirm','pin'].includes(view)?<PinEntry key={view} copy={c} busy={busy}
    locked={view==='pin' && status.blockedUntil && new Date(status.blockedUntil)>new Date()}
    error={view==='pin' && status.blockedUntil && new Date(status.blockedUntil)>new Date()?c.pin_blocked:error}
    title={view==='create'?c.create:view==='confirm'?c.confirm:c.verify} onSubmit={pinSubmit}
    onBack={()=>{setFirst('');setView('choose');setError('');}} />:
   view==='recovery'?<form onSubmit={e=>{e.preventDefault();act(()=>api('recovery/verify',{challengeId:recoveryId,code}));setCode('');}}>
    <p>{c.sent}</p><label>{c.recoveryCode}<input value={code} onChange={e=>setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" /></label>
    <button disabled={busy || !code}>{c.continue}</button><button type="button" onClick={()=>setView('choose')}>{c.back}</button>
   </form>:<>
    <p>{canEnroll?c.choose:manage?c.manageInfo:c.verify}</p>
    {supported && (canEnroll || status.passkeys.length>0) && <><button disabled={busy} onClick={passkey}>{canEnroll && manage?c.addDevice:c.device}</button><p className="hint">{c.deviceInfo}</p></>}
    {(canEnroll || status.pin) && <button disabled={busy || (!canEnroll && status.blockedUntil && new Date(status.blockedUntil)>new Date())}
     onClick={()=>{setError('');setView(canEnroll?'create':'pin');}}>{canEnroll?c.addPin:c.pin}</button>}
    {manage && grant && [...(status.pin?[{id:'pin'}]:[]),...status.passkeys].map((factor,i)=><button className="secondary" key={factor.id} disabled={busy || Number(status.pin)+status.passkeys.length<=1}
     onClick={()=>act(()=>api('methods/remove',{id:factor.id}))}>{c.remove} {factor.id==='pin'?'PIN':`Passkey ${i+1}`}</button>)}
    {!initial && <button className="secondary" disabled={busy} onClick={()=>act(async()=>{
     if(!status.recoveryAvailable){setError(c.unavailable);return;}
     const result=await api('recovery/start',{});setRecoveryId(result.challengeId);setView('recovery');
    })}>{c.recover}</button>}
   </>}
  {!['pin','create','confirm'].includes(view) && <p id="security-error" role="alert">{error}</p>}
  {onClose && view==='choose' && <button className="secondary" onClick={onClose}>{c.back}</button>}
 </section></div>;
}

export default function SecurityGate({children,loginScreen}) {
 const {ready,authenticated,user,getAccessToken,logout}=usePrivy();
 const {lang}=useLanguage(),c=securityCopy[lang] || securityCopy.en;
 const [snapshot,setSnapshot]=useState(securitySnapshot),[hidden,setHidden]=useState(false);
 const identity=ready && authenticated && user?.id;
 const owner=useRef(identity),tokenGetter=useRef(getAccessToken);tokenGetter.current=getAccessToken;
 const revoke=useCallback(()=>{
  revokeUnlock(()=>tokenGetter.current()).catch(()=>{});
 },[]);
 useEffect(()=>observeSecurity(()=>setSnapshot(securitySnapshot())),[]);
 useEffect(()=>{owner.current=identity;revoke();return()=>{revoke();};},[identity,revoke]);
 useEffect(()=>startSecurityLifecycle({window,document,revoke,onHidden:setHidden,
  renew:token=>securityApi('renew',()=>tokenGetter.current(),{}, {'X-App-Unlock':token})}),[revoke]);
 const unlock=result=>{
  if(owner.current!==identity || document.visibilityState!=='visible' || !document.hasFocus())return false;
  acceptUnlock(result,identity);return true;
 };
 if(!identity)return loginScreen;
 if(!snapshot.credential || snapshot.owner!==identity || owner.current!==identity)return <><SecurityPanel key={identity+':'+snapshot.epoch} getToken={getAccessToken} onUnlocked={unlock}/>
  <button className="mp-security-logout" onClick={()=>{revoke();logout();}}>{c.logout}</button></>;
 return <><div className="mp-security-private" aria-hidden={hidden || undefined}>{children}</div>
  {hidden && <div className="mp-security-cover" role="status">{c.locked}</div>}</>;
}
