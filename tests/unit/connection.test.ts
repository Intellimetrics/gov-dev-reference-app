import { describe, it, expect, vi } from 'vitest';
import type sql from 'mssql';
import { createConnectionProvider, CredentialRefreshFailed } from '../../src/lib/db/connection.ts';
import { checkRotation } from '../../src/platform/rotation.ts';
import type { DbAuth } from '../../src/platform/types.ts';

const target = { server: 'db', database: 'intake' };
const loginFailed = () => Object.assign(new Error('Login failed for user'), { code: 'ELOGIN' });

function secretAuth(passwords: string[], delivery: 'runtime' | 'startup' = 'runtime'): DbAuth & { kind: 'secret' } {
  let i = 0;
  return { kind: 'secret', delivery, rotationOwner: 'team', maxAgeDays: 30,
    get: vi.fn(async () => ({ user: 'app_user', password: passwords[Math.min(i++, passwords.length - 1)], rotatedAt: '2026-11-01T00:00:00Z' })) };
}

/** A fake server that accepts exactly one password at a time. */
function fakeServer(accepted: { password: string }) {
  return vi.fn(async (config: sql.config) => {
    const pw = config.password;
    return { close: vi.fn(async () => {}), query: async () => {
      if (pw !== accepted.password) throw loginFailed();
      return 'ok';
    } } as unknown as sql.ConnectionPool;
  });
}
const run = (p: sql.ConnectionPool) => (p as unknown as { query(): Promise<string> }).query();

describe('connection provider: rotation contract', () => {
  it('a rotation reaches the app on the next login failure, with one fresh fetch', async () => {
    const server = { password: 'old' };
    const auth = secretAuth(['old', 'new']);
    const connect = fakeServer(server);
    const db = createConnectionProvider(target, auth, connect);
    expect(await db.withPool(run)).toBe('ok');
    server.password = 'new'; // the rotation job changed the login and the secret
    expect(await db.withPool(run)).toBe('ok');
    expect(auth.get).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('a refresh that still fails is a named error, not a retry loop', async () => {
    const db = createConnectionProvider(target, secretAuth(['old']), fakeServer({ password: 'other' }));
    await expect(db.withPool(run)).rejects.toBeInstanceOf(CredentialRefreshFailed);
  });

  it('startup delivery never refetches: it points at the redeploy runbook', async () => {
    const auth = secretAuth(['old', 'new'], 'startup');
    const db = createConnectionProvider(target, auth, fakeServer({ password: 'new' }));
    await expect(db.withPool(run)).rejects.toThrow(/redeploy per the rotation runbook/);
    expect(auth.get).toHaveBeenCalledTimes(1);
  });

  it('other errors pass through untouched', async () => {
    const connect = vi.fn(async () => ({ close: async () => {}, query: async () => { throw new Error('syntax'); } }) as unknown as sql.ConnectionPool);
    const db = createConnectionProvider(target, secretAuth(['x']), connect);
    await expect(db.withPool(run)).rejects.toThrow('syntax');
  });

  it('a failed connect is not cached', async () => {
    let fail = true;
    const connect = vi.fn(async () => { if (fail) throw new Error('network'); return { close: async () => {}, query: async () => 'ok' } as unknown as sql.ConnectionPool; });
    const db = createConnectionProvider(target, secretAuth(['x']), connect);
    await expect(db.withPool(run)).rejects.toThrow('network');
    fail = false;
    expect(await db.withPool(run)).toBe('ok');
  });

  it('token kind hands the credential to the driver and holds no scope string', async () => {
    const credential = { getToken: vi.fn(async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3e6 })) };
    let seen: sql.config | undefined;
    const connect = vi.fn(async (c: sql.config) => { seen = c; return { close: async () => {}, query: async () => 'ok' } as unknown as sql.ConnectionPool; });
    await createConnectionProvider(target, { kind: 'token', credential }, connect).withPool(run);
    expect(seen?.authentication).toEqual({ type: 'token-credential', options: { credential } });
    expect(seen?.password).toBeUndefined();
    expect(credential.getToken).not.toHaveBeenCalled(); // the driver calls it, with the server's scope
  });
});

describe('rotation age', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  it.each([
    [undefined, false, 'missing'],
    ['not a date', false, 'unparseable'],
    ['2026-11-07T00:00:00Z', false, 'in-the-future'],
    ['2026-09-01T00:00:00Z', false, 'too-old'],
    ['2026-10-20T00:00:00Z', true, undefined],
  ])('%s -> ok=%s', (rotatedAt, ok, reason) => {
    const v = checkRotation(rotatedAt, 30, now);
    expect(v.ok).toBe(ok);
    if (!v.ok) expect(v.reason).toBe(reason);
  });
});

describe('connection provider: concurrent rotation', () => {
  it('ten requests failing at once share one refresh, one new pool, and all succeed', async () => {
    const server = { password: 'old' };
    const auth = secretAuth(['old', 'new']);
    const pools: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const connect = vi.fn(async (config: sql.config) => {
      const pw = config.password;
      const p = { close: vi.fn(async () => {}), query: async () => { if (pw !== server.password) throw loginFailed(); return 'ok'; } };
      pools.push(p);
      return p as unknown as sql.ConnectionPool;
    });
    const db = createConnectionProvider(target, auth, connect);
    expect(await db.withPool(run)).toBe('ok');
    server.password = 'new';
    const results = await Promise.all(Array.from({ length: 10 }, () => db.withPool(run)));
    expect(results).toEqual(Array(10).fill('ok'));
    expect(auth.get).toHaveBeenCalledTimes(2);   // one refresh, not ten
    expect(connect).toHaveBeenCalledTimes(2);    // one new pool, no leaks
    expect(pools[0].close).toHaveBeenCalledTimes(1);
    expect(pools[1].close).not.toHaveBeenCalled();
  });
});
