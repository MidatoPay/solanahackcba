// Explicit pilot membership is server-owned. Absence of a rollout setting keeps
// enforcement on. false with an empty list is only the pre-rollout state.
export function securityEnforced(env,userId) {
 if(env.SECURITY_ENFORCED==='false')return (env.SECURITY_PILOT_USER_IDS || '').split(',').map(s=>s.trim()).filter(Boolean).includes(userId);
 return true;
}
