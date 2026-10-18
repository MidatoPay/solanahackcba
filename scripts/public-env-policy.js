// Only names are returned: diagnostics must never print secret values.
export function publicSecretVariables(env) {
  return Object.keys(env).filter(key=>/^VITE_.*(?:SECRET|PRIVATE_KEY|ACCESS_TOKEN|API_KEY|DATABASE_URL|PASSWORD|PG_URL|CA_CERT|WEBHOOK_TOKEN)/i.test(key) && String(env[key] || "").trim());
}
