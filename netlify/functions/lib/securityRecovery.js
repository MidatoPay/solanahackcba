import { fail } from './securityCore.js';

// @privy-io/server-auth 1.32.5 has no server OTP authentication API.
// Keep this closed until a provider adapter has been tested against Privy.
// An adapter must select a verified destination using getUser(DID), send a new
// OTP, and verify that OTP server-side against the same recovery challenge.
// Never accept a client callback, destination, access token refresh or ID token.
export const recoveryAdapter = Object.freeze({
 available:false,
 async start(){throw fail('recovery_unavailable',503);},
 async verify(){throw fail('recovery_unavailable',503);},
});
