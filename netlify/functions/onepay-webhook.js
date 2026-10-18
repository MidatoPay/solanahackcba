import { randomUUID } from 'node:crypto';
import { getPlatformDb, platformConfig } from './lib/platform/config.js';
import { verifyOnepayWebhook } from './lib/platform/onepay.js';
import { kickPlatformWorker } from './lib/platform/dispatch.js';
import { platformResponse, platformFailure } from './platform.js';
export function createOnepayWebhook(adapters = {}) {
  return async event => {
    if (event.httpMethod !== 'POST') return platformResponse(405, { error: 'method_not_allowed' });
    try {
      const env = adapters.env || process.env;
      // Authenticate before opening the database, even when the site is paused.
      const received = verifyOnepayWebhook(event, env), config = platformConfig(env);
      const db = adapters.db || getPlatformDb(env);
      await db.query(`INSERT INTO platform_inbox(id,scope,event_key,event_type,resource_id,payload,provider) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(scope,event_key) DO NOTHING`, [randomUUID(), config.scope, 'onepay:' + received.key, received.type, received.resourceId, JSON.stringify(received.payload), 'onepay']);
      await (adapters.kick || kickPlatformWorker)();
      return platformResponse(200, { received: true });
    } catch (error) { return platformFailure(error); }
  };
}
export const handler = createOnepayWebhook();
