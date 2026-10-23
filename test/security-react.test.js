import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import React from 'react';
import TestRenderer,{act} from 'react-test-renderer';
import {build} from 'esbuild';

const compiled=await build({stdin:{contents:`export {SecurityPanel} from './src/SecurityPanel.jsx';
 export {default as SecurityGate} from './src/SecurityGate.jsx';export {LanguageProvider} from './src/i18n.jsx';
 export * from './src/securitySession.js';`,resolveDir:process.cwd(),loader:'js'},
 bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',packages:'external',loader:{'.css':'empty'},
 plugins:[{name:'security-fixtures',setup(b){
  b.onResolve({filter:/^@privy-io\/react-auth$/},()=>({path:'privy',namespace:'fixture'}));
  b.onResolve({filter:/^@simplewebauthn\/browser$/},()=>({path:'webauthn',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='privy'?`
   export const usePrivy=()=>globalThis.securityReact.privy;
   export const useToken=callbacks=>{globalThis.securityReact.tokenCallbacks=callbacks;return {};};
   export const useLinkEmail=()=>({sendCode:globalThis.securityReact.sendCode,linkWithCode:globalThis.securityReact.linkWithCode});
  `:`export const browserSupportsWebAuthn=()=>true;
   export const startRegistration=opts=>globalThis.securityReact.authenticator('register',opts);
   export const startAuthentication=opts=>globalThis.securityReact.authenticator('authenticate',opts);`,loader:'js'}));
 }}]});
