import { internalAuthorized } from './lib/paymentRuntime.js';
import { createPlatformService } from './lib/platform/service.js';
import { runPlatformWorker } from './lib/platform/worker.js';
export const handler = async event => {
  if (event.httpMethod !== 'POST' || !internalAuthorized(event)) return { statusCode: 401, body: 'unauthorized' };
  await runPlatformWorker(createPlatformService());
  return { statusCode: 200, body: 'ok' };
};
