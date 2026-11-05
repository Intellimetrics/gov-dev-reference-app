// src/platform/types.ts
// The platform seam (Module 14, lessons 03, 05, 08, 16). Core code imports only these
// types and getPlatform(); each platform lesson (34 Azure, 35 AWS, 36 Google) supplies
// one implementation, and lesson 08's local implementation runs on a laptop.

/** Claims from a verified ID token or a verified proxy assertion. */
export type Claims = Record<string, unknown>;

export interface Identity {
  /** OIDC discovery issuer of the identity provider of record. */
  issuer: string;
  clientId: string;
  /** Name of the secret holding the client secret; never the secret itself. */
  clientSecretName: string;
  scopes: string[];
  /** The raw role names this provider puts in its tokens. Lesson 05 maps them to the closed set. */
  rolesFrom(claims: Claims): string[];
}

/** Something that hands out short-lived access tokens (shape of @azure/identity's TokenCredential). */
export interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

export interface SecretCredential {
  user: string;
  password: string;
  /** Written by the rotation job into the secret itself, so the app needs no extra permission to read it. */
  rotatedAt: string;
}

export type DbAuth =
  | {
      kind: 'token';
      /** Passed to the driver; the driver asks the server which scope to use. No scope string in app code. */
      credential: TokenCredentialLike;
    }
  | {
      kind: 'secret';
      /** Fetches the current credential from the platform's secret store. */
      get(): Promise<SecretCredential>;
      /** A named owner, e.g. a team mailbox, who answers for rotation. */
      rotationOwner: string;
      maxAgeDays: number;
      /**
       * 'runtime': the app can fetch a fresh copy after a rotation.
       * 'startup': the platform injects it once when the container starts, so a
       * rotation reaches the app only through a redeploy (the runbook says who does it).
       */
      delivery: 'runtime' | 'startup';
    };

export interface DbTarget {
  server: string;
  database: string;
  port?: number;
  /** Local development only: accept the container's self-signed certificate. */
  trustServerCertificate?: boolean;
}

export interface Platform {
  name: 'local' | 'azure' | 'aws' | 'google';
  identity: Identity;
  db: { target: DbTarget; auth: DbAuth };
  secrets: { get(name: string): Promise<string> };
  telemetry: { start(serviceName: string): Promise<void> };
}
