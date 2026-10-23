import test from 'node:test';
import assert from 'node:assert/strict';
import { setRpcSession } from '../src/rpcSession.js';
import {acceptUnlock,clearUnlock} from '../src/securitySession.js';

test('the real Solana Kit transport attaches renewed session tokens and preserves numeric RPC results',async t=>{
  const previousWindow=globalThis.window,previousFetch=globalThis.fetch;
  t.after(()=>{globalThis.window=previousWindow;globalThis.fetch=previousFetch;setRpcSession(null);clearUnlock();});
  globalThis.window={location:{origin:'http://localhost:5173'}};
  let token='first';setRpcSession('user',async()=>token);
  acceptUnlock({token:'first-unlock',expiresIn:90},'user');
  const requests=[];
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    requests.push({url:String(url),authorization:new Headers(options.headers).get('authorization'),unlock:new Headers(options.headers).get('x-app-unlock'),method:body.method});
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{context:{slot:1},value:123}}),{headers:{'Content-Type':'application/json'}});
  };
  const {createAppRpc}=await import('../src/chain.js?browser-transport-test');
  const rpc=createAppRpc();
  assert.equal((await rpc.getBalance('11111111111111111111111111111111').send()).value,123n);
  token='renewed';
  acceptUnlock({token:'renewed-unlock',expiresIn:90},'user');
  assert.equal((await rpc.getBalance('11111111111111111111111111111111').send()).value,123n);
  assert.deepEqual(requests,[
    {url:'http://localhost:5173/rpc',authorization:'Bearer first',unlock:'first-unlock',method:'getBalance'},
    {url:'http://localhost:5173/rpc',authorization:'Bearer renewed',unlock:'renewed-unlock',method:'getBalance'},
  ]);
  clearUnlock();
  await assert.rejects(()=>rpc.getHealth().send(),/app_locked/);
  acceptUnlock({token:'new-unlock',expiresIn:90},'user');
  setRpcSession(null);
  await assert.rejects(()=>rpc.getHealth().send(),/session_required/);
  assert.equal(requests.length,2);
});
