import { guardLegacyHandler } from './lib/legacyCountry.js';
import { authenticatePayment, getPaymentDb, getPaymentPrivy, json, errorResponse } from './lib/paymentRuntime.js';
import { PaymentError } from './lib/paymentCore.js';
import { userDisplayName, merchantDisplayName } from '../../src/merchantIdentity.js';

export function createMerchantProfileHandler(adapters = {}) {
  return async event => {
    try {
      const userId = await (adapters.authenticate || authenticatePayment)(event);
      if (!['GET','PATCH'].includes(event.httpMethod)) return json(405,{error:'method_not_allowed'});
      let businessName;
      if (event.httpMethod === 'PATCH') {
        let body;
        try { body = JSON.parse(event.body || '{}'); } catch { throw new PaymentError('invalid_json',400); }
        if (!body || Array.isArray(body) || typeof body !== 'object' ||
            Object.keys(body).some(key => key !== 'businessName') || !Object.hasOwn(body,'businessName') ||
            (body.businessName !== null && typeof body.businessName !== 'string'))
          throw new PaymentError('invalid_business_name',400);
        businessName = body.businessName?.trim() || null;
        if (businessName && (Array.from(businessName).length > 100 || /[\u0000-\u001f\u007f]/.test(businessName)))
          throw new PaymentError('invalid_business_name',400);
      }
      const user = await (adapters.getUser || (id => getPaymentPrivy().getUser(id)))(userId);
      const userName = userDisplayName(user);
      const db = adapters.db || getPaymentDb();
      const {rows:[profile]} = event.httpMethod === 'PATCH'
        ? await db.query(`INSERT INTO merchant_profiles(user_id,user_name,business_name) VALUES($1,$2,$3)
            ON CONFLICT(user_id) DO UPDATE SET user_name=EXCLUDED.user_name,business_name=EXCLUDED.business_name,updated_at=now()
            RETURNING user_name,business_name`,[userId,userName,businessName])
        : await db.query(`INSERT INTO merchant_profiles(user_id,user_name) VALUES($1,$2)
            ON CONFLICT(user_id) DO UPDATE SET user_name=EXCLUDED.user_name
            RETURNING user_name,business_name`,[userId,userName]);
      return json(200,{profile:{userName:profile.user_name,businessName:profile.business_name,
        displayName:merchantDisplayName(profile.business_name,profile.user_name)}});
    } catch(error) { return errorResponse(error); }
  };
}
const legacyHandler = createMerchantProfileHandler();

export const handler = guardLegacyHandler(legacyHandler);
