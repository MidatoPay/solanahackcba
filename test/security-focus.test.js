import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptUnlock,clearUnlock,nativeSecurityOperation,securitySnapshot} from '../src/securitySession.js';
import {startSecurityLifecycle} from '../src/securityLifecycle.js';

function fixture(t) {
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const window=new EventTarget(),document=new EventTarget(),classes=new Set();let focused=true,covered=false;
 document.visibilityState='visible';document.hasFocus=()=>focused;
 document.documentElement={classList:{add:c=>classes.add(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)}};
 const stop=startSecurityLifecycle({window,document,revoke:clearUnlock,renew:async()=>({expiresIn:90}),onHidden:v=>{covered=v;},every:()=>1,cancel:()=>{}});
 t.after(()=>{stop();clearUnlock();});
 acceptUnlock({token:'fixture-unlock',expiresIn:90},'alice');
 let resolve,reject,invocations=0;
 const run=()=>nativeSecurityOperation(()=>{invocations++;return new Promise((a,b)=>{resolve=a;reject=b;});},{window,document});
 return {window,document,run,resolve:v=>resolve(v),reject:e=>reject(e),covered:()=>covered,invocations:()=>invocations,
  blur(){focused=false;window.dispatchEvent(new Event('blur'));},focus(){focused=true;window.dispatchEvent(new Event('focus'));}};
}
for(const order of ['focus-first','result-first'])test(`native dialog ${order}: preserves unlock and covers until focus`,async t=>{
 const f=fixture(t),before=securitySnapshot(),pending=f.run();assert.equal(f.invocations(),1);
 f.blur();assert.equal(f.covered(),true);
 if(order==='focus-first')f.focus();
 f.resolve('signed-once');await Promise.resolve();
 if(order==='result-first'){
  assert.equal(securitySnapshot().nativeState,'waiting_focus');assert.equal(f.covered(),true);
  t.mock.timers.tick(1900);f.focus();
 }
 assert.equal(await pending,'signed-once');assert.equal(securitySnapshot().epoch,before.epoch);
 assert.equal(securitySnapshot().deadline,before.deadline);assert.equal(f.covered(),false);assert.equal(f.invocations(),1);
});
for(const cause of ['timeout','hidden','pagehide','identity','expiry','native-timeout'])test(`native result cancelled on ${cause}`,async t=>{
 const f=fixture(t),pending=f.run();const rejection=assert.rejects(pending,/app_locked/);
 if(cause==='identity'){clearUnlock();acceptUnlock({token:'bob',expiresIn:90},'bob');}
 else if(cause==='pagehide')f.window.dispatchEvent(new Event('pagehide'));
 else if(cause==='native-timeout')t.mock.timers.tick(120000);
 else if(cause==='hidden')f.document.visibilityState='hidden';
 else if(cause==='expiry')t.mock.timers.tick(90001);
 else f.blur();
 f.resolve('late-signature');await Promise.resolve();
 if(cause==='timeout')t.mock.timers.tick(2000);
 await rejection;assert.equal(f.invocations(),1);assert.equal(securitySnapshot().native,false);
 assert.equal(securitySnapshot().credential,cause==='identity'?'bob':null);
});
test('cancelled authenticator waits for returning focus without repeating the operation',async t=>{
 const f=fixture(t),pending=f.run();const rejection=assert.rejects(pending,{name:'NotAllowedError'});
 f.blur();f.reject(new DOMException('cancelled','NotAllowedError'));await Promise.resolve();
 assert.equal(securitySnapshot().nativeState,'waiting_focus');assert.equal(f.covered(),true);
 f.focus();await rejection;assert.equal(securitySnapshot().credential,'fixture-unlock');assert.equal(f.invocations(),1);
});
test('camera tracks acquired after cancellation or during focus timeout are released',async t=>{
 const f=fixture(t);let finish,stops=0;
 const stream={getTracks:()=>[{stop(){stops++;}}]};
 const pending=nativeSecurityOperation(()=>new Promise(r=>{finish=r;}),{window:f.window,document:f.document,onDiscard:s=>s.getTracks().forEach(track=>track.stop())});
 const rejected=assert.rejects(pending,/app_locked/);clearUnlock();finish(stream);await rejected;await Promise.resolve();assert.equal(stops,1);
 acceptUnlock({token:'again',expiresIn:90},'alice');
 const waiting=nativeSecurityOperation(()=>Promise.resolve(stream),{window:f.window,document:f.document,onDiscard:s=>s.getTracks().forEach(track=>track.stop())});
 const timedout=assert.rejects(waiting,/app_locked/);f.blur();await Promise.resolve();t.mock.timers.tick(2000);await timedout;assert.equal(stops,2);
});
