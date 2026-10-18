import { readFile, writeFile, access } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import bs58 from 'bs58';

const target = new URL('../.env.colombia', import.meta.url);
try { await access(target); console.log('.env.colombia ya existe; se conservó sin cambios.'); }
catch {
  let existing = {};
  try { existing = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')); } catch { /* A fresh clone has no private env. */ }
  const pair = generateKeyPairSync('ed25519');
  const seed = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const values = {
    VITE_PRIVY_APP_ID: existing.VITE_PRIVY_APP_ID || '', PRIVY_APP_SECRET: existing.PRIVY_APP_SECRET || '',
    ANTHROPIC_API_KEY: existing.ANTHROPIC_API_KEY || '', INTERNAL_WORKER_SECRET: randomBytes(32).toString('hex'),
    TREASURY_SECRET_KEY: bs58.encode(Buffer.concat([seed, publicKey])),
  };
  let template = await readFile(new URL('../.env.colombia.example', import.meta.url), 'utf8');
  for (const [key, value] of Object.entries(values)) template = template.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${JSON.stringify(value)}`);
  await writeFile(target, template, { flag: 'wx', mode: 0o600 });
  console.log('.env.colombia creado: nueva tesorería de prueba y secreto de worker. No se copiaron RPC, claves financieras ni bases de producción.');
  console.log('Pendiente: OnePay sk_test, webhook y PostgreSQL independiente. PLATFORM_ENABLED permanece false.');
}
