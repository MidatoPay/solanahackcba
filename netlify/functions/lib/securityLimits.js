import { fail, hash, header } from './securityCore.js';

export function rateLimited(seconds, code='security_rate_limited') {
 const error=fail(code,429);error.retryAfter=Math.max(1,Math.ceil(seconds));return error;
}
// PostgreSQL serializes conflicting upserts, including requests in other instances.
// A denied request never extends the window or overflows the counter.
export async function takeLimit(db,key,maximum,seconds) {
 const {rows:[row]}=await db.query(`INSERT INTO app_security_limits(key,attempts,expires_at)
  VALUES($1,1,now()+$3*interval '1 second') ON CONFLICT(key) DO UPDATE SET
  attempts=CASE WHEN app_security_limits.expires_at<=now() THEN 1 ELSE LEAST(app_security_limits.attempts+1,$2+1) END,
  expires_at=CASE WHEN app_security_limits.expires_at<=now() THEN now()+$3*interval '1 second' ELSE app_security_limits.expires_at END
  RETURNING attempts, GREATEST(1,ceil(extract(epoch from expires_at-now()))) AS retry`,[key,maximum,seconds]);
 if(row.attempts>maximum)throw rateLimited(Number(row.retry));
}
export async function authenticationLimit(db,owner,event) {
 await takeLimit(db,'auth:ip:'+hash(header(event,'x-nf-client-connection-ip') || 'local'),1000,900);
 await takeLimit(db,'auth:user:'+hash(owner.userId),60,900);
}
