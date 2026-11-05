// src/platform/google/index.ts
// Google Cloud (Assured Workloads) implementation of the seam (lesson 36). The app runs on
// Cloud Run with a service account. Cloud SQL for SQL Server has no IAM database login,
// so the database credential is a secret in Secret Manager. Google runs no managed
// rotation for it: your rotation job sets the new password and adds a secret version
// whose value carries rotatedAt.
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { Platform, SecretCredential } from '../types.ts';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const project = need('GOOGLE_CLOUD_PROJECT');
const sm = new SecretManagerServiceClient(); // the Cloud Run service account; needs roles/secretmanager.secretAccessor

async function latest(name: string): Promise<string> {
  const [v] = await sm.accessSecretVersion({ name: `projects/${project}/secrets/${name}/versions/latest` });
  const data = v.payload?.data;
  if (!data) throw new Error(`secret ${name} has no value`);
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}

export const googlePlatform: Platform = {
  name: 'google',
  identity: {
    issuer: need('OIDC_ISSUER'),
    clientId: need('OIDC_CLIENT_ID'),
    clientSecretName: need('OIDC_CLIENT_SECRET_NAME'),
    scopes: ['openid', 'profile'],
    rolesFrom: (claims) => (Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : []),
  },
  db: {
    // Through the Cloud SQL private IP; the instance's server certificate is checked (encrypt: true).
    target: { server: need('CLOUD_SQL_HOST'), database: need('CLOUD_SQL_DATABASE') },
    auth: {
      kind: 'secret',
      get: async () => JSON.parse(await latest(need('DB_SECRET_NAME'))) as SecretCredential, // { user, password, rotatedAt }
      rotationOwner: need('ROTATION_OWNER'),
      maxAgeDays: Number(process.env.ROTATION_MAX_AGE_DAYS ?? 30),
      delivery: 'runtime', // read through the API at connect time; an env-var secret would be 'startup'
    },
  },
  secrets: { get: latest },
  telemetry: {
    // OTLP to a collector; its config exports to Cloud Trace (check the IL4 list first: lesson 36).
    start: async (serviceName) => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= 'http://localhost:4318';
      const { startTelemetry } = await import('../../lib/telemetry/start.ts');
      startTelemetry(serviceName);
    },
  },
};
