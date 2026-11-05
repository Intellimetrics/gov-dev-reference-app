import { readFileSync } from 'node:fs';
import * as oidc from 'openid-client';
import { describe, expect, it } from 'vitest';
import { acrValues, AUTHENTICATOR, IDENTITY, loginGovConfiguration, startPortalLogin } from '../../src/modernization/portal/login-gov.ts';
import { statusFor, toApplicantView, type InternalCase } from '../../src/modernization/portal/status-view.ts';
import { bucket, route } from '../../src/modernization/portal/canary.ts';
import type { Identity } from '../../src/platform/types.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../../fixtures/portal/${f}`, import.meta.url), 'utf8'));
const stub = load('stub-issuer.json');
const cases: InternalCase[] = load('cases.json');
const identity: Identity = { ...stub.identity, clientId: stub.clientId, rolesFrom: () => [] };
const config = new oidc.Configuration(stub.server, stub.clientId);

describe('Login.gov sign-in: the authorization request', () => {
  it('carries acr_values as current values, with PKCE, state and nonce from lesson 03', async () => {
    const { url, pending } = await startPortalLogin(config, identity, 'https://status.example.gov/callback',
      { identity: IDENTITY.verified, authenticator: AUTHENTICATOR.phishingResistant });
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe('https://idp.example.gov/openid_connect/authorize');
    expect(p.get('acr_values')).toBe('urn:acr.login.gov:verified http://idmanagement.gov/ns/assurance/aal/2?phishing_resistant=true');
    expect(p.get('client_id')).toBe(stub.clientId);
    expect(p.get('scope')).toBe('openid email');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe(pending.state);
    expect(p.get('nonce')).toBe(pending.nonce);
  });

  it('sends the identity value alone when no authenticator is asked for', () => {
    expect(acrValues({ identity: IDENTITY.authOnly })).toBe('urn:acr.login.gov:auth-only');
  });

  it('refuses the deprecated ial/* value instead of sending it', async () => {
    const old = 'http://idmanagement.gov/ns/assurance/ial/2' as never;
    expect(() => acrValues({ identity: old })).toThrow(/deprecated/);
    await expect(startPortalLogin(config, identity, 'https://status.example.gov/callback', { identity: old })).rejects.toThrow(/deprecated/);
  });

  it('refuses a value it does not know', () => {
    expect(() => acrValues({ identity: 'urn:acr.login.gov:verified-ish' as never })).toThrow(/not a value this portal sends/);
  });

  it('builds a client that signs its own assertion instead of sending a secret', async () => {
    const { privateKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['sign']);
    const c = loginGovConfiguration(stub.server, stub.clientId, privateKey);
    expect(c.serverMetadata().issuer).toBe('https://idp.example.gov/');
  });
});

describe('applicant view: an allowlist', () => {
  const ada = cases[0];

  it('shows status, last updated date and next step, and nothing else', () => {
    expect(toApplicantView(ada)).toEqual({
      status: 'In review',
      lastUpdated: '2026-11-03',
      nextStep: 'A caseworker is reviewing your application. No action is needed from you.',
    });
  });

  it('does not leak a field added to the internal record tomorrow', () => {
    const planted = { ...ada, reviewerEmail: 'j.rivera@agency.example', fraudWatchlistHit: true, supervisorOverride: 'APPROVE' };
    const view = toApplicantView(planted);
    expect(Object.keys(view).sort()).toEqual(['lastUpdated', 'nextStep', 'status']);
    const text = JSON.stringify(view);
    for (const secret of ['j.rivera', 'fraudWatchlistHit', 'supervisorOverride', 'APPROVE', 'household size', 'sub-ada', 'C-1001']) {
      expect(text).not.toContain(secret);
    }
  });

  it('turns an internal status into public wording, and an unknown one into "In review"', () => {
    const view = toApplicantView(cases[1]);                  // ESCALATED_FRAUD_REVIEW has no public wording
    expect(view.status).toBe('In review');
    expect(JSON.stringify(view)).not.toMatch(/FRAUD|ESCALATED/);
  });

  it('shows a case only to the applicant it belongs to', () => {
    expect(statusFor(cases[0], 'sub-ada')?.status).toBe('In review');
    expect(statusFor(cases[0], 'sub-ben')).toBeUndefined();
    expect(statusFor(undefined, 'sub-ben')).toBeUndefined();
  });
});

describe('canary cutover router', () => {
  const ids = Array.from({ length: 10_000 }, (_, i) => `sub-${i}`);
  const salt = 'status-portal-2026-11';
  const onNext = (pct: number) => ids.filter((id) => route(id, pct, salt) === 'next');

  it('is sticky: the same applicant gets the same answer every time', () => {
    for (const id of ids.slice(0, 500)) expect(route(id, 10, salt)).toBe(route(id, 10, salt));
    expect(bucket('sub-42', salt)).toBe(bucket('sub-42', salt));
  });

  it('only ever adds people as the percentage rises', () => {
    const at5 = new Set(onNext(5));
    const at25 = new Set(onNext(25));
    expect(at5.size).toBeGreaterThan(0);
    for (const id of at5) expect(at25.has(id)).toBe(true);
  });

  it('0 percent sends everyone to legacy and 100 percent sends everyone to next', () => {
    expect(onNext(0)).toHaveLength(0);
    expect(onNext(100)).toHaveLength(ids.length);
  });

  it('splits close to the asked-for share', () => {
    const share = onNext(10).length / ids.length;
    expect(share).toBeGreaterThan(0.09);
    expect(share).toBeLessThan(0.11);
  });

  it('refuses a percentage outside 0..100', () => {
    for (const bad of [-1, 100.5, Number.NaN]) expect(() => route('sub-1', bad, salt)).toThrow(/0\.\.100/);
  });
});
