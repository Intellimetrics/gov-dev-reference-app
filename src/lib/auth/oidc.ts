// src/lib/auth/oidc.ts
// Workforce sign-in against the identity provider of record (lesson 03): authorization
// code with PKCE, state and nonce, as a confidential client. The provider comes from
// the platform seam; this file never names a vendor. Lesson 34 points it at Entra ID in
// Azure Government, 35 at the agency IdP behind AWS, 36 at Google or the agency IdP.
import * as oidc from 'openid-client';
import type { Identity } from '../../platform/types.ts';

export interface PendingLogin { verifier: string; state: string; nonce: string }
export interface SignedInUser { sub: string; issuer: string; name: string; roles: string[] }

export async function clientFor(identity: Identity, clientSecret: string, opts: { allowHttp?: boolean } = {}) {
  // enableNonRepudiationChecks: verify the ID token's signature against the provider's
  // published keys, not only trust the TLS connection it arrived on. allowHttp: local issuer only.
  const execute = [oidc.enableNonRepudiationChecks, ...(opts.allowHttp ? [oidc.allowInsecureRequests] : [])];
  return oidc.discovery(new URL(identity.issuer), identity.clientId, clientSecret, undefined, { execute });
}

export async function startLogin(config: oidc.Configuration, identity: Identity, redirectUri: string) {
  const verifier = oidc.randomPKCECodeVerifier();
  const pending: PendingLogin = { verifier, state: oidc.randomState(), nonce: oidc.randomNonce() };
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: identity.scopes.join(' '),
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state: pending.state,
    nonce: pending.nonce,
  });
  return { url, pending };
}

/** Redeems the code. The library checks state, PKCE, nonce, issuer, audience, expiry and (see clientFor) the ID token signature. */
export async function finishLogin(config: oidc.Configuration, identity: Identity, callbackUrl: URL, pending: PendingLogin): Promise<SignedInUser> {
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('no ID token');
  return {
    sub: claims.sub,
    issuer: claims.iss,
    name: typeof claims.name === 'string' ? claims.name : '',
    roles: identity.rolesFrom(claims),
  };
}
