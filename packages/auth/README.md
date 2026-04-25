# @altium-mcp/auth

Authentication primitives and pluggable providers for the Altium-MCP
SaaS. Owns password hashing, session sealing, and the `AuthProvider`
abstraction that lets us ship without a real WorkOS tenant and swap it
in later without touching server code.

## What lives here

- **`provider.ts`** — the `AuthProvider` interface. One seam the server
  codes against.
- **`local.ts`** — `LocalDevAuthProvider`. DB-backed, passwords hashed
  with Node's built-in `scrypt`, sessions are signed JWTs. Real enough
  for integration tests and early dev; not for production.
- **`workos.ts`** — `WorkOSAuthProvider`. Wraps `@workos-inc/node`
  AuthKit. Used in staging and production.
- **`factory.ts`** — `selectAuthProvider()`. Env-gated — returns the
  WorkOS provider when `WORKOS_API_KEY` is set, otherwise the local one.
- **`password.ts`** — scrypt wrappers with a versioned wire format.
- **`session.ts`** — JWT sign/verify with HS256, signing key from
  `WORKOS_COOKIE_PASSWORD`.
- **`types.ts`** — shared types: `Role`, `AuthUser`, `Session`,
  `SignupInput`, `LoginInput`.

## How the two providers stay compatible

Both write to the same `User` and (via the server) `Organization` rows in
`@altium-mcp/db`. The difference:

- **Local**: passwords stored on the `User` row (scrypt hash); session is
  a local JWT.
- **WorkOS**: passwords never reach our DB; `User.workosUserId` holds
  the WorkOS user id; session is a sealed WorkOS session cookie.

Both return the same `AuthUser` shape, so middleware treats them identically.

## Usage

```ts
import { selectAuthProvider } from "@altium-mcp/auth";

const auth = selectAuthProvider();
const { user, session } = await auth.signup({ email, password, name });
// session.sealed goes into the httpOnly cookie
// ...
const verified = await auth.verifySession(req.cookies.session);
```

## Env vars

| Var | Used by | Required in prod |
|---|---|---|
| `WORKOS_API_KEY` | WorkOS provider | Yes |
| `WORKOS_CLIENT_ID` | WorkOS provider | Yes |
| `WORKOS_COOKIE_PASSWORD` | Both (WorkOS sealing, Local JWT signing) | Yes — 32+ bytes |

When `WORKOS_API_KEY` is empty/unset, `selectAuthProvider()` returns the
Local provider and logs a clear one-time warning at startup.

## Session format

```
<alg>.<payload>.<signature>     // standard JWS compact, via `jose`
```

Payload claims: `sub` (user id), `sid` (session id, new UUID per issue),
`iat`, `exp` (15 min). The server sets the cookie `Secure; HttpOnly;
SameSite=Lax`; rotation goes through `refresh` (Sprint 3).

## Password format

```
scrypt$v1$N=32768,r=8,p=1$<salt_b64url>$<hash_b64url>
```

`N`, `r`, `p` are stored with the hash so we can increase parameters
without breaking existing hashes. Rotation procedure: on successful
login with old params, re-hash with current params before returning.

## Commands

```bash
pnpm -F @altium-mcp/auth build    # tsc
pnpm -F @altium-mcp/auth test     # unit + integration
```

## Not in this package (deferred by sprint)

- **API keys** — primitive scaffolded in Sprint 3 PR (3.x)
- **Role-based authorization `can()`** — Sprint 3
- **Magic link** — Sprint 3
- **SAML / OIDC** — Sprint 7 (via WorkOS Enterprise SSO)
- **Password reset / account deletion** — Sprint 7
