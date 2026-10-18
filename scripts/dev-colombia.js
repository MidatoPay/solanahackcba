import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';

try {
  const env = parseEnv(await readFile(new URL('../.env.colombia', import.meta.url), 'utf8'));
  if (env.APP_COUNTRY !== 'CO' || env.APP_ENVIRONMENT !== 'sandbox' || env.VITE_SOLANA_CLUSTER !== 'devnet') throw new Error('invalid_sandbox_config');
  const child = spawn(process.execPath, ['node_modules/netlify-cli/bin/run.js', 'dev', '--offline'], {
    cwd: new URL('..', import.meta.url), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ...env, GOMAXPROCS: '2', GOMEMLIMIT: '768MiB' },
  });
  child.on('exit', code => { process.exitCode = code || 0; });
  child.on('error', () => { console.error('No se pudo iniciar Netlify Dev.'); process.exitCode = 1; });
} catch { console.error('Ejecuta npm run colombia:env y configura .env.colombia con sandbox + devnet.'); process.exitCode = 1; }
