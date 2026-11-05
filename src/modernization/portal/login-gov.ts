// src/modernization/portal/login-gov.ts
// The public sign-in for the case-status portal: lesson 03's authorization-code flow
// (startLogin: PKCE, state, nonce) plus the two things Login.gov adds, the acr_values parameter and prompt=select_account.
// Values are the current ones only; the old ial/* and loa/* values are refused, not passed through.
import * as oidc from 'openid-client';
import { startLogin } from '../../lib/auth/oidc.ts';
import type { Identity } from '../../platform/types.ts';

/** Identity-proofing level asked for. Service-level URNs. */
export const IDENTITY = {
  authOnly: 'urn:acr.login.gov:auth-only',
  verified: 'urn:acr.login.gov:verified',
  verifiedFacialMatchRequired: 'urn:acr.login.gov:verified-facial-match-required',
  verifiedFacialMatchPreferred: 'urn:acr.login.gov:verified-facial-match-preferred',
} as const;

/** Authentication strength asked for. Omit it and the default still requires a second factor. */
export const AUTHENTICATOR = {
  aal2: 'http://idmanagement.gov/ns/assurance/aal/2',
  phishingResistant: 'http://idmanagement.gov/ns/assurance/aal/2?phishing_resistant=true',
  hspd12: 'http://idmanagement.gov/ns/assurance/aal/2?hspd12=true',                 // requires a PIV/CAC credential
} as const;

const KNOWN = new Set<string>([...Object.values(IDENTITY), ...Object.values(AUTHENTICATOR)]);

export interface AssuranceRequest {
  identity: (typeof IDENTITY)[keyof typeof IDENTITY];
  authenticator?: (typeof AUTHENTICATOR)[keyof typeof AUTHENTICATOR];
}

/** The acr_values string: values separated by a space. Anything not in the two tables above is refused. */
export function acrValues(request: AssuranceRequest): string {
  const values = [request.identity, ...(request.authenticator ? [request.authenticator] : [])];
  for (const v of values) {
    if (/\/(ial|loa)\//.test(v)) throw new Error(`acr_values: ${v} is a deprecated value`);
    if (!KNOWN.has(v)) throw new Error(`acr_values: ${v} is not a value this portal sends`);
  }
  return values.join(' ');
}

export async function startPortalLogin(config: oidc.Configuration, identity: Identity, redirectUri: string, request: AssuranceRequest) {
  const acr = acrValues(request);                    // refuse before any state is created
  const { url, pending } = await startLogin(config, identity, redirectUri);
  url.searchParams.set('acr_values', acr);
  url.searchParams.set('prompt', 'select_account');   // Login.gov: required, and it must be this value
  return { url, pending };
}

/** Login.gov wants a signed assertion from the web app, not a client secret in the request (private_key_jwt). */
export function loginGovConfiguration(server: oidc.ServerMetadata, clientId: string, privateKey: CryptoKey) {
  return new oidc.Configuration(server, clientId, undefined, oidc.PrivateKeyJwt(privateKey));
}
