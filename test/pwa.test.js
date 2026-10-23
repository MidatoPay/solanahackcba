import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createInstallController, registerAppWorker } from '../src/pwa.js';

function browser() {
  const target = new EventTarget();
  const media = Object.assign(new EventTarget(), { matches: false });
  return Object.assign(target, { navigator: {}, isSecureContext: true, media, matchMedia: () => media });
}

test('installation is user initiated, captured before UI mount, and each prompt is used once', async () => {
  const win = browser(), controller = createInstallController(win);
  let prompts = 0;
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: () => { prompts++; return Promise.resolve(); },
    userChoice: Promise.resolve({ outcome: 'dismissed' }),
  });
  win.dispatchEvent(event);
  assert.equal(prompts, 0);
  assert.equal(event.defaultPrevented, true);
  assert.equal(controller.getState().canPrompt, true);
  const result = controller.install();
  assert.equal(prompts, 1, 'prompt executes immediately inside the click gesture');
  assert.equal(await result, 'dismissed');
  assert.equal(await controller.install(), 'unavailable');
  assert.equal(prompts, 1);
  assert.equal(controller.getState().standalone, false);
  win.dispatchEvent(new Event('appinstalled'));
  assert.equal(controller.getState().standalone, true);
  controller.dispose();
});

test('installed display modes, iOS and server rendering do not offer another install', () => {
  const win = browser(), controller = createInstallController(win);
  win.media.matches = true; win.media.dispatchEvent(new Event('change'));
  assert.equal(controller.getState().standalone, true);
  win.media.matches = false; win.media.dispatchEvent(new Event('change'));
  assert.equal(controller.getState().standalone, false);
  win.navigator.standalone = true; win.media.dispatchEvent(new Event('change'));
  assert.equal(controller.getState().standalone, true);
  assert.deepEqual(createInstallController(null).getState(), {
    standalone: false, canPrompt: false, platform: 'desktop', inAppBrowser: false, suggested: false,
  });
  controller.dispose();
});

test('service worker registration is optional and scoped to this app without cached updates', async () => {
  assert.equal(await registerAppWorker({ isSecureContext: false }), null);
  assert.equal(await registerAppWorker({ isSecureContext: true, navigator: {} }), null);
  const calls = [];
  await registerAppWorker({ isSecureContext: true, navigator: { serviceWorker: {
    register: (...args) => { calls.push(args); return Promise.resolve({}); },
  } } });
  assert.deepEqual(calls, [['/sw.js', { scope: '/', updateViaCache: 'none' }]]);
});

const worker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function workerRuntime(fetch) {
  const handlers = {}, cached = [], deleted = [];
  const offline = new Response('offline page');
  const cache = { add: async path => cached.push(path), match: async () => offline };
  const caches = { open: async () => cache,
    keys: async () => ['midatopay-offline-v0', 'midatopay-offline-v1', 'another-app'],
    delete: async key => deleted.push(key) };
  runInNewContext(worker, { self: { location: { origin: 'https://app.example' },
    addEventListener: (name, handler) => { handlers[name] = handler; } }, caches, fetch, URL, Response });
  return { handlers, cached, deleted, offline };
}

test('worker caches only the offline page and cleans only its own previous cache', async () => {
  const runtime = workerRuntime(() => { throw new Error('Unexpected fetch'); });
  let pending;
  runtime.handlers.install({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(runtime.cached, ['/offline.html']);
  runtime.handlers.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(runtime.deleted, ['midatopay-offline-v0']);
});

test('worker leaves APIs, RPC, authentication, payment POSTs and bundles entirely to the network', () => {
  const { handlers } = workerRuntime(() => { throw new Error('Must not intercept'); });
  for (const [url, method, mode] of [
    ['/charges', 'POST', 'cors'], ['/charges', 'GET', 'navigate'], ['/wallet', 'GET', 'cors'],
    ['/rpc', 'POST', 'cors'], ['/merchant-profile', 'GET', 'navigate'],
    ['/security/status','GET','navigate'], ['/security/renew','POST','cors'],
    ['/security/recovery/start','POST','cors'], ['/security/recovery/verify','POST','cors'],
    ['/security/recovery-email/start','POST','cors'], ['/security/recovery-email/verify','POST','cors'],
    ['/.netlify/functions/security/status','GET','navigate'], ['/security/passkey/options','POST','cors'],
    ['/webhooks/mercadopago', 'POST', 'cors'], ['/transfers', 'POST', 'cors'],
    ['https://auth.privy.io/', 'GET', 'navigate'], ['/assets/app.js', 'GET', 'cors'],
  ]) handlers.fetch({ request: { url: new URL(url, 'https://app.example').href, method, mode },
    respondWith: () => assert.fail(`Unexpected interception: ${url}`) });
});

test('offline navigation uses the notice; a server error is preserved without stale app HTML', async () => {
  const request = { url: 'https://app.example/', method: 'GET', mode: 'navigate' };
  const offline = workerRuntime(async () => { throw new TypeError('Offline'); });
  let response;
  offline.handlers.fetch({ request, respondWith: promise => { response = promise; } });
  assert.equal(await response, offline.offline);
  const unavailable = new Response('unavailable', { status: 503 });
  const online = workerRuntime(async () => unavailable);
  online.handlers.fetch({ request, respondWith: promise => { response = promise; } });
  assert.equal(await response, unavailable);
});

test('manifest icons are actual square PNGs at the declared dimensions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  for (const icon of manifest.icons) {
    const png = await readFile(new URL(`../public${icon.src}`, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
});
