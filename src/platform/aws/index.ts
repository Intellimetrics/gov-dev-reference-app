// src/platform/aws/index.ts
// AWS GovCloud (US) implementation of the seam (lesson 35). The app runs on ECS Fargate
// with a task role. RDS for SQL Server has no IAM database login, so the database
// credential is a secret: Secrets Manager holds it and its managed rotation replaces it.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { Platform, SecretCredential } from '../types.ts';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

// The task role supplies credentials; AWS_REGION is us-gov-west-1 or us-gov-east-1.
// useFipsEndpoint: GovCloud workloads under FIPS requirements call the -fips endpoints.
const sm = new SecretsManagerClient({ region: need('AWS_REGION'), useFipsEndpoint: process.env.AWS_USE_FIPS_ENDPOINT === 'true' });

async function secretValue(id: string) {
  const out = await sm.send(new GetSecretValueCommand({ SecretId: id }));
  if (out.SecretString === undefined) throw new Error(`secret ${id} has no string value`);
  return out;
}

export const awsPlatform: Platform = {
  name: 'aws',
  identity: {
    // The agency's identity provider of record; the app runs the OIDC flow itself (lesson 03).
    issuer: need('OIDC_ISSUER'),
    clientId: need('OIDC_CLIENT_ID'),
    clientSecretName: need('OIDC_CLIENT_SECRET_ID'),
    scopes: ['openid', 'profile'],
    // Which claim carries roles depends on the provider; this reference expects `roles`.
    rolesFrom: (claims) => (Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : []),
  },
  db: {
    target: { server: need('RDS_ENDPOINT'), database: need('RDS_DATABASE') },
    auth: {
      kind: 'secret',
      // The RDS rotation function writes { username, password, ... }; the version's
      // CreatedDate is when that rotation happened, so no extra permission is needed.
      get: async (): Promise<SecretCredential> => {
        const out = await secretValue(need('RDS_SECRET_ID'));
        const v = JSON.parse(out.SecretString!) as { username: string; password: string };
        return { user: v.username, password: v.password, rotatedAt: (out.CreatedDate ?? new Date(0)).toISOString() };
      },
      rotationOwner: need('ROTATION_OWNER'),
      maxAgeDays: Number(process.env.ROTATION_MAX_AGE_DAYS ?? 30),
      delivery: 'runtime', // fetched by the app with GetSecretValue, not injected into the task definition
    },
  },
  secrets: { get: async (name) => (await secretValue(name)).SecretString! },
  telemetry: {
    // OTLP to the collector sidecar in the same task; its config exports traces to X-Ray.
    start: async (serviceName) => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= 'http://localhost:4318';
      const { startTelemetry } = await import('../../lib/telemetry/start.ts');
      startTelemetry(serviceName);
    },
  },
};
