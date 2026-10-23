import React,{useEffect,useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {PrivyFixture,usePrivy} from './privy-fixture.jsx';
import SecurityGate,{SecurityPanel} from '../../src/SecurityGate.jsx';
import {acceptUnlock,securityFetch,nativeSecurityOperation,requestSecurityLock} from '../../src/securitySession.js';
import {LanguageProvider,useLanguage} from '../../src/i18n.jsx';
import LanguageSelect from '../../src/LanguageSelect.jsx';
import ChargeSummary from '../../src/ChargeSummary.jsx';

function PrivateContent() {
 const {getAccessToken,user}=usePrivy();
 const [security,setSecurity]=useState(false),[message,setMessage]=useState(''),[pending,setPending]=useState(false);
 const finishNative=useRef(null);
 useEffect(()=>{
  let active=true;
  const read=async()=>{try{
   const token=await getAccessToken();
   const response=await securityFetch('/fixture/private',{headers:{Authorization:`Bearer ${token}`}});
   const body=await response.json();if(active)setMessage(response.ok?body.message:`HTTP ${response.status}`);
  }catch(error){if(active)setMessage(error.message);}};
  read();const timer=setInterval(read,2000);
  return()=>{active=false;clearInterval(timer);finishNative.current?.();};
 },[getAccessToken]);
 if(security)return <SecurityPanel manage getToken={getAccessToken} onUnlocked={acceptUnlock} onClose={()=>setSecurity(false)} />;
 return <section style={{padding:24,background:'#fff',minHeight:300}}>
  <h1>Contenido privado de prueba</h1><p>{user.id}</p><p role="status">{message}</p>
  <button onClick={()=>setSecurity(true)}>Perfil → Seguridad</button>{' '}
  <button onClick={requestSecurityLock}>Bloquear ahora</button>
  <p><button disabled={pending} onClick={async()=>{setPending(true);await nativeSecurityOperation(()=>new Promise(resolve=>{finishNative.current=resolve;}));setPending(false);}}>Iniciar diálogo nativo simulado</button>{' '}
  <button disabled={!pending} onClick={()=>finishNative.current?.()}>Terminar diálogo simulado</button></p>
  {pending && <p>Operación nativa simulada pendiente</p>}
 </section>;
}
const base={id:'fixture-charge',status:'paid',providerStatus:'processed',providerDetail:'accredited',paidAt:new Date().toISOString(),
 ars:'22.00',feeArs:'0.11',fxRate:'1617.46',usdc:'0.013533',reference:'fixture-reference',orderId:'FIXTURE',
 expiresAt:new Date(Date.now()+600000).toISOString(),source:'mercadopago',settled:false};
function Charges() {
 const [status,setStatus]=useState('paid');
 return <><nav aria-label="Estado de cobro de prueba" style={{padding:12}}>{['awaiting_payment','paid','manual_review','delivered'].map(value=><button key={value} onClick={()=>setStatus(value)}>{value}</button>)}</nav>
 <div style={{height:'80vh',maxWidth:430,margin:'auto',padding:16,boxSizing:'border-box'}}>
 <ChargeSummary key={status} charge={{...base,status,providerStatus:status==='awaiting_payment'?'created':'processed',providerDetail:status==='awaiting_payment'?'created':'accredited'}}
  qr="/logo/logo.png" busy={false} onCancel={()=>setStatus('awaiting_payment')} onReset={()=>setStatus('awaiting_payment')} />
 </div></>;
}
function Fixture() {
 const {setId}=usePrivy(),[metrics,setMetrics]=useState(''),[charges,setCharges]=useState(false),[events,setEvents]=useState([]);
 const {setLang}=useLanguage();useEffect(()=>{setLang('es');window.name='midato-security-fixture';},[]);
 useEffect(()=>{
  const log=event=>setEvents(previous=>[...previous.slice(-7),`${event.type}: ${document.visibilityState}, foco=${document.hasFocus()}`]);
  window.addEventListener('blur',log);window.addEventListener('focus',log);document.addEventListener('visibilitychange',log);
  return()=>{window.removeEventListener('blur',log);window.removeEventListener('focus',log);document.removeEventListener('visibilitychange',log);};
 },[]);
 const command=async action=>{const response=await fetch('/fixture/'+action,{method:'POST'});setMetrics(JSON.stringify(await response.json()));};
 return <><aside style={{background:'#fff2cc',padding:12,fontFamily:'sans-serif',fontSize:13}}>
  <strong>ENTORNO DE PRUEBA LOCAL — sin cuentas, wallets ni fondos reales.</strong>
  <p>Privy simulado; API de seguridad real. Passkeys: cancelación simulada. PostgreSQL efímero.</p>
  <button onClick={()=>{setCharges(false);setId('alice');}}>Identidad Alice</button>{' '}
  <button onClick={()=>{setCharges(false);setId('bob');}}>Identidad Bob</button>{' '}
  <button onClick={()=>setCharges(value=>!value)}>Ver cobros de prueba</button>{' '}
  <button onClick={()=>command('state')}>Inspeccionar servidor</button>{' '}
  <button onClick={()=>command('offline')}>Simular red caída</button>{' '}
  <button onClick={()=>command('online')}>Restablecer red</button>{' '}
  <button onClick={()=>command('expire-lockout')}>Agotar bloqueo de PIN de prueba</button>{' '}
  <button onClick={()=>command('revoke')}>Revocar sesiones en servidor</button>{' '}
  <a href="/away" target="_blank" rel="opener" onClick={event=>{event.preventDefault();window.open('/away','midato-away-fixture')?.focus();}}>Abrir otra pestaña</a>
  <LanguageSelect id="fixture-language" />
  <output style={{display:'block',overflowWrap:'anywhere'}} aria-label="Estado del servidor de prueba">{metrics}</output>
  <output style={{display:'block',overflowWrap:'anywhere'}} aria-label="Eventos de visibilidad de prueba">{events.join(' | ')}</output>
 </aside>{charges?<Charges/>:<SecurityGate loginScreen={<p>Sesión de prueba cerrada</p>}><PrivateContent/></SecurityGate>}</>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><PrivyFixture><LanguageProvider><Fixture/></LanguageProvider></PrivyFixture></React.StrictMode>);
