import {securityFetch as fetch} from './securitySession.js';
import { useCallback, useEffect, useRef, useState } from 'react';

async function profileRequest(getAccessToken, options = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('unauthorized');
  const response = await fetch('/merchant-profile', {...options,headers:{
    'Content-Type':'application/json',Authorization:`Bearer ${token}`}});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'profile_unavailable');
  return body.profile;
}

export function useMerchantProfile(userId, getAccessToken) {
  const [record,setRecord] = useState(null), [error,setError] = useState('');
  const [revision,setRevision] = useState(0);
  const currentId = useRef(userId); currentId.current = userId;
  useEffect(() => {
    let canceled = false;
    setRecord(null);setError('');
    if (userId) profileRequest(getAccessToken).then(profile => {
      if (!canceled) setRecord({userId,profile});
    }).catch(() => {if (!canceled) setError('profile_unavailable');});
    return () => {canceled=true;};
  },[userId,getAccessToken,revision]);
  const save = useCallback(async businessName => {
    const profile = await profileRequest(getAccessToken,{method:'PATCH',body:JSON.stringify({businessName})});
    if (currentId.current === userId) {setRecord({userId,profile});setError('');}
    return profile;
  },[userId,getAccessToken]);
  return {profile:userId && record && record.userId === userId ? record.profile : null,error,
    save,retry:() => setRevision(value => value+1)};
}
