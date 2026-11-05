// Needs the local identity provider: npm run local:up.
import { describe, it, expect } from 'vitest';
import { clientFor, startLogin, finishLogin } from '../../src/lib/auth/oidc.ts';
import { localPlatform } from '../../src/platform/local/index.ts';

const run = process.env.M14_ENV === '1' ? describe : describe.skip;
const redirectUri = 'http://localhost:3000/auth/callback';

async function signIn(tamper?: (u: URL) => void) {
  const { identity, secrets } = localPlatform;
  const { clientSecret } = JSON.parse(await secrets.get(identity.clientSecretName));
  const config = await clientFor(identity, clientSecret, { allowHttp: true });
  const { url, pending } = await startLogin(config, identity, redirectUri);
  const res = await fetch(url, { redirect: 'manual' });            // the mock signs in without a page
  const callback = new URL(res.headers.get('location')!);
  tamper?.(callback);
  return finishLogin(config, identity, callback, pending);
}

run('sign-in against the local identity provider', () => {
  it('returns the user with roles from the provider, via the seam', async () => {
    expect(await signIn()).toEqual({ sub: 'caseworker-0042', issuer: 'http://localhost:8080/default', name: 'Test Caseworker', roles: ['Intake.Operator'] });
  });
  it('refuses a callback whose state was swapped', async () => {
    await expect(signIn((u) => u.searchParams.set('state', 'forged'))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/unexpected "state"/) },
    });
  });
});
