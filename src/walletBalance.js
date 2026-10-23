import {securityFetch as fetch} from './securitySession.js';
import { rpcAccessToken } from './rpcSession.js';
import { SOLANA } from './chain.js';

export function createWalletBalanceClient({request=(...args)=>fetch(...args),getToken=rpcAccessToken,now=Date.now}={}) {
  let cached,pending;
  return async (address,{fresh=false}={})=>{
    if(!address)return null;
    const token=await getToken(),key=`${token}:${address}`;
    if(!fresh && cached?.key===key && cached.until>now())return cached.usdc;
    if(pending?.key===key && (!fresh || pending.fresh))return pending.promise;
    const promise=(async()=>{
      const response=await request(`/balance${fresh?'?refresh=1':''}`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('balance_unavailable');
      const body=await response.json();
      if(body.address!==address || body.network!==SOLANA.cluster || !Number.isFinite(body.usdc) || body.usdc<0)throw new Error('balance_mismatch');
      // A late ordinary response must not overwrite a forced refresh.
      if(pending?.promise===promise)cached={key,usdc:body.usdc,until:now()+10000};
      return body.usdc;
    })();
    pending={key,promise,fresh};
    try {return await promise;}finally{if(pending?.promise===promise)pending=null;}
  };
}
export const getWalletBalance=createWalletBalanceClient();
