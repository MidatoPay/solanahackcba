import { kickPlatformWorker } from './lib/platform/dispatch.js';
import { platformConfig } from './lib/platform/config.js';
export const handler = async () => {
  if (platformConfig().country.legacy || !process.env.PLATFORM_DATABASE_URL) return { statusCode: 200, body: 'skipped' };
  await kickPlatformWorker();
  return { statusCode: 200, body: 'dispatched' };
};
export const config = { schedule: '* * * * *' };
