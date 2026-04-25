/**
 * Settings → Billing.
 *
 * Three states the page renders:
 *
 *   1. No subscription yet (free / trialing / canceled / suspended) →
 *      Plan picker + "Subscribe" button → checkout-session redirect
 *      to Stripe-hosted Checkout
 *
 *   2. Active subscription (active / past_due) → "Manage billing"
 *      button → portal-session redirect to Stripe Customer Portal
 *      where the user can switch plans, change seats, update payment,
 *      cancel
 *
 *   3. Plans not configured server-side → "Billing isn't configured"
 *      message with no CTA. Dev environments without Stripe env
 *      vars set land here.
 *
 * After Stripe redirects back, the SPA's /me query refetches on
 * mount and the page re-renders with the new billingStatus. The
 * webhook handler may take a few seconds to apply state — the
 * page reads /me, not Stripe, so a slight delay is normal.
 */

import { useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  billingErrorMessage,
  trialDaysLeft,
  useBillingPlans,
  useCreateCheckoutSession,
  useCreatePortalSession,
} from "../../lib/billing";

export function BillingSettingsPage() {
  const { me } = useAuth();
  const orgId = me?.orgs[0]?.id;
  const role = me?.orgs[0]?.role;
  const billingStatus = me?.orgs[0]?.billingStatus ?? "free";
  const trialEndsAt = me?.orgs[0]?.trialEndsAt ?? null;
  const isOwner = role === "owner";

  const plansQ = useBillingPlans();

  if (!me || !orgId) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  const hasActiveSub = billingStatus === "active" || billingStatus === "past_due";

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-lg font-semibold">Billing</h2>
        <p className="mt-1 text-sm text-slate-600">
          {hasActiveSub
            ? "Your organization is on a paid plan. Use Stripe Customer Portal to switch plans, change seats, update payment, or cancel."
            : "Subscribe to enable Parts Search and the rest of PCBviber for your organization."}
        </p>
      </header>

      <StatusCard billingStatus={billingStatus} trialEndsAt={trialEndsAt} />

      {!isOwner && (
        <p className="text-sm text-slate-500">
          Only the org owner can change billing.
        </p>
      )}

      {isOwner && hasActiveSub && (
        <ManageBillingPane orgId={orgId} />
      )}

      {isOwner && !hasActiveSub && (
        <SubscribePane
          orgId={orgId}
          plansLoading={plansQ.isLoading}
          plansError={plansQ.error}
          plans={plansQ.data ?? []}
        />
      )}
    </div>
  );
}

// ─── Subviews ────────────────────────────────────────────────────────

function StatusCard({
  billingStatus,
  trialEndsAt,
}: {
  billingStatus: string;
  trialEndsAt: string | null;
}) {
  const days = trialDaysLeft(trialEndsAt);
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Status
      </p>
      <p className="mt-2 font-medium">
        <span
          className={[
            "inline-block rounded-full px-2 py-0.5 text-xs",
            statusBadgeClass(billingStatus),
          ].join(" ")}
        >
          {billingStatus}
        </span>
      </p>
      {billingStatus === "trialing" && days !== null && days > 0 && (
        <p className="mt-2 text-sm text-slate-600">
          {days === 1 ? "1 day left" : `${days} days left`} in your trial.
        </p>
      )}
      {billingStatus === "past_due" && (
        <p className="mt-2 text-sm text-amber-800">
          Stripe is retrying the last payment. Update your payment method
          via Manage billing to avoid suspension.
        </p>
      )}
      {billingStatus === "suspended" && (
        <p className="mt-2 text-sm text-red-800">
          Tools are blocked until you subscribe. Existing data is preserved.
        </p>
      )}
      {billingStatus === "canceled" && (
        <p className="mt-2 text-sm text-red-800">
          Subscription was canceled. Subscribe again to restore access.
        </p>
      )}
    </section>
  );
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-100 text-emerald-800";
    case "trialing":
      return "bg-slate-100 text-slate-800";
    case "past_due":
      return "bg-amber-100 text-amber-800";
    case "suspended":
    case "canceled":
      return "bg-red-100 text-red-800";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function ManageBillingPane({ orgId }: { orgId: string }) {
  const portal = useCreatePortalSession(orgId);
  return (
    <section>
      <button
        onClick={async () => {
          try {
            const res = await portal.mutateAsync();
            // Stripe-hosted Customer Portal URL — full-page redirect.
            // The page won't unmount cleanly; React Query cleanup
            // doesn't matter because the navigation discards JS state.
            window.location.href = res.url;
          } catch {
            /* error rendered below */
          }
        }}
        disabled={portal.isPending}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {portal.isPending ? "Opening…" : "Manage billing"}
      </button>
      {portal.error && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {billingErrorMessage(portal.error)}
        </p>
      )}
    </section>
  );
}

function SubscribePane({
  orgId,
  plansLoading,
  plansError,
  plans,
}: {
  orgId: string;
  plansLoading: boolean;
  plansError: unknown;
  plans: { name: string; priceId: string; label: string }[];
}) {
  const [selectedPriceId, setSelectedPriceId] = useState<string | null>(
    plans[0]?.priceId ?? null
  );
  const [seats, setSeats] = useState(1);
  const checkout = useCreateCheckoutSession(orgId);

  if (plansLoading) {
    return <p className="text-sm text-slate-500">Loading plans…</p>;
  }
  if (plansError) {
    return (
      <p className="text-sm text-red-600">
        {billingErrorMessage(plansError)}
      </p>
    );
  }
  if (plans.length === 0) {
    return (
      <section className="rounded-lg border border-slate-200 bg-slate-50 p-5">
        <p className="text-sm text-slate-700">
          Billing isn't configured for this environment.
        </p>
      </section>
    );
  }

  // Default the radio to the first plan if state is still null after
  // plans load.
  const effectivePriceId = selectedPriceId ?? plans[0].priceId;

  return (
    <section className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Pick a plan
        </p>
        <div className="mt-2 space-y-2">
          {plans.map((p) => (
            <label
              key={p.priceId}
              className="flex cursor-pointer items-center gap-2 rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
            >
              <input
                type="radio"
                name="plan"
                value={p.priceId}
                checked={effectivePriceId === p.priceId}
                onChange={() => setSelectedPriceId(p.priceId)}
              />
              <span className="font-medium">{p.label}</span>
              <span className="ml-auto font-mono text-xs text-slate-500">
                {p.name}
              </span>
            </label>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="block text-sm font-medium text-slate-700">Seats</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={seats}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            setSeats(Number.isFinite(n) && n > 0 ? n : 1);
          }}
          className="mt-1 w-32 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
      </label>

      <div>
        <button
          onClick={async () => {
            try {
              const res = await checkout.mutateAsync({
                priceId: effectivePriceId,
                seats,
              });
              // Full-page redirect to Stripe-hosted Checkout. The
              // server-side checkout-session config sends Stripe's
              // success_url + cancel_url back to /settings/billing,
              // so the user lands here regardless of outcome.
              window.location.href = res.url;
            } catch {
              /* error rendered below */
            }
          }}
          disabled={checkout.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {checkout.isPending ? "Opening Checkout…" : "Subscribe"}
        </button>
        {checkout.error && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {billingErrorMessage(checkout.error)}
          </p>
        )}
      </div>
    </section>
  );
}
