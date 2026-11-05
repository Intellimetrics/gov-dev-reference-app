// Needs LocalStack (Secrets Manager only): docker run -d --name m14-localstack -p 127.0.0.1:4566:4566 -e SERVICES=secretsmanager localstack/localstack:4.9
// It proves the AWS adapter's reading of the secret, not GovCloud itself: that is lesson 35's NOT RUN check.
import { describe, it, expect, beforeAll } from 'vitest';
import { SecretsManagerClient, CreateSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const run = process.env.M14_AWS_ENV === '1' ? describe : describe.skip;
const env = {
  AWS_REGION: 'us-gov-west-1', AWS_ENDPOINT_URL: 'http://localhost:4566', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
  OIDC_ISSUER: 'https://idp.example.gov', OIDC_CLIENT_ID: 'intake', OIDC_CLIENT_SECRET_ID: 'intake/oidc-client',
  RDS_ENDPOINT: 'intake.example.us-gov-west-1.rds.amazonaws.com', RDS_DATABASE: 'intake', RDS_SECRET_ID: `intake/db-${Date.now()}`,
  ROTATION_OWNER: 'intake-platform-team',
};

run('AWS adapter against Secrets Manager (LocalStack)', () => {
  beforeAll(() => Object.assign(process.env, env));
  it('reads the RDS-shaped secret and takes rotatedAt from the version, then sees a rotation', async () => {
    const sm = new SecretsManagerClient({});
    await sm.send(new CreateSecretCommand({ Name: env.RDS_SECRET_ID, SecretString: JSON.stringify({ engine: 'sqlserver', username: 'app_user', password: 'first-Aa1!' }) }));
    const { awsPlatform } = await import('../../src/platform/aws/index.ts');
    if (awsPlatform.db.auth.kind !== 'secret') throw new Error('expected secret');
    const a = await awsPlatform.db.auth.get();
    expect(a).toMatchObject({ user: 'app_user', password: 'first-Aa1!' });
    await new Promise((r) => setTimeout(r, 1100));
    await sm.send(new PutSecretValueCommand({ SecretId: env.RDS_SECRET_ID, SecretString: JSON.stringify({ engine: 'sqlserver', username: 'app_user', password: 'second-Aa1!' }) }));
    const b = await awsPlatform.db.auth.get();
    expect(b.password).toBe('second-Aa1!');
    expect(Date.parse(b.rotatedAt)).toBeGreaterThan(Date.parse(a.rotatedAt)); // the new version's CreatedDate
    expect(awsPlatform.db.auth.delivery).toBe('runtime');
  });
});
