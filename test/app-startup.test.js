import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

// Render the real application with Privy in its initial/loading states.
// Effects do not run during SSR, so this never authenticates or contacts an API.
const compiled=await build({
 stdin:{contents:"export {default as App} from './src/App.jsx'; export {setSession} from '@privy-io/react-auth'; export {acceptUnlock,clearUnlock} from './src/securitySession.js';",resolveDir:process.cwd(),loader:'js'},
 bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',packages:'external',
 loader:{'.css':'empty'},
 plugins:[{name:'privy-loading-session',setup(build){
  build.onResolve({filter:/^@privy-io\/react-auth(?:\/solana)?$/},()=>({path:'session',namespace:'privy-mock'}));
  build.onLoad({filter:/.*/,namespace:'privy-mock'},()=>({contents:`
   let state;
   export function setSession(session){state={ready:false,authenticated:false,user:null,login:()=>{},logout:async()=>{},getAccessToken:async()=>null,...session};}
   export function usePrivy(){return state;}
   export function useLinkEmail(){return {sendCode:async()=>{},linkWithCode:async()=>{}};}
   export function useToken(){return {getAccessToken:state.getAccessToken};}
   export function useWallets(){return {ready:state.ready,wallets:[]};}
   export function useSignTransaction(){return {signTransaction:async()=>{throw new Error('Must not sign on startup');}};}
   export function useSignAndSendTransaction(){return {signAndSendTransaction:async()=>{throw new Error('Must not send on startup');}};}
   export function useExportWallet(){return {exportWallet:async()=>{throw new Error('Must not export on startup');}};}
  `,loader:'js'}));
 }}],
});
const loaded={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
const {App,setSession,acceptUnlock,clearUnlock}=loaded.exports;

for(const session of [
 {ready:false,authenticated:false,user:null},
 {ready:true,authenticated:false,user:null},
 {ready:false,authenticated:true,user:null},
 {ready:true,authenticated:true,user:null},
 {ready:true,authenticated:true,user:undefined},
])test(`application renders login while Privy is loading: ${JSON.stringify(session)}`,()=>{
 setSession(session);
 const html=renderToStaticMarkup(createElement(App));
 assert.match(html,/mp-onboard-splash/);
 assert.doesNotMatch(html,/Export treasury wallet|Exportar billetera de tesorería/);
});

test('authenticated startup keeps wallet and private effects behind the security gate',()=>{
 setSession({ready:true,authenticated:true,user:{id:'did:privy:startup',linkedAccounts:[]}});
 // The button is localized; with no saved language the app starts in English.
 const html=renderToStaticMarkup(createElement(App));
 assert.match(html,/Unlock MidatoPay|Desbloquear MidatoPay/);
 assert.doesNotMatch(html,/Sync primary wallet|Sincronizar wallet principal/);
});

test('changing Privy user cannot mount private content with the previous user unlock',()=>{
 acceptUnlock({token:'previous-user-unlock',expiresIn:90},'did:privy:previous');
 setSession({ready:true,authenticated:true,user:{id:'did:privy:new',linkedAccounts:[]}});
 const html=renderToStaticMarkup(createElement(App));
 assert.match(html,/Unlock MidatoPay|Desbloquear MidatoPay/);
 assert.doesNotMatch(html,/Sync primary wallet|Sincronizar wallet principal/);
 clearUnlock();
});
