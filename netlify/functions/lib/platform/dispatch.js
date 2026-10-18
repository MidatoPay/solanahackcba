export async function kickPlatformWorker({ env = process.env, request = fetch } = {}) {
  const base = env.PAYMENTS_BASE_URL || env.URL;
  if (!base || (env.INTERNAL_WORKER_SECRET || '').length < 32) return { accepted: false, code: 'worker_not_configured' };
  try {
    const response = await request(new URL('/.netlify/functions/platform-worker-background', base), {
      method: 'POST', headers: { 'x-worker-secret': env.INTERNAL_WORKER_SECRET }, signal: AbortSignal.timeout(4000),
    });
    return { accepted: response.ok };
  } catch { return { accepted: false, code: 'worker_dispatch_unavailable' }; }
}
