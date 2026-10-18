// Local HTTP/MIME checks; never logs in, creates operations or signs a wire.
const base = new URL(process.env.PAYMENTS_BASE_URL || 'http://localhost:8888');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('This check is restricted to a local development server.');
const checks = [];
async function check(path, verify, options) {
  const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  if (!verify(response, body)) throw new Error(`Local check failed: ${path} (HTTP ${response.status}).`);
  checks.push({ path, status: response.status });
}
try {
  await check('/', r => r.ok && r.headers.get('content-type')?.includes('text/html'));
  for (const path of ['/@vite/client', '/src/main.jsx', '/src/platform/PlatformApp.jsx'])
    await check(path, r => r.ok && /javascript/.test(r.headers.get('content-type') || ''));
  await check('/app-config', (r, body) => {
    const c = JSON.parse(body);
    return r.ok && c.country?.code === 'CO' && c.network === 'devnet' && c.documents?.every(doc => doc.draft) && typeof c.features?.bankContacts === 'boolean';
  });
  await check('/platform/me', r => r.status === 401);
  await check('/wallet', r => r.status === 403);
  await check('/webhooks/onepay', (r, body) => {
    const result = JSON.parse(body);
    return r.status === 401 && result.error === 'invalid_signature' || r.status === 503 && result.error === 'onepay_webhook_not_configured';
  }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log(JSON.stringify({ ready: true, checks, authenticatedBrowserTest: false }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
