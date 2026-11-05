// src/platform/local/index.ts
// The local implementation (lesson 08): runs the core on a laptop. Nobody types the
// database password: scripts/local-up.sh generates it, sets it on the login in the
// SQL Server container, and writes it to a file outside the repository.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Platform, SecretCredential } from '../types.ts';

export const LOCAL_SECRET_DIR = process.env.M14_SECRET_DIR ?? join(homedir(), '.config', 'm14-reference');

// One file per secret, holding exactly the value (as a platform secret store would).
async function readSecret(name: string): Promise<string> {
  return readFile(join(LOCAL_SECRET_DIR, name), 'utf8');
}

export const localPlatform: Platform = {
  name: 'local',
  identity: {
    issuer: process.env.OIDC_ISSUER ?? 'http://localhost:8080/default',
    clientId: process.env.OIDC_CLIENT_ID ?? 'm14-local',
    clientSecretName: 'oidc-client',
    scopes: ['openid', 'profile'],
    rolesFrom: (claims) => (Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : []),
  },
  db: {
    target: { server: 'localhost', port: Number(process.env.M14_SQL_PORT ?? 14330), database: 'intake', trustServerCertificate: true },
    auth: {
      kind: 'secret',
      get: async () => JSON.parse(await readSecret('db-app')) as SecretCredential, // this secret's value is JSON
      rotationOwner: 'you (local development)',
      maxAgeDays: 30,
      delivery: 'runtime',
    },
  },
  secrets: { get: readSecret },
  telemetry: {
    // The local collector from scripts/local-up.sh; platforms point this at their own collector.
    start: async (serviceName) => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= 'http://localhost:4318';
      const { startTelemetry } = await import('../../lib/telemetry/start.ts');
      startTelemetry(serviceName);
    },
  },
};
