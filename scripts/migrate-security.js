import {readFile} from 'node:fs/promises';
import {getPaymentDb} from '../netlify/functions/lib/paymentRuntime.js';
const db=getPaymentDb();
try {
 await db.query(await readFile(new URL('../db/migrations/20261021_app_security.sql',import.meta.url),'utf8'));
 console.log('Migración de seguridad aplicada.');
}catch{console.error('No se pudo aplicar la migración de seguridad. Revisá conexión, TLS y permisos.');process.exitCode=1;}
finally{await db.end();}
