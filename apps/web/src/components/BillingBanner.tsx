/**
 * Top-of-page banner reflecting the active org's billingStatus.
 *
 * Renders nothing for "active" / "free". For other states, shows a
 * one-line message + the most actionable next step:
 *   - trialing   → countdown ("X days left in trial") + Settings → Billing link
 *   - past_due   → "Update payment" → portal-session
 *   - suspended  → "Subscribe now" → Settings → Billing
 *   - canceled   → "Subscribe again" → Settings → Billing
 *
 * The banner reads `me.orgs[0]` — the SPA still keys off the first
 * org everywhere; multi-org switching is a deferred concern. Once
 * that lands, this component can take an explicit `orgId` prop.
 */

import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { billingSeverity, trialDaysLeft } from "../lib/billing";

export function BillingBanner() {
  const { me } = useAuth();
  const org = me?.orgs[0];
  if (!org) return null;

  const severity = billingSeverity(org.billingStatus);
  if (severity === "none") return null;

  const styles = severityStyles(severity);
  const content = renderContent(org.billingStatus, org.trialEndsAt);
  if (!content) return null;

  return (
    <div className={`border-b ${styles}`} role="status">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-2 text-sm">
        <span>{content.message}</span>
        {content.cta && (
          <Link
            to={content.cta.to}
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            {content.cta.label}
          </Link>
        )}
      </div>
    </div>
  );
}

function severityStyles(severity: "info" | "warning" | "critical"): string {
  switch (severity) {
    case "info":
      return "border-slate-200 bg-slate-50 text-slate-800";
    case "warning":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "critical":
      return "border-red-300 bg-red-50 text-red-900";
  }
}

interface BannerContent {
  message: string;
  cta?: { label: string; to: string };
}

function renderContent(
  billingStatus: string,
  trialEndsAt: string | null
): BannerContent | null {
  switch (billingStatus) {
    case "trialing": {
      const days = trialDaysLeft(trialEndsAt);
      // Past-deadline trial without server-side suspension yet
      // (the trial-expiry sweep isn't wired) — surface the
      // "trial expired" banner so the user is prompted to subscribe.
      if (days === null) {
        return {
          message: "Your trial is active.",
          cta: { label: "Settings → Billing", to: "/settings/billing" },
        };
      }
      if (days <= 0) {
        return {
          message: "Trial ended. Subscribe to keep using PCBviber.",
          cta: { label: "Subscribe", to: "/settings/billing" },
        };
      }
      return {
        message:
          days === 1
            ? "1 day left in your trial."
            : `${days} days left in your trial.`,
        cta: { label: "Subscribe now", to: "/settings/billing" },
      };
    }
    case "past_due":
      return {
        message: "Your last payment failed. Update payment to avoid suspension.",
        cta: { label: "Update payment", to: "/settings/billing" },
      };
    case "suspended":
      return {
        message:
          "Subscription suspended. Subscribe to restore access to Parts Search.",
        cta: { label: "Subscribe", to: "/settings/billing" },
      };
    case "canceled":
      return {
        message: "Subscription canceled. Subscribe again to restore access.",
        cta: { label: "Subscribe again", to: "/settings/billing" },
      };
    default:
      // Unknown status: render as info-style without a CTA. The user
      // is on a server build the SPA doesn't know about; a vague
      // "billing needs attention" with the Settings link prevents
      // silent breakage.
      return {
        message: "Billing needs attention.",
        cta: { label: "Settings → Billing", to: "/settings/billing" },
      };
  }
}
