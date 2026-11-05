// src/modernization/portal/status-view.ts
// What the public status page may show. An allowlist: the view is built field by field from
// the internal record, so a column added to the record tomorrow cannot reach the applicant.
export interface InternalCase {
  caseId: string;
  applicantSub: string;        // the sign-in subject; the only link between a person and a case
  status: string;              // internal vocabulary, e.g. ESCALATED_FRAUD_REVIEW
  updatedAt: string;           // ISO 8601, UTC
  [field: string]: unknown;    // assignedTo, score, notes, flags ... everything staff-side
}

export interface ApplicantView { status: string; lastUpdated: string; nextStep: string }

// Public wording lives here, written by a person. Internal status codes and staff free text never pass through.
const PUBLIC: Record<string, { status: string; nextStep: string }> = {
  RECEIVED: { status: 'Received', nextStep: 'We will review your application. No action is needed from you.' },
  IN_REVIEW: { status: 'In review', nextStep: 'A caseworker is reviewing your application. No action is needed from you.' },
  NEEDS_DOCUMENTS: { status: 'We need more information', nextStep: 'Upload the documents listed in your notice.' },
  DECIDED: { status: 'Decision made', nextStep: 'Your decision notice has been mailed to you.' },
};
const FALLBACK = PUBLIC.IN_REVIEW;   // an internal status with no public wording reads as "in review", never as itself

export function toApplicantView(record: InternalCase): ApplicantView {
  const words = PUBLIC[record.status] ?? FALLBACK;
  return { status: words.status, lastUpdated: record.updatedAt.slice(0, 10), nextStep: words.nextStep };
}

/** The signed-in applicant sees their own case or nothing; the caller cannot tell "not yours" from "no such case". */
export function statusFor(record: InternalCase | undefined, sub: string): ApplicantView | undefined {
  return record && record.applicantSub === sub ? toApplicantView(record) : undefined;
}
