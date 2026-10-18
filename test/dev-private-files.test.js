import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

test('development HTTP cannot serve local tool credentials or dotenv files', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const name = 'private-probe-' + randomUUID() + '.txt';
  const privateFile = join(root, '.netlify', name), envName = '.env.probe-' + randomUUID();
  const envFile = join(root, envName), marker = 'public-fixture-never-a-real-credential';
  const country = process.env.APP_COUNTRY;
  let server;
  try {
    process.env.APP_COUNTRY = 'CO';
    await mkdir(join(root, '.netlify'), { recursive: true });
    await writeFile(privateFile, marker, { flag: 'wx' });
    await writeFile(envFile, marker, { flag: 'wx' });
    server = await createServer({ root, configFile: join(root, 'vite.config.js'), logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, hmr: false } });
    await server.listen();
    const base = 'http://127.0.0.1:' + server.httpServer.address().port;
    for (const path of ['/.netlify/' + name, '/@fs/' + privateFile.replaceAll('\\', '/'), '/.netlify/' + name + '?raw', '/' + envName]) {
      const response = await fetch(base + path, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(5000) });
      const text = await response.text();
      assert.equal(response.status, 403, path);
      assert.equal(text.includes(marker), false, path);
    }
    const example = await fetch(base + '/config/ngrok.colombia.example.yml', { headers: { Connection: 'close' } });
    const content = await example.text();
    assert.equal(example.status, 200);
    assert.equal(content.includes('REEMPLAZAR_CON_TU_NGROK_AUTHTOKEN'), true);
  } finally {
    await server?.close();
    await Promise.allSettled([unlink(privateFile), unlink(envFile)]);
    if (country === undefined) delete process.env.APP_COUNTRY; else process.env.APP_COUNTRY = country;
  }
});
