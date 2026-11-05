// src/platform/azure/index.ts
// Azure Government implementation of the seam (lesson 34). The app runs on App Service
// with a managed identity, so the database credential is a token and no password exists.
import { DefaultAzureCredential, ManagedIdentityCredential, AzureAuthorityHosts } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import type { Platform } from '../types.ts';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

// App Service: the managed identity (AZURE_CLIENT_ID only for a user-assigned one).
// A laptop: your own Azure CLI sign-in, pointed at the Government sign-in host.
const credential = process.env.NODE_ENV === 'production'
  ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID ? { clientId: process.env.AZURE_CLIENT_ID } : {})
  : new DefaultAzureCredential({ authorityHost: AzureAuthorityHosts.AzureGovernment });

const vault = new SecretClient(`https://${need('KEY_VAULT_NAME')}.vault.usgovcloudapi.net`, credential);

export const azurePlatform: Platform = {
  name: 'azure',
  identity: {
    issuer: `https://login.microsoftonline.us/${need('ENTRA_TENANT_ID')}/v2.0`,
    clientId: need('ENTRA_CLIENT_ID'),
    clientSecretName: 'entra-client-secret',
    scopes: ['openid', 'profile'],
    // Entra app roles arrive in the `roles` claim, as the values defined on the app registration.
    rolesFrom: (claims) => (Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : []),
  },
  db: {
    target: { server: need('AZURE_SQL_SERVER'), database: need('AZURE_SQL_DATABASE') },
    // The driver asks Azure SQL for the token scope; no scope string here.
    auth: { kind: 'token', credential },
  },
  secrets: {
    get: async (name) => {
      const s = await vault.getSecret(name);
      if (s.value === undefined) throw new Error(`secret ${name} has no value`);
      return s.value;
    },
  },
  telemetry: {
    // Azure Monitor takes the Microsoft OpenTelemetry Distro in process; the connection
    // string's endpoint suffix routes it to the Government ingestion host.
    start: async (serviceName) => {
      process.env.OTEL_SERVICE_NAME ??= serviceName; // the distro reads the standard variable
      const { useMicrosoftOpenTelemetry } = await import('@microsoft/opentelemetry');
      useMicrosoftOpenTelemetry({
        azureMonitor: { azureMonitorExporterOptions: { connectionString: need('APPLICATIONINSIGHTS_CONNECTION_STRING'), credential } },
      });
    },
  },
};
