// Only names are returned: diagnostics must never print secret values.
export function publicSecretVariables(env) {
  return Object.keys(env).filter(key=>/^VITE_.*(?:SECRET|PRIVATE_KEY|ACCESS_TOKEN|PASSWORD|PG_URL|CA_CERT|PEPPER|RESEND_API_KEY)/i.test(key) && String(env[key] || "").trim());
}
