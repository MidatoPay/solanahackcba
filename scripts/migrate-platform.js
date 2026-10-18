import { readFile } from 'node:fs/promises';
import { getPlatformDb, closePlatformDb, platformConfig } from '../netlify/functions/lib/platform/config.js';

try {
  const config = platformConfig();
  if (config.country.legacy) throw new Error();
  await getPlatformDb().query(await readFile(new URL('../db/migrations/20261018_country_platform.sql', import.meta.url), 'utf8'));
  console.log('Esquema del sandbox por país aplicado en la base aislada.');
} catch { console.error('Migración no aplicada: verificar configuración sandbox, base aislada y certificado TLS.'); process.exitCode = 1; }
finally { await closePlatformDb(); }
