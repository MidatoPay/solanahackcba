import React,{useCallback,useEffect,useRef,useState} from 'react';
import {usePrivy,useToken} from '@privy-io/react-auth';
import {useLanguage} from './i18n.jsx';
import {securityCopy} from './securityCopy.js';
import {acceptUnlock,revokeUnlock,observeSecurity,securitySnapshot,securityApi,bindPrivySession} from './securitySession.js';
import {startSecurityLifecycle} from './securityLifecycle.js';
import './security.css';

import {SecurityPanel} from './SecurityPanel.jsx';
export {SecurityPanel};

export default function SecurityGate({children,loginScreen}) {
 const {ready,authenticated,user,getAccessToken,logout}=usePrivy();
 const {lang}=useLanguage(),c=securityCopy[lang] || securityCopy.en;
 const [snapshot,setSnapshot]=useState(securitySnapshot),[hidden,setHidden]=useState(false);
 const identity=ready && authenticated && user?.id;
 const owner=useRef(identity),tokenGetter=useRef(getAccessToken);tokenGetter.current=getAccessToken;
 const revoke=useCallback(()=>{
  revokeUnlock(()=>tokenGetter.current()).catch(()=>{});
 },[]);
 useToken({onAccessTokenGranted:({accessToken})=>bindPrivySession(accessToken),onAccessTokenRemoved:revoke});
 useEffect(()=>observeSecurity(()=>setSnapshot(securitySnapshot())),[]);
 useEffect(()=>{owner.current=identity;revoke();return()=>{revoke();};},[identity,revoke]);
 useEffect(()=>startSecurityLifecycle({window,document,revoke,onHidden:setHidden,
  renew:token=>securityApi('renew',()=>tokenGetter.current(),{}, {'X-App-Unlock':token})}),[revoke]);
 useEffect(()=>{
  const report=event=>securityApi('telemetry/dialog',()=>tokenGetter.current(),{reason:event.detail}).catch(()=>{});
  window.addEventListener('mp-security-dialog-error',report);return()=>window.removeEventListener('mp-security-dialog-error',report);
 },[]);
 const unlock=result=>{
  if(owner.current!==identity || document.visibilityState!=='visible' || !document.hasFocus())return false;
  acceptUnlock(result,identity);return true;
 };
 if(!identity)return loginScreen;
 if((!snapshot.credential && !snapshot.bypass) || snapshot.owner!==identity || owner.current!==identity)return <><SecurityPanel key={identity+':'+snapshot.epoch} getToken={getAccessToken} onUnlocked={unlock}/>
  <button className="mp-security-logout" onClick={()=>{revoke();logout();}}>{c.logout}</button></>;
 return <><div className="mp-security-private" aria-hidden={hidden || undefined}>{children}</div>
  {hidden && <div className="mp-security-cover" role="status">{c.locked}</div>}</>;
}
