// Needs the local database: npm run local:up (then npm run local:down).
import { describe, it, expect } from 'vitest';
import sql from 'mssql';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnectionProvider } from '../../src/lib/db/connection.ts';
import { localPlatform, LOCAL_SECRET_DIR } from '../../src/platform/local/index.ts';
import { checkRotation } from '../../src/platform/rotation.ts';

const run = process.env.M14_ENV === '1' ? describe : describe.skip;
const secret = () => JSON.parse(readFileSync(join(LOCAL_SECRET_DIR, 'db-app.json'), 'utf8'));
const asSa = (q: string) => execFileSync('docker', ['exec', 'm14-sql', '/opt/mssql-tools18/bin/sqlcmd', '-C', '-b', '-S', 'localhost', '-U', 'sa',
  '-P', readFileSync(join(LOCAL_SECRET_DIR, 'sa.txt'), 'utf8'), '-Q', q], { encoding: 'utf8' });
const who = (p: sql.ConnectionPool) => p.request().query('SELECT SUSER_SNAME() AS u').then((r) => r.recordset[0].u as string);

run('rotation reaches the running app (local SQL Server)', () => {
  it('rotates, recovers on the next new connection, and the old password is refused', async () => {
    const { target } = localPlatform.db;
    const base = localPlatform.db.auth;
    if (base.kind !== 'secret') throw new Error('local platform uses a secret');
    let fetches = 0;
    const auth = { ...base, get: () => { fetches++; return base.get(); } };
    const db = createConnectionProvider(target, auth);
    expect(await db.withPool(who)).toBe('app_user');
    const before = secret();

    execFileSync('bash', ['scripts/rotate-local.sh'], { stdio: 'pipe' });
    // Force the pool to need a new connection, as an idle timeout or failover would.
    asSa("DECLARE @k nvarchar(max)=''; SELECT @k += 'KILL ' + CAST(session_id AS varchar) + ';' FROM sys.dm_exec_sessions WHERE login_name='app_user'; EXEC(@k);");

    expect(await db.withPool(who)).toBe('app_user');              // recovered without a restart
    expect(fetches).toBe(2);                                        // by fetching the rotated secret once
    expect(checkRotation(secret().rotatedAt, auth.maxAgeDays).ok).toBe(true);

    const old = new sql.ConnectionPool({ server: target.server, port: target.port, database: target.database, user: before.user,
      password: before.password, options: { encrypt: true, trustServerCertificate: true } });
    await expect(old.connect()).rejects.toMatchObject({ code: 'ELOGIN' }); // the old credential is dead
    await db.reset();
  }, 60_000);
});
