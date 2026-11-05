// src/platform/rotation.ts
// The rotation-age check for secret-kind database credentials (lesson 08's Prove it).
// It reads only the rotatedAt the rotation job wrote into the secret: metadata evidence
// that rotation happened on schedule. That a rotation actually reaches the app is a
// separate test (tests/env/rotation.env.test.ts).
export type RotationVerdict =
  | { ok: true; ageDays: number }
  | { ok: false; reason: 'missing' | 'unparseable' | 'in-the-future' | 'too-old'; ageDays?: number };

export function checkRotation(rotatedAt: string | undefined, maxAgeDays: number, now = new Date()): RotationVerdict {
  if (!rotatedAt) return { ok: false, reason: 'missing' };
  const t = Date.parse(rotatedAt);
  if (Number.isNaN(t)) return { ok: false, reason: 'unparseable' };
  const ageDays = (now.getTime() - t) / 86_400_000;
  if (ageDays < -1 / 24) return { ok: false, reason: 'in-the-future', ageDays }; // more than an hour of clock skew
  if (ageDays > maxAgeDays) return { ok: false, reason: 'too-old', ageDays };
  return { ok: true, ageDays };
}
