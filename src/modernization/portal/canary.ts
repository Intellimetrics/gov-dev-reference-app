// src/modernization/portal/canary.ts
// Which implementation answers this applicant. A stable hash of the applicant id into 10,000 buckets,
// so the same person gets the same answer on every request, and raising the percentage only ever adds people.
import { createHash } from 'node:crypto';

export type Target = 'legacy' | 'next';
const BUCKETS = 10_000;

export function bucket(applicantId: string, salt: string): number {
  return createHash('sha256').update(`${salt}:${applicantId}`).digest().readUInt32BE(0) % BUCKETS;
}

/** percentNext: 0 sends everyone to legacy (rollback), 100 sends everyone to next. Fractions work: 0.5 is 50 buckets. */
export function route(applicantId: string, percentNext: number, salt: string): Target {
  if (!(percentNext >= 0 && percentNext <= 100)) throw new Error(`percentNext must be 0..100, got ${percentNext}`);
  return bucket(applicantId, salt) < percentNext * (BUCKETS / 100) ? 'next' : 'legacy';
}
