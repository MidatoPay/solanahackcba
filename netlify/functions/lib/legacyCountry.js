// A Colombia deployment cannot enter legacy Argentine financial/data handlers,
// even if old environment variables are accidentally present on the host.
export function guardLegacyHandler(handler) {
  return async (event, context) => {
    if (process.env.APP_COUNTRY === 'CO') return { statusCode: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'legacy_country_endpoint_disabled' }) };
    return handler(event, context);
  };
}
