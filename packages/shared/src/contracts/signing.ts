/**
 * Who has to sign a contract (spec §7.7). Pure functions, shared by the API (which decides) and
 * the dashboard (which explains). The answer comes from the approved version's details, so the
 * signers are exactly the people named in the document that was approved.
 */
import { ADULT_AGE, type SignerRole } from './catalog.js';
import type { ContractSnapshot } from './dto.js';

/** Age in whole years on a date (both YYYY-MM-DD). */
export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y, m, d] = on.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Under 18 on that date. Unknown date of birth → null (callers must not guess). */
export function isMinorOn(dateOfBirth: string | null | undefined, on: string): boolean | null {
  if (!dateOfBirth) return null;
  return ageOn(dateOfBirth, on) < ADULT_AGE;
}

export interface RequiredSigner {
  role: SignerRole;
  /** Order of signing: the guardian's consent step comes after the recipient has signed. */
  order: number;
  nameEn: string | null;
  nameAr: string | null;
  email: string | null;
  phone: string | null;
  relationship: string | null;
}

/**
 * The required signers on a given day: the recipient, plus a parent or guardian when the
 * recipient is under 18 then. Throws a code when the details can't decide it safely.
 */
export function requiredSigners(
  snapshot: ContractSnapshot,
  today: string,
):
  | { minor: boolean; signers: RequiredSigner[] }
  | { error: 'date_of_birth_required' | 'guardian_required' } {
  const r = snapshot.details.recipient;
  const minor = isMinorOn(r.dateOfBirth, today);
  if (minor === null) return { error: 'date_of_birth_required' };
  const signers: RequiredSigner[] = [
    {
      role: 'recipient',
      order: 1,
      nameEn: r.fullNameEn ?? null,
      nameAr: r.fullNameAr ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      relationship: null,
    },
  ];
  if (minor) {
    const g = snapshot.details.guardian;
    if (!g?.fullName || !g.relationship || !(g.email || g.phone))
      return { error: 'guardian_required' };
    signers.push({
      role: 'guardian',
      order: 2,
      nameEn: g.fullName,
      nameAr: g.fullName,
      email: g.email ?? null,
      phone: g.phone ?? null,
      relationship: g.relationship,
    });
  }
  return { minor, signers };
}

/** "f•••@example.com" — enough for the signer to recognise their address, not to harvest it. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '•••';
  return `${user.slice(0, 1)}•••@${domain}`;
}
