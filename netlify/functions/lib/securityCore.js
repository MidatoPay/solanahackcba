import { randomBytes, scrypt as derive, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { PaymentError } from './paymentCore.js';

const scrypt = promisify(derive);
export const fail = (code, status=400) => new PaymentError(code,status);
export const opaque = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const header = (event,name) => Object.entries(event.headers || {}).find(([key])=>key.toLowerCase()===name)?.[1] || '';
export function validPin(pin) {
 if(typeof pin!=='string' || !/^\d{5}$/.test(pin) || /^(\d)\1{4}$/.test(pin))return false;
 const digits=[...pin].map(Number);
 return ![1,-1].some(step=>digits.slice(1).every((n,i)=>n===digits[i]+step));
}
function pepper(env) {
 if(!env.SECURITY_PIN_PEPPER || env.SECURITY_PIN_PEPPER.length<32)throw fail('security_not_configured',503);
 return env.SECURITY_PIN_PEPPER;
}
async function pinKey(pin,salt,env) {
 const material=createHmac('sha256',pepper(env)).update(pin).digest();
 return scrypt(material,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
}
export async function createPin(pin,env=process.env) {
 if(!validPin(pin))throw fail('invalid_pin');
 const salt=opaque();
 return {version:1,N:32768,r:8,p:1,salt,key:(await pinKey(pin,salt,env)).toString('base64url')};
}
export async function verifyPin(pin,record,env=process.env) {
 if(!record || record.version!==1 || typeof pin!=='string' || !/^\d{5}$/.test(pin))return false;
 const expected=Buffer.from(record.key,'base64url'),actual=await pinKey(pin,record.salt,env);
 return expected.length===actual.length && timingSafeEqual(expected,actual);
}
export function webauthnConfig(env=process.env) {
 const rpID=env.SECURITY_RP_ID,origins=(env.SECURITY_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
 if(!rpID || !origins.length)throw fail('security_not_configured',503);
 for(const origin of origins) {
  let url;try{url=new URL(origin);}catch{throw fail('security_not_configured',503);}
  if(url.origin!==origin || (url.protocol!=='https:' && !(url.protocol==='http:' && url.hostname==='localhost')) ||
    !(url.hostname===rpID || url.hostname.endsWith('.'+rpID)))throw fail('security_not_configured',503);
 }
 return {rpID,origins};
}
