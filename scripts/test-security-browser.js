// Offline E2E: fresh Chrome profile, real React + PostgreSQL handler, fake Privy
// and mail sink. Never loads .env, signs transactions or calls a remote provider.
import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';

const server=spawn(process.execPath,['scripts/security-browser-fixture.js'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let browser;
try {
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Fixture startup timeout')),30000);
  server.once('exit',code=>{clearTimeout(timeout);reject(new Error('Fixture exited: '+code));});
  server.stdout.on('data',data=>{if(String(data).includes('Fixture local:')){clearTimeout(timeout);resolve();}});
  server.stderr.on('data',data=>{if(String(data).includes('EADDRINUSE')){clearTimeout(timeout);reject(new Error('Close the existing fixture on port 5187 first'));}});
 });
 browser=await chromium.launch({channel:process.env.SECURITY_TEST_BROWSER || 'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='localhost'?route.continue():route.abort());
 await page.goto('http://localhost:5187');
 const button=name=>page.getByRole('button',{name,exact:true});
 await button('Confirmar email de recuperación').click();
 await page.getByLabel('Código de recuperación',{exact:true}).waitFor();
 await button('Inspeccionar servidor').click();
 await page.getByLabel('Estado del servidor de prueba').filter({hasText:'mailbox'}).waitFor();
 const state=JSON.parse(await page.getByLabel('Estado del servidor de prueba').textContent());
 assert.equal(state.privateReads,0);assert.equal(state.liveUnlocks,0);
 await page.getByLabel('Código de recuperación',{exact:true}).fill(state.mailbox.at(-1).code);
 await button('Continuar').click();await button('Agregar o cambiar PIN').click();
 await page.getByLabel('PIN: cinco dígitos ocultos').fill('03927');await button('Continuar').click();
 await page.getByLabel('PIN: cinco dígitos ocultos').fill('03927');await button('Continuar').click();
 await page.getByText('API privada autorizada',{exact:true}).waitFor();
 for(let i=0;i<10;i++) {
  await button('Bloquear ahora').click();await button('Usar PIN').click();
  await page.getByLabel('PIN: cinco dígitos ocultos').fill('03927');await button('Continuar').click();
  await page.getByText('API privada autorizada',{exact:true}).waitFor();
 }
 const denied=await page.request.get('http://localhost:5187/fixture/private',{headers:{Authorization:'Bearer fixture-alice'}});
 assert.equal(denied.status(),423);
 await button('Bloquear ahora').click();
 await page.request.post('http://localhost:5187/fixture/expire-recovery-window');
 await button('Recuperar acceso').click();await page.getByLabel('Código de recuperación',{exact:true}).waitFor();
 const recoveredMail=await (await page.request.post('http://localhost:5187/fixture/state')).json();
 await page.getByLabel('Código de recuperación',{exact:true}).fill(recoveredMail.mailbox.at(-1).code);await button('Continuar').click();
 await button('Agregar o cambiar PIN').click();
 await page.getByLabel('PIN: cinco dígitos ocultos').fill('84726');await button('Continuar').click();
 await page.getByLabel('PIN: cinco dígitos ocultos').fill('84726');await button('Continuar').click();
 await page.getByText('API privada autorizada',{exact:true}).waitFor();
 await button('Perfil → Seguridad').click();await button('Usar PIN').click();
 await page.getByLabel('PIN: cinco dígitos ocultos').fill('84726');await button('Continuar').click();
 for(let i=0;i<2;i++) {
  await button('Agregar passkey').click();
  await page.getByText('Se canceló el diálogo. Podés reintentar o usar PIN.',{exact:true}).waitFor();
 }
 await button('Volver').click();await page.getByText('API privada autorizada',{exact:true}).waitFor();
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
 await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
 await button('Usar PIN').waitFor();assert.equal(await page.getByText('Contenido privado de prueba',{exact:true}).count(),0);
 await button('Identidad Bob').click();await button('Confirmar email de recuperación').waitFor();
 assert.equal(await page.getByText('Contenido privado de prueba',{exact:true}).count(),0);
 await mkdir('.netlify',{recursive:true});await page.screenshot({path:'.netlify/security-browser-evidence.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({browser:await browser.version(),viewport:'390x844',result:'PASS',
  checks:['contact gate','PIN enrollment','10 unlocks','private API denied','recovery OTP and PIN replacement','passkey cancel/retry','pagehide','identity switch','no browser errors']}));
}finally{await browser?.close();server.kill();}
