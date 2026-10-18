import { createPlatformService } from './lib/platform/service.js';
import { reconcilePlatformWallet } from './lib/platform/receipts.js';
import { platformConfig } from './lib/platform/config.js';
export const handler = async () => {
  if (platformConfig().country.legacy || !process.env.PLATFORM_DATABASE_URL) return { statusCode: 200, body: 'skipped' };
  const service = createPlatformService();
  const rows = (await service.db.query(`SELECT user_id FROM platform_merchants WHERE scope=$1 AND wallet_address IS NOT NULL
    ORDER BY updated_at LIMIT 20`, [service.config.scope])).rows;
  const deadline = Date.now() + 45000; let checked = 0, failed = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    try { await reconcilePlatformWallet(service, row.user_id, { deadline }); checked++; }
    catch { failed++; }
    await service.db.query('UPDATE platform_merchants SET updated_at=now() WHERE scope=$1 AND user_id=$2', [service.config.scope, row.user_id]);
  }
  return { statusCode: 200, body: JSON.stringify({ checked, failed }) };
};
export const config = { schedule: '*/15 * * * *' };
