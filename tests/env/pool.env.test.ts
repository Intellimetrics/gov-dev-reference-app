// Needs the local database: npm run local:up.
import { describe, it, expect } from 'vitest';
import { withPool, closePool } from '../../src/lib/db/pool.ts';

const run = process.env.M14_ENV === '1' ? describe : describe.skip;

run('the one door', () => {
  it('withPool reaches the database through the platform seam', async () => {
    process.env.PLATFORM = 'local';
    const db = await withPool((pool) => pool.request().query('SELECT DB_NAME() AS d').then((r) => r.recordset[0].d));
    expect(db).toBe('intake');
    await closePool();
  });
  it('an unknown PLATFORM fails at startup instead of guessing', async () => {
    process.env.PLATFORM = 'mainframe';
    await expect(withPool(async () => 1)).rejects.toThrow(/PLATFORM must be one of/);
    process.env.PLATFORM = 'local';
  });
});
