import { publicConfig } from './lib/platform/config.js';
import { PlatformError } from '../../src/platform/money.js';
export const handler = async event => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: '{}' };
  try { return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(publicConfig()) }; }
  catch (error) { return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error instanceof PlatformError ? error.code : 'configuration_unavailable' }) }; }
};
