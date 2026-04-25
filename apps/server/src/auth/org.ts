/**
 * Organization auto-creation on signup.
 *
 * Per the internal design spec §3.1:
 *   "On first signup, auto-create an Organization (`users new company`
 *   → org with slug), make the user its owner, start a 14-day Team-plan
 *   trial (no card required)."
 *
 * Trial state lives on Organization (billingStatus + trialEndsAt). The
 * Subscription row is created when checkout completes — until then the
 * trial is "untethered" (no Stripe sub yet, just a deadline). When the
 * trial expires without a payment method the Organization is moved to
 * `suspended` (degradation handled elsewhere).
 */

import { prisma } from "@altium-mcp/db";

/** Trial length on signup. Per spec §3.1, no card required. */
export const TRIAL_DAYS = 14;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Derive a sensible default slug from a free-form org or user input. */
export function deriveSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48); // reserve room for collision suffix
}

/** Best-effort slug from an email — uses the local-part before `@`. */
export function slugFromEmail(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  return deriveSlug(localPart) || "org";
}

/**
 * Find a unique slug starting from `base`. Tries `base`, `base-2`,
 * `base-3`, ... up to N. Returns whichever isn't taken.
 *
 * Race-window: another signup could grab the same slug between this
 * check and the create. The caller should catch `Unique constraint
 * failed` on `Organization.slug` and retry with a fresh suffix.
 */
export async function findAvailableSlug(base: string): Promise<string> {
  const candidate = SLUG_RE.test(base) ? base : "org";
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? candidate : `${candidate}-${i + 1}`;
    const taken = await prisma.organization.findUnique({ where: { slug } });
    if (!taken) return slug;
  }
  // Extremely unlikely; fall back to a random suffix so signup never blocks.
  const rand = Math.random().toString(36).slice(2, 8);
  return `${candidate}-${rand}`;
}

export interface CreateOrgForOwnerOpts {
  userId: string;
  /** Org display name; falls back to "<email-local-part>'s Organization". */
  orgName?: string;
  /** Email used to derive a slug when no orgName is given. */
  email: string;
}

/**
 * Create an Organization, link the user as `owner`, and return both.
 * Wraps everything in a single transaction so a partially-created org
 * (no membership) is impossible.
 */
export async function createOrgForOwner(opts: CreateOrgForOwnerOpts): Promise<{
  orgId: string;
  orgSlug: string;
  orgName: string;
  /** "trialing" — set inline below; expressed in the return so the
   *  signup handler can echo it to the SPA without a re-query. */
  billingStatus: string;
  trialEndsAt: string;
  membershipId: string;
}> {
  const baseSlug = opts.orgName
    ? deriveSlug(opts.orgName) || slugFromEmail(opts.email)
    : slugFromEmail(opts.email);
  const localPart = opts.email.split("@")[0] ?? "user";
  const displayName =
    opts.orgName && opts.orgName.trim().length > 0
      ? opts.orgName.trim()
      : `${localPart}'s Organization`;

  // Up to 3 retries on slug collision — covers the rare race where two
  // signups race to the same derived slug between the lookup and create.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const slug = await findAvailableSlug(baseSlug);
      const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
      const result = await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: {
            name: displayName,
            slug,
            billingStatus: "trialing",
            trialEndsAt,
          },
        });
        const membership = await tx.membership.create({
          data: { orgId: org.id, userId: opts.userId, role: "owner" },
        });
        return { org, membership };
      });
      return {
        orgId: result.org.id,
        orgSlug: result.org.slug,
        orgName: result.org.name,
        billingStatus: result.org.billingStatus,
        trialEndsAt: trialEndsAt.toISOString(),
        membershipId: result.membership.id,
      };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Unique constraint failed/i.test(msg)) throw err;
      // race on slug — retry with a fresh derivation
    }
  }
  throw new Error(
    `failed to create organization after retries: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}