const mod={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {SecurityPanel,SecurityGate,LanguageProvider,clearUnlock,securitySnapshot}=mod.exports;
const flush=async()=>{await act(async()=>{await new Promise(r=>setImmediate(r));});};
const text=node=>JSON.stringify(node.toJSON());

function browser(t) {
 const original={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch};
 const window=new EventTarget(),document=new EventTarget();let focused=true;
 document.visibilityState='visible';document.hasFocus=()=>focused;document.documentElement={classList:{add(){},toggle(){}}};
 Object.assign(globalThis,{window,document});
 t.after(()=>{if(globalThis.securityReact?.renderer)act(()=>globalThis.securityReact.renderer.unmount());clearUnlock();Object.assign(globalThis,original);delete globalThis.securityReact;});
 return {window,document,blur(){focused=false;window.dispatchEvent(new Event('blur'));},focus(){focused=true;window.dispatchEvent(new Event('focus'));}};
}
for(const enroll of [true,false])test(`React prepares ${enroll?'registration':'authentication'} before every gesture, including cancellation/retry`,async t=>{
 browser(t);let tokenCalls=0,nativeCalls=0,optionsCalls=0,finish;
 const getToken=async()=>{tokenCalls++;return 'fixture-token';};
 globalThis.securityReact={authenticator:()=>{nativeCalls++;return new Promise((resolve,reject)=>{finish={resolve,reject};});},sendCode:async()=>{},linkWithCode:async()=>{}};
 globalThis.fetch=async(path)=>new Response(JSON.stringify(path.endsWith('/status')?
  {enforced:true,pin:!enroll,passkeys:enroll?[]:[{id:'key'}],recoveryReady:true,recoveryAvailable:true}:
  path.endsWith('options')?(optionsCalls++,{options:{challenge:'fixture'},challengeId:'id-'+optionsCalls,expiresIn:300}):
  {scope:'unlock',token:'unlock',expiresIn:90}));
 let renderer,unlocks=0;
 await act(async()=>{renderer=TestRenderer.create(React.createElement(LanguageProvider,null,React.createElement(SecurityPanel,{getToken,onUnlocked:()=>{unlocks++;return false;}})));});
 globalThis.securityReact.renderer=renderer;await flush();
 const button=()=>renderer.root.findAllByType('button').find(b=>b.props.onClick?.name==='passkey');
 assert.equal(button().props.disabled,false);assert.ok(optionsCalls>0);
 for(let i=0;i<3;i++) {
  const before=tokenCalls;
  act(()=>{button().props.onClick();assert.equal(nativeCalls,i+1);assert.equal(tokenCalls,before,'no token/network work before authenticator in click stack');});
  await act(async()=>{if(i<2)finish.reject(new DOMException('cancel','NotAllowedError'));else finish.resolve({id:'key'});});
  await flush();assert.equal(button().props.disabled,false);
 }
 assert.equal(unlocks,1);assert.ok(optionsCalls>=4);
});
test('React gate mounts no private effects until factor and recovery contact are complete; identity changes relock',async t=>{
 const browserState=browser(t);let privateMounts=0,status={enforced:true,pin:true,passkeys:[],recoveryReady:false,recoveryAvailable:true};
 const getToken=async()=> 'fixture-token';
 globalThis.securityReact={privy:{ready:true,authenticated:true,user:{id:'alice'},getAccessToken:getToken,logout:async()=>{}},sendCode:async()=>{},linkWithCode:async()=>{}};
 globalThis.fetch=async(path)=>new Response(JSON.stringify(path.endsWith('/status')?status:
  path.endsWith('/pin/verify')?{scope:'manage',token:'manage',expiresIn:300}:
  path.endsWith('/recovery-email/start')?{challengeId:'email',email:'a***@example.test'}:
  path.endsWith('/recovery-email/verify')?(status={...status,recoveryReady:true},{scope:'unlock',token:'unlock',expiresIn:90}):{}));
 function Private(){React.useEffect(()=>{privateMounts++;},[]);return React.createElement('p',null,'PRIVATE');}
 const element=()=>React.createElement(LanguageProvider,null,React.createElement(SecurityGate,{loginScreen:React.createElement('p',null,'LOGIN')},React.createElement(Private)));
 let renderer;await act(async()=>{renderer=TestRenderer.create(element());});globalThis.securityReact.renderer=renderer;await flush();
 assert.equal(privateMounts,0);
 const click=label=>act(()=>renderer.root.findAllByType('button').find(b=>b.children.join('')===label).props.onClick());
 click('Use PIN');
 act(()=>renderer.root.findByProps({id:'security-pin'}).props.onChange({target:{value:'03927'}}));
 await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));await flush();
 assert.equal(privateMounts,0);assert.match(text(renderer),/Confirm recovery email/);
 await act(async()=>renderer.root.findAllByType('button').find(b=>b.children.join('')==='Confirm recovery email').props.onClick());await flush();
 act(()=>renderer.root.findByProps({autoComplete:'one-time-code'}).props.onChange({target:{value:'123456'}}));
 await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));await flush();
 assert.equal(privateMounts,1);assert.match(text(renderer),/PRIVATE/);
 // A different Privy session for the same DID invalidates native operations too.
 const jwt=sid=>'x.'+Buffer.from(JSON.stringify({sub:'alice',sid})).toString('base64url')+'.x';
 act(()=>globalThis.securityReact.tokenCallbacks.onAccessTokenGranted({accessToken:jwt('s1')}));
 act(()=>globalThis.securityReact.tokenCallbacks.onAccessTokenGranted({accessToken:jwt('s2')}));await flush();
 assert.equal(securitySnapshot().credential,null);assert.doesNotMatch(text(renderer),/PRIVATE/);
 globalThis.securityReact.privy={...globalThis.securityReact.privy,user:{id:'bob'}};
 await act(async()=>renderer.update(element()));await flush();assert.doesNotMatch(text(renderer),/PRIVATE/);
 browserState.blur();browserState.focus();
});
test('React SMS setup links email through Privy before confirming the recovery contact',async t=>{
 browser(t);let linked=false,sent=0;const getToken=async()=> 'fixture';
 globalThis.securityReact={sendCode:async({email})=>{assert.equal(email,'sms@example.test');sent++;},linkWithCode:async({code})=>{assert.equal(code,'123456');linked=true;}};
 globalThis.fetch=async path=>new Response(JSON.stringify(path.endsWith('/status')?{enforced:true,pin:false,passkeys:[],recoveryReady:false,recoveryAvailable:true}:
  linked?{challengeId:'id',email:'s***@example.test'}:{error:'verified_email_required'}),{status:path.endsWith('/start') && !linked?409:200});
 let renderer;await act(async()=>{renderer=TestRenderer.create(React.createElement(LanguageProvider,null,React.createElement(SecurityPanel,{getToken,onUnlocked:()=>{}})));});
 globalThis.securityReact.renderer=renderer;await flush();
 const confirm=async()=>{await act(async()=>renderer.root.findAllByType('button').find(b=>b.children.join('')==='Confirm recovery email').props.onClick());await flush();};
 await confirm();
 act(()=>renderer.root.findByProps({type:'email'}).props.onChange({target:{value:'sms@example.test'}}));
 await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));await flush();assert.equal(sent,1);
 act(()=>renderer.root.findByProps({autoComplete:'one-time-code'}).props.onChange({target:{value:'123456'}}));
 await act(async()=>renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));await flush();assert.equal(linked,true);
 await confirm();assert.match(text(renderer),/s\*\*\*@example.test/);
});
