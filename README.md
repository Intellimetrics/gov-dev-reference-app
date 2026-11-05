# Government Dev reference app

This is the runnable code behind **Module 14, AI-Accelerated Government Development**, on [learn.intellimetrics.net](https://learn.intellimetrics.net). Every lesson code block that names a file here is checked against this repository when the site builds, so what you clone is exactly what the lessons quote.

It is a teaching reference, not a product. It is code you read, run and adapt: small pieces, each with tests that pass and a planted fault the lesson walks you through.

## What is here

| Path | What it is | Lessons |
|---|---|---|
| `src/platform/` | The platform seam: one interface for identity, the database credential, secrets and telemetry. It has a `local` implementation for your laptop and `azure`, `aws` and `google` implementations. | 02, 08, 34–36 |
| `src/lib/auth/oidc.ts` | Workforce sign-in with OIDC: authorization code, PKCE, state, nonce and ID-token signature checks. | 03 |
| `src/lib/db/` | One door to SQL Server (`withPool`). A connection provider proves a credential rotation reaches the running app. | 08 |
| `src/lib/telemetry/` | One OpenTelemetry path to a collector, started through the seam. | 16 |
| `scripts/parity/check-referee.mjs` | The referee check: the files that judge an agent's work are owned by teams on GitHub, GitLab, Bitbucket or Azure DevOps. | 25, 37 |
| `scripts/capstone/check-variant.mjs`, `modernization/supported-variants.json` | The capstone's variant registry. The local-exercise and deployment-evidence outcomes are reported separately. | 38 |
| `src/modernization/field-guide/` | Inventory builders for Oracle and Db2 catalogs, Java EE and .NET Framework descriptors, and Access query exports. | 28, 29 |
| `src/modernization/batch/` | Batch parity: an RFC 4180 reader, a keyed record diff, EBCDIC and COMP-3 decoders, and once-only delivery. | 30 |
| `src/modernization/workflow/` | A case-workflow state machine with business-day SLA timers, legacy-history replay and seeded invariants. | 31 |
| `src/modernization/portal/` | A public portal: Login.gov request parameters, an allowlisted applicant view and a sticky canary split. | 32 |
| `src/modernization/reports/` | Report parity: dataset equivalence on SQL Server, the `SELECT *` view trap and an RDL dataset extractor. | 33 |
| `deploy/aws`, `deploy/google` | OpenTelemetry collector configurations for X-Ray and Cloud Trace. | 35, 36 |
| `fixtures/` | Committed fixtures, all synthetic: catalog snapshots, descriptors, export files and case histories. | 28–33 |

## Run it

You need Node 22 or later and a container runtime (Docker or an approved equivalent).

```bash
npm install
npm test                  # unit tests, no services needed
npm run local:up          # SQL Server, a mock OIDC provider and an OpenTelemetry collector, on 127.0.0.1 only
export M14_SECRET_DIR="$HOME/.config/m14-reference"
npm run test:env          # tests against those containers: rotation, sign-in, telemetry, reports, batch
npm run local:down        # removes the containers and the generated secrets
```

Optional checks:

- `npm run test:aws-env` runs the AWS adapter against [LocalStack](https://github.com/localstack/localstack) Secrets Manager (`docker run -d --name m14-localstack -p 127.0.0.1:4566:4566 -e SERVICES=secretsmanager localstack/localstack:4.9`).
- `npm run validate:collectors` validates both collector configurations with `otelcol-contrib`.
- `npm run typecheck` typechecks everything, including the cloud adapters.

`local:up` generates every password into `~/.config/m14-reference` (or `$M14_SECRET_DIR`) with owner-only permissions. Nothing is typed, and nothing is written inside the repository.

## What it does not prove

The cloud adapters (`src/platform/azure`, `aws` and `google`) and the deploy scripts in the lessons are typechecked. They have not been run against a real Azure Government, AWS GovCloud or Google Assured Workloads account. Each platform lesson lists those checks as NOT RUN, with the steps to run them in your own subscription. Service availability and authorization inside a government boundary change over time, so recheck them against the provider's current documentation and your agency's authorization before you rely on them.

## Where it comes from

This repository is published from the course's source, so changes are made there and published here. Issues and corrections are welcome.
