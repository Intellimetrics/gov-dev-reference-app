// src/lib/db/pool.ts
// The one door to the database (lesson 08). Route handlers and the server code they call
// use withPool(); nothing else imports mssql's pool. One provider per process, cached on
// globalThis because the dev server reloads modules.
import type sql from 'mssql';
import { getPlatform } from '../../platform/index.ts';
import { createConnectionProvider } from './connection.ts';

type Provider = ReturnType<typeof createConnectionProvider>;
const g = globalThis as unknown as { __db?: Promise<Provider> };

function provider(): Promise<Provider> {
  g.__db ??= getPlatform().then((p) => createConnectionProvider(p.db.target, p.db.auth)).catch((err: unknown) => {
    g.__db = undefined; // a failed start is not cached
    throw err;
  });
  return g.__db;
}

export async function withPool<T>(fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  return (await provider()).withPool(fn);
}

export async function closePool(): Promise<void> {
  const p = g.__db;
  g.__db = undefined;
  if (p) await (await p).reset();
}
