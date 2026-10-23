import {useEffect,useRef,useState} from 'react';
import {Buffer} from 'buffer';
import {SOLANA} from './chain.js';
import {securityFetch as fetch,nativeSecurityOperation,securitySnapshot} from './securitySession.js';

// Errores del cliente con código, para poder traducirlos en la interfaz (errorText.js). El mensaje sigue en español.
const fail=(code,message)=>Object.assign(new Error(message),{code});
export async function transferApi(path,getAccessToken,options={}) {
 const token=await getAccessToken();
 if(!token)throw fail('session_unavailable','Sesión no disponible. Volvé a iniciar sesión.');
 let response;
 try {response=await fetch(path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...options.headers},signal:AbortSignal.timeout(25000)});}
 catch {const error=new Error('No se pudo confirmar la respuesta. Consultá Activity antes de volver a enviar.');error.code='transfer_network_error';throw error;}
 const body=await response.json().catch(()=>({}));
 if(!response.ok){const error=new Error(transferError(body.error));error.code=body.error;throw error;}
 return body;
}
export function transferError(code) {
 return ({transfers_disabled:'Los envíos todavía no están habilitados.',primary_wallet_required:'La operación requiere tu wallet principal.',
  primary_wallet_unavailable:'No se pudo recuperar tu wallet principal. Sincronizá tu sesión.',
  transfer_daily_limit:'Alcanzaste los 2 envíos del día. El cupo se renueva a las 00:00 de Argentina.',
  transfer_budget_exhausted:'El patrocinio de red no está disponible temporalmente. Volvé a intentarlo más tarde.',
  transfer_sponsor_unavailable:'MidatoPay no puede cubrir el costo de red en este momento.',
  insufficient_usdc:'El saldo USDC disponible no alcanza, incluyendo los envíos pendientes.',
  transfer_blockhash_expired:'La autorización venció. Volvé a revisar y firmar la misma operación.',
  transfer_simulation_failed:'La red no pudo validar el envío. Revisá saldo y destinatario.',
  recipient_not_wallet:'Ingresá la dirección de la wallet Solana, no una cuenta de token o programa.',
  transfer_expired_requires_review:'El envío requiere revisión. No lo repitas hasta confirmar su estado.',
  transfer_onchain_failed:'La transferencia falló en Solana. Los USDC no fueron transferidos.',
  transfer_cost_limit:'El costo de red excede el límite de patrocinio.',
 })[code] || 'No se pudo completar la operación. Consultá Activity y volvé a intentarlo.';
}
export function exactUsdc(value) {
 const amount=String(value).trim().replace(',','.');
 if(!/^\d{1,12}(?:\.\d{1,6})?$/.test(amount))throw fail('invalid_amount_format','Usá un importe positivo con hasta 6 decimales.');
 const [whole,part='']=amount.split('.');
 const raw=BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));
 if(raw<=0n)throw fail('amount_zero','El importe debe ser mayor a cero.');
 return `${raw/1000000n}.${String(raw%1000000n).padStart(6,'0')}`;
}
export function assertTransferMatches(transfer,input,network=SOLANA.cluster) {
 if(transfer.from!==input.from || transfer.to!==input.to || exactUsdc(transfer.usdc)!==exactUsdc(input.amount) ||
   transfer.kind!==input.kind || transfer.network!==network)
  throw fail('recovery_mismatch','La operación recuperada no coincide con la que revisaste. Consultá Activity.');
}
export function useSponsoredTransfers({userId,wallet,getAccessToken,signTransaction}) {
 const [approval,setApproval]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[errorCode,setErrorCode]=useState(null);
 const [info,setInfo]=useState(null),[recovery,setRecovery]=useState(null);
 const pending=useRef(null),running=useRef(false),identity=useRef(userId);identity.current=userId;
 const storageKey=`mp_transfer_pending_${SOLANA.cluster}_${userId}`;
 const read=()=>{try{return JSON.parse(localStorage.getItem(storageKey));}catch{return null;}};
 const save=value=>{try{localStorage.setItem(storageKey,JSON.stringify(value));}catch{throw fail('storage_unavailable','Habilitá el almacenamiento local para recuperar el envío si se interrumpe.');}};
 const clear=()=>{try{localStorage.removeItem(storageKey);}catch{}}
 useEffect(()=>{
  identity.current=userId;
  let canceled=false;setInfo(null);setRecovery(null);setApproval(null);setError('');setErrorCode(null);
  pending.current?.reject(fail('session_changed','La sesión cambió.'));pending.current=null;
  if(userId){setRecovery(read());transferApi('/transfers',getAccessToken).then(body=>{if(!canceled)setInfo(body);}).catch(()=>{});}
  return()=>{canceled=true;identity.current=null;pending.current?.reject(fail('session_changed','La sesión cambió.'));pending.current=null;};
 },[userId,getAccessToken]);
 const send=parsed=>{
  if(pending.current || running.current)return Promise.reject(fail('approval_in_progress','Ya hay una autorización en curso.'));
  if(!wallet?.address)return Promise.reject(fail('wallet_not_ready','Tu wallet principal no está lista para firmar.'));
  const data={from:wallet.address,to:parsed.contact.addr,amount:exactUsdc(parsed.usdcText ?? parsed.usdc),kind:parsed.kind || 'voice'};
  const saved=read();
  if(saved && JSON.stringify(saved.input)!==JSON.stringify(data))return Promise.reject(fail('pending_recovery','Recuperá primero la operación pendiente desde el aviso de transferencia.'));
  setApproval({input:data,recipient:parsed.contact.name,saved});setError('');setErrorCode(null);
  return new Promise((resolve,reject)=>{pending.current={resolve,reject,userId};});
 };
 const cancel=()=>{if(running.current)return;pending.current?.reject(fail('signature_canceled','Firma cancelada.'));pending.current=null;setApproval(null);setError('');setErrorCode(null);};
 const approve=async()=>{
  if(running.current || !approval || !pending.current)return;
  running.current=true;setBusy(true);setError('');setErrorCode(null);
  const owner=userId;
  try {
   if(identity.current!==owner || wallet?.address!==approval.input.from)throw fail('session_changed','La wallet o la sesión cambió.');
   let saved=read() || approval.saved || {key:crypto.randomUUID(),input:approval.input};
   if(JSON.stringify(saved.input)!==JSON.stringify(approval.input))throw fail('pending_recovery','Hay otra operación pendiente en esta sesión. Recuperala antes de continuar.');
   save(saved);setRecovery(saved);
   let transfer;
   if(saved.id){transfer=(await transferApi(`/transfers/${saved.id}`,getAccessToken)).transfer;assertTransferMatches(transfer,approval.input);}
   if(!transfer?.signature){
    const body=await transferApi('/transfers',getAccessToken,{method:'POST',headers:{'Idempotency-Key':saved.key},body:JSON.stringify(saved.input)});
    transfer=body.transfer;assertTransferMatches(transfer,approval.input);saved={...saved,id:transfer.id};save(saved);setRecovery(saved);
    if(identity.current!==owner)throw fail('session_changed','La sesión cambió.');
    if(!transfer.signature){
     const epoch=securitySnapshot().epoch;
     const result=await nativeSecurityOperation(()=>signTransaction({transaction:new Uint8Array(Buffer.from(transfer.transaction,'base64')),wallet,chain:SOLANA.chain}));
     if(securitySnapshot().epoch!==epoch)throw fail('session_changed','La sesión cambió.');
     if(identity.current!==owner)throw fail('session_changed','La sesión cambió.');
     const submitted=await transferApi(`/transfers/${transfer.id}/submit`,getAccessToken,{method:'POST',body:JSON.stringify({signedTransaction:Buffer.from(result.signedTransaction).toString('base64')})});
     transfer=submitted.transfer;setInfo(previous=>({...previous,quota:submitted.quota}));
    }
   }
   clear();setRecovery(null);
   if(identity.current===owner){pending.current?.resolve(transfer);pending.current=null;setApproval(null);}
  }catch(e){if(identity.current===owner){setError(e.message);setErrorCode(e.code || null);}}
  finally{running.current=false;if(identity.current===owner)setBusy(false);}
 };
 const recover=async()=>{
  if(!recovery?.id)return null;
  const body=await transferApi(`/transfers/${recovery.id}`,getAccessToken);
  if(body.transfer.signature){clear();setRecovery(null);return body.transfer;}
  // The user may discard only an unsigned intention; it never had a treasury signature.
  return {...body.transfer,unsigned:true};
 };
 return {send,approval,busy,error,errorCode,info,approve,cancel,recovery,recover,
  discardUnsigned:async()=>{
   if(recovery?.id)await transferApi(`/transfers/${recovery.id}/cancel`,getAccessToken,{method:'POST',body:'{}'});
   clear();setRecovery(null);
  }};
}
