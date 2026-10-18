import { randomUUID } from 'node:crypto';

// Provider customer IDs and idempotency keys never cross provider boundaries.
export async function providerCustomer(db, scope, userId, provider) {
  return (await db.query(`INSERT INTO platform_provider_customers(scope,user_id,provider,customer_key) VALUES($1,$2,$3,$4)
    ON CONFLICT(scope,user_id,provider) DO UPDATE SET provider=EXCLUDED.provider RETURNING *`,
  [scope, userId, provider, randomUUID()])).rows[0];
}
