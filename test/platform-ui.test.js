import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { publicConfig } from '../netlify/functions/lib/platform/config.js';
import { parseLocalCommand, intentStore, csvReport } from '../src/platform/client.js';
import { guardLegacyHandler } from '../netlify/functions/lib/legacyCountry.js';

const compiled = await build({
  stdin: { contents: "export {default as App,OperationDetail} from './src/platform/PlatformApp.jsx'; export {default as ContactAgenda} from './src/platform/ContactAgenda.jsx'; export {setSession} from '@privy-io/react-auth';", resolveDir: process.cwd(), loader: 'js' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', loader: { '.css': 'empty' }, logLevel: 'silent',
  plugins: [{ name: 'platform-privy-fixtures', setup(build) {
    build.onResolve({ filter: /^@privy-io\/react-auth(?:\/solana)?$/ }, () => ({ path: 'mock', namespace: 'privy' }));
    build.onLoad({ filter: /.*/, namespace: 'privy' }, () => ({ loader: 'js', contents: `
      let session; export function setSession(s){session={ready:false,authenticated:false,user:null,login:()=>{},logout:()=>{},getAccessToken:async()=>null,...s};}
      export function usePrivy(){return session;}
      export function useWallets(){return {wallets:[],ready:session.ready};}
      export function useSignTransaction(){return {signTransaction:async()=>{throw new Error('Startup must never sign');}};}
    ` }));
  } }],
});
const loaded = { exports: {} };
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { App, OperationDetail, ContactAgenda, setSession } = loaded.exports;
const config = publicConfig({ PLATFORM_ENABLED: 'true' });
for (const session of [{}, { ready: true }, { ready: false, authenticated: true, user: { id: 'test' } },
  { ready: true, authenticated: true, user: null }, { ready: true, authenticated: true, user: undefined }]) {
  test(`Colombia startup handles incomplete Privy state ${JSON.stringify(session)}`, () => {
    setSession(session);
    const html = renderToStaticMarkup(createElement(App, { config }));
    assert.match(html, /Ingresar a mi billetera|Preparando ingreso/);
    assert.match(html, /Sandbox/); assert.doesNotMatch(html, /Exportar|undefined COP/);
  });
}
test('Colombia authenticated startup is safe before primary wallet/model synchronization', () => {
  setSession({ ready: true, authenticated: true, user: { id: 'test' } });
  const html = renderToStaticMarkup(createElement(App, { config }));
  assert.match(html, /Hola, bienvenido/); assert.match(html, /Preparando wallet/);
  assert.doesNotMatch(html, /undefined|NaN/);
});
test('country capabilities control navigation and actions while currency labels follow the country', () => {
  setSession({ ready: true, authenticated: true, user: { id: 'test' } });
  const limited = { ...config, country: { ...config.country, currency: 'MXN', name: 'País de prueba' }, services: {} };
  const html = renderToStaticMarkup(createElement(App, { config: limited }));
  assert.doesNotMatch(html, /Cobrar con QR|Retirar pesos|Enviar USDC ↗|Retirar MXN/);
  assert.match(html, /País de prueba/); assert.match(html, /MXN/);
});
test('signing receipt shows fixed destination, amount, network, mint, fee payer and expiry', () => {
  const op = { id: 'test', kind: 'transfer', status: 'awaiting_signature', usdcAmount: '1.000000', fiatAmount: '0.00', feeFiat: '0.00',
    wallet: 'sender-wallet', to: 'fixed-recipient-wallet', feePayer: 'sponsor-wallet', expiresAt: new Date(Date.now() + 300000).toISOString(), children: [] };
  const html = renderToStaticMarkup(createElement(OperationDetail, { operation: op, config, onClose() {}, onSign() {}, onCancel() {} }));
  for (const value of ['fixed-recipient-wallet','1.000000','Solana Devnet',config.mint,'sponsor-wallet','0 SOL','firmar con mi wallet']) assert.ok(html.includes(value), value);
  const withdrawal = renderToStaticMarkup(createElement(OperationDetail, { operation: { ...op, kind: 'withdrawal', status: 'pending', destinationId: 'saved-bank', destinationLabel: 'Cuenta •••1234' }, config, onClose() {} }));
  assert.match(withdrawal, /Comisión de retiro/); assert.match(withdrawal, /Cuenta •••1234/);
  assert.doesNotMatch(withdrawal, /0,5%/);
});
test('voice uses local currency, exact contact identities and never silently converts a USDC charge', () => {
  const contacts = [{ alias: 'ana', name: 'Ana', address: '11111111111111111111111111111111' }];
  assert.equal(parseLocalCommand('cobrar 5000 pesos').currency, 'COP');
  assert.equal(parseLocalCommand('cobrar 5000 USDC'), null);
  assert.equal(parseLocalCommand('cobrar 5000 ARS'), null);
  assert.equal(parseLocalCommand('enviar 1 USDC a ana', 'COP', contacts).recipient, 'ana');
  assert.equal(parseLocalCommand('enviar 1 USDC a an', 'COP', contacts), null);
  assert.equal(parseLocalCommand('enviar 1 USDC a banco', 'COP', [{ alias: 'banco', name: 'Banco', address: null }]), null);
  assert.equal(parseLocalCommand('enviar 1 USDC a Ana', 'COP', [...contacts,{ ...contacts[0],alias:'otra' }]), null);
});
test('agenda only renders optional bank data for countries with bank capability and masks stored accounts', () => {
  const contacts = [{ id: 'ana', name: 'Ana', alias: 'ana', address: null, bankAccounts: [{ bankName: 'Banco Prueba', holderName: 'Ana Prueba', accountType: 'SAVINGS', accountNumber: '001234567890', currency: 'COP' }] }];
  const props = { contacts, run() {}, request() {}, refresh() {} };
  const enabled = renderToStaticMarkup(createElement(ContactAgenda, { ...props, config }));
  for (const text of ['Cuentas bancarias (opcional)', 'Agregar cuenta bancaria', 'Banco Prueba', '•••• 7890', 'Dirección Solana para USDC (opcional)']) assert.ok(enabled.includes(text), text);
  assert.doesNotMatch(enabled, /001234567890/);
  const disabled = renderToStaticMarkup(createElement(ContactAgenda, { ...props, config: publicConfig({ PLATFORM_ENABLED: 'false' }) }));
  assert.doesNotMatch(disabled, /Cuentas bancarias|Agregar cuenta bancaria|Banco Prueba|7890/);
  assert.equal(publicConfig({ APP_COUNTRY: 'AR', PLATFORM_ENABLED: 'true' }).features.bankContacts, false);
});
test('pending intents are isolated by country/context and owner; CSV neutralizes spreadsheet formulas', () => {
  const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key,value) => data.set(key,value), removeItem: key => data.delete(key) };
  const store = intentStore(storage,'co-context','u1'); store.save({ key: 'stable', path: '/charges', body: { amount: '1000' } });
  assert.equal(store.read().key, 'stable');
  assert.equal(intentStore(storage,'ar-context','u1').read(), null); assert.equal(intentStore(storage,'co-context','u2').read(), null);
  store.clear(); assert.equal(store.read(), null);
  assert.match(csvReport([{ id: '=INJECTION()', currency: 'COP' }]), /'=INJECTION/);
});
test('Colombia cannot reach legacy handlers even when old credentials exist on the host', async () => {
  const old = process.env.APP_COUNTRY; let touched = false;
  try {
    process.env.APP_COUNTRY = 'CO'; const handler = guardLegacyHandler(async () => { touched = true; });
    assert.equal((await handler({})).statusCode, 403); assert.equal(touched, false);
  } finally { if (old === undefined) delete process.env.APP_COUNTRY; else process.env.APP_COUNTRY = old; }
});
