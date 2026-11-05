// src/lib/db/connection.ts
// One pool per process, built from the platform's DbAuth (lesson 08).
// The contract this file proves (tests/unit/connection.test.ts, tests/env/rotation.env.test.ts):
//   1. a credential rotation reaches new connections without a restart (runtime delivery);
//   2. the old credential stops working, and the app does not keep retrying it;
//   3. a refresh that still fails is a defined outcome: one retry, then a named error.
import sql from 'mssql';
import type { DbAuth, DbTarget } from '../../platform/types.ts';

/** SQL Server "Login failed for user" (error 18456) surfaces as ELOGIN from the driver. */
export const isLoginFailure = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ELOGIN';

export class CredentialRefreshFailed extends Error {
  constructor(readonly delivery: 'runtime' | 'startup') {
    super(
      delivery === 'startup'
        ? 'database login failed and this platform delivers the credential at startup: redeploy per the rotation runbook'
        : 'database login failed again after fetching the current credential from the secret store',
    );
    this.name = 'CredentialRefreshFailed';
  }
}

async function configFor(target: DbTarget, auth: DbAuth): Promise<sql.config> {
  const base: sql.config = {
    server: target.server,
    database: target.database,
    port: target.port,
    options: { encrypt: true, trustServerCertificate: target.trustServerCertificate ?? false },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  };
  if (auth.kind === 'token') {
    return { ...base, authentication: { type: 'token-credential', options: { credential: auth.credential } } } as sql.config;
  }
  const c = await auth.get();
  return { ...base, user: c.user, password: c.password };
}

export type PoolFactory = (config: sql.config) => Promise<sql.ConnectionPool>;
const defaultFactory: PoolFactory = (config) => new sql.ConnectionPool(config).connect();

export function createConnectionProvider(target: DbTarget, auth: DbAuth, connect: PoolFactory = defaultFactory) {
  let pool: Promise<sql.ConnectionPool> | undefined;

  const open = () => {
    const p = configFor(target, auth).then(connect);
    pool = p.catch((err: unknown) => {
      pool = undefined; // a failed connect is never cached
      throw err;
    });
    return pool;
  };

  async function reset() {
    const old = pool;
    pool = undefined;
    if (old) await old.then((p) => p.close(), () => undefined);
  }

  /** Run a query function; on a login failure, refresh the credential once and retry. */
  async function withPool<T>(fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
    try {
      return await fn(await (pool ?? open()));
    } catch (err) {
      if (!isLoginFailure(err) || auth.kind !== 'secret') throw err;
      if (auth.delivery === 'startup') throw new CredentialRefreshFailed('startup');
      await reset();
      try {
        return await fn(await open());
      } catch (again) {
        if (isLoginFailure(again)) throw new CredentialRefreshFailed('runtime');
        throw again;
      }
    }
  }

  return { withPool, reset };
}
