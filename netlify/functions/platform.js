import { authenticatePayment } from './lib/paymentRuntime.js';
import { PaymentError } from './lib/paymentCore.js';
import { PlatformError } from '../../src/platform/money.js';
import { createPlatformService } from './lib/platform/service.js';
import { registerCustomer, registerDestination, inspectBrebKey } from './lib/platform/destinations.js';
import { fetchPlatformQuote } from './lib/platform/fx.js';
import { publicOperation } from './lib/platform/store.js';
import { kickPlatformWorker } from './lib/platform/dispatch.js';
import { reconcilePlatformWallet } from './lib/platform/receipts.js';
import { withdrawalService } from './lib/platform/providers.js';

export function platformResponse(statusCode, value) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(value) };
}
export function platformFailure(error) {
  const known = error instanceof PlatformError || error instanceof PaymentError;
  const code = known ? error.code :
    ['42P01','42703'].includes(error?.code) ? 'platform_migration_required' : 'platform_service_unavailable';
  return platformResponse(known ? error.status : 503, { error: code });
}
export function createPlatformHandler(adapters = {}) {
  return async event => {
    try {
      const userId = await (adapters.authenticate || authenticatePayment)(event);
      if (!['GET','POST','PATCH'].includes(event.httpMethod)) return platformResponse(405, { error: 'method_not_allowed' });
      const service = (adapters.service || createPlatformService)();
      if (service.config.country.legacy) throw new PlatformError('service_unavailable', 403);
      const path = event.path.replace(/^\/\.netlify\/functions\/platform/, '/platform').replace(/\/$/, '');
      const method = event.httpMethod, query = event.queryStringParameters || {};
      const contextId = Object.entries(event.headers || {}).find(([name]) => name.toLowerCase() === 'x-platform-context')?.[1];
      if (method !== 'GET' && contextId !== service.config.contextId) throw new PlatformError('deployment_context_changed', 409);
      const match = path.match(/^\/platform\/operations\/([0-9a-f-]{36})(?:\/(submit|cancel))?$/i);
      const key = Object.entries(event.headers || {}).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
      let body = {};
      if (method !== 'GET') {
        if (Buffer.byteLength(event.body || '') > 32768) throw new PlatformError('payload_too_large', 413);
        try { body = JSON.parse(event.body || '{}'); } catch { throw new PlatformError('invalid_json', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PlatformError('invalid_json', 400);
      }
      const ok = value => platformResponse(200, value);
      const schedule = adapters.kick || kickPlatformWorker;
      if (method === 'GET') {
        if (path === '/platform/me') return ok(await service.me(userId));
        if (path === '/platform/operations') return ok(await service.list(userId, query.before));
        if (path === '/platform/rates') return ok({ quote: await (adapters.quote || service.deps.quote)() });
        if (path === '/platform/banks') {
          const { providerId } = withdrawalService(service.config, 'bank');
          const banks = await service.deps.providerFor(providerId).getBanks();
          return ok({ banks: Array.isArray(banks) ? banks : banks.data || [] });
        }
        if (path === '/platform/breb-key') return ok(await inspectBrebKey(service, userId, query.key));
        if (path === '/platform/reports') {
          const admins = (process.env.PAYMENTS_ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
          if (!admins.includes(userId)) throw new PlatformError('forbidden', 403);
          const result = await service.db.query(`SELECT * FROM platform_operations WHERE scope=$1 ORDER BY created_at DESC,id DESC LIMIT 1000`, [service.config.scope]);
          return ok({ currency: service.config.country.currency, timeZone: service.config.country.timeZone,
            operations: result.rows.map(row => ({ ...publicOperation(row), merchantId: row.user_id,
              earnedFee: ['buy','sell'].includes(row.kind) && row.status === 'completed' ? publicOperation(row).feeFiat : '0.00' })), limit: 1000 });
        }
        if (match && !match[2]) {
          const operation = await service.get(userId, match[1]);
          if (!['completed','failed','expired','canceled'].includes(operation.status)) await schedule();
          return ok({ operation });
        }
      }
      if (method === 'PATCH' && path === '/platform/settings') return ok(await service.settings(userId, body));
      if (method === 'POST') {
        if (path === '/platform/acceptances') return ok(await service.accept(userId, body));
        if (path === '/platform/customer') return ok(await registerCustomer(service, userId, body));
        if (path === '/platform/destinations') return ok(await registerDestination(service, userId, body, key));
        if (path === '/platform/quotes') return ok(await service.quote(userId, body));
        if (path === '/platform/contacts') return ok(await service.saveContact(userId, body));
        if (path === '/platform/contacts/remove') {
          if (!/^[0-9a-f-]{36}$/i.test(body.id || '')) throw new PlatformError('invalid_contact', 400);
          return ok(await service.deleteContact(userId, body.id));
        }
        if (path === '/platform/reconcile') return ok(await reconcilePlatformWallet(service, userId));
        if (path === '/platform/attempts/close') {
          if (body.id && !/^[0-9a-f-]{36}$/i.test(body.id)) throw new PlatformError('invalid_operation_id', 400);
          const result = await service.closeAttempt(userId, body.key, body.id || null); await schedule(); return ok(result);
        }
        let operation;
        if (path === '/platform/charges') operation = await service.createCollection(userId, body, key);
        else if (path === '/platform/conversions/buy') operation = await service.createBuy(userId, body, key);
        else if (path === '/platform/conversions/sell') operation = await service.createSell(userId, body, key);
        else if (path === '/platform/withdrawals') operation = await service.createWithdrawal(userId, body, key);
        else if (path === '/platform/transfers') operation = await service.createTransfer(userId, body, key);
        else if (match?.[2] === 'submit') operation = await service.submit(userId, match[1], body.signedTransaction);
        else if (match?.[2] === 'cancel') operation = await service.cancel(userId, match[1]);
        if (operation) {
          await schedule();
          return platformResponse(202, { operation: publicOperation(operation) });
        }
      }
      return platformResponse(404, { error: 'not_found' });
    } catch (error) { return platformFailure(error); }
  };
}
export const handler = createPlatformHandler();
