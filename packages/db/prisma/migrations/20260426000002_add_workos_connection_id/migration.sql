-- Sprint 7 PR 7.3: SAML/OIDC via WorkOS — per-org connection id.
--
-- Each Organization can be linked to a WorkOS SSO connection (a
-- specific IdP — Okta, Azure AD, etc. — set up in the WorkOS
-- dashboard). When set, the /api/auth/sso/start route uses this
-- connection id to construct the WorkOS authorization URL.
--
-- Nullable: most orgs won't have SSO configured. The login UI hides
-- the "Sign in with SSO" path when the queried org has no
-- workosConnectionId set.

ALTER TABLE "Organization" ADD COLUMN "workosConnectionId" TEXT;

