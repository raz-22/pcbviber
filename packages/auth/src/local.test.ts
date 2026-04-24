/**
 * End-to-end LocalAuthProvider tests against a fresh SQLite DB.
 * Mirrors the pattern from packages/db/src/schema.test.ts — hermetic
 * temp DB, self-applies migrations, tears down afterward.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthError } from "./types.js";
import { __resetSessionCacheForTests } from "./session.js";

let LocalAuthProvider: typeof import("./local.js").LocalAuthProvider;
let resetRevocation: typeof import("./local.js").__resetLocalAuthRevocationForTests;
let prisma: import("@altium-mcp/db").PrismaClient;
let workdir: string;

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "altium-mcp-auth-test-"));
  const dbPath = join(workdir, "test.db").replace(/\\/g, "/");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WORKOS_COOKIE_PASSWORD = randomBytes(48).toString("base64");
  __resetSessionCacheForTests();

  // Apply db-package migrations to the test DB. packages/auth doesn't
  // have prisma on PATH directly, so we invoke the per-package shim
  // from packages/db by absolute path.
  const dbPkg = join(process.cwd(), "..", "db");
  const schemaPath = join(dbPkg, "prisma", "schema.prisma");
  const prismaBin =
    process.platform === "win32"
      ? join(dbPkg, "node_modules", ".bin", "prisma.CMD")
      : join(dbPkg, "node_modules", ".bin", "prisma");
  execFileSync(prismaBin, ["migrate", "deploy", "--schema", schemaPath], {
    shell: true,
    stdio: "ignore",
    env: process.env,
    cwd: dbPkg,
  });

  const db = await import("@altium-mcp/db");
  prisma = db.prisma;
  const local = await import("./local.js");
  LocalAuthProvider = local.LocalAuthProvider;
  resetRevocation = local.__resetLocalAuthRevocationForTests;
});

after(async () => {
  if (prisma) await prisma.$disconnect();
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    // best-effort teardown
  }
});

test("signup creates a user + returns a usable session", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  const { user, session, isNewUser } = await auth.signup({
    email: "signup@acme.test",
    password: "correct-horse-battery-staple",
    name: "First User",
  });

  assert.equal(isNewUser, true);
  assert.equal(user.email, "signup@acme.test");
  assert.ok(session.sealed);
  assert.ok(session.expiresAt > new Date());

  // The session verifies and resolves back to the same user.
  const verified = await auth.verifySession(session.sealed);
  assert.ok(verified);
  assert.equal(verified.id, user.id);
});

test("signup with an existing email rejects with email_taken", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  await auth.signup({
    email: "dupe@acme.test",
    password: "correct-horse-battery-staple",
  });
  await assert.rejects(
    () =>
      auth.signup({
        email: "dupe@acme.test",
        password: "correct-horse-battery-staple",
      }),
    (err: unknown) => err instanceof AuthError && err.code === "email_taken"
  );
});

test("signup rejects weak passwords with a typed error", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  await assert.rejects(
    () => auth.signup({ email: "weak@acme.test", password: "short" }),
    (err: unknown) => err instanceof AuthError && err.code === "password_too_weak"
  );
});

test("login returns a fresh session", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  const pw = "correct-horse-battery-staple";
  await auth.signup({ email: "login@acme.test", password: pw });
  const { user, session } = await auth.login({ email: "login@acme.test", password: pw });
  assert.equal(user.email, "login@acme.test");
  assert.ok(session.sealed);
});

test("login with wrong password rejects with invalid_credentials", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  await auth.signup({
    email: "wrongpw@acme.test",
    password: "correct-horse-battery-staple",
  });
  await assert.rejects(
    () => auth.login({ email: "wrongpw@acme.test", password: "wrong" }),
    (err: unknown) =>
      err instanceof AuthError && err.code === "invalid_credentials"
  );
});

test("login with unknown email rejects with invalid_credentials (same code)", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  await assert.rejects(
    () =>
      auth.login({
        email: "never-seen@acme.test",
        password: "correct-horse-battery-staple",
      }),
    (err: unknown) =>
      err instanceof AuthError && err.code === "invalid_credentials"
  );
});

test("logout revokes the session (verify returns null after)", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  const { session } = await auth.signup({
    email: "logout@acme.test",
    password: "correct-horse-battery-staple",
  });
  assert.ok(await auth.verifySession(session.sealed));
  await auth.logout(session.sealed);
  assert.equal(await auth.verifySession(session.sealed), null);
});

test("verifySession rejects a session with a WorkOS issuer claim", async () => {
  resetRevocation();
  const { signSession } = await import("./session.js");
  const { sealed } = await signSession("user_xyz", { issuer: "altium-mcp/workos" });
  const auth = new LocalAuthProvider();
  assert.equal(await auth.verifySession(sealed), null);
});

test("email is normalized to lowercase and trimmed", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  await auth.signup({
    email: "  Mixed.Case@Acme.Test  ",
    password: "correct-horse-battery-staple",
  });
  // Case-variant login succeeds.
  const { user } = await auth.login({
    email: "MIXED.case@acme.test",
    password: "correct-horse-battery-staple",
  });
  assert.equal(user.email, "mixed.case@acme.test");
});

test("getUser returns null for unknown ids", async () => {
  const auth = new LocalAuthProvider();
  assert.equal(await auth.getUser("nonexistent-id"), null);
});

// ─── Review additions — PR #3 second-pass coverage ────────────────────

test("verifySession returns null after the user is deleted", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  const { user, session } = await auth.signup({
    email: "gets-deleted@acme.test",
    password: "correct-horse-battery-staple",
  });
  // Sanity: verify works before the delete.
  assert.ok(await auth.verifySession(session.sealed));

  await prisma.user.delete({ where: { id: user.id } });

  // Session token is still cryptographically valid, but the user row
  // is gone — must resolve to null so middleware can force a re-login.
  assert.equal(await auth.verifySession(session.sealed), null);
});

test("login with an empty password rejects as invalid_credentials (not 'password_too_weak')", async () => {
  // Login should never leak weak-password info — only signup validates.
  resetRevocation();
  const auth = new LocalAuthProvider();
  await auth.signup({
    email: "emptypw@acme.test",
    password: "correct-horse-battery-staple",
  });
  await assert.rejects(
    () => auth.login({ email: "emptypw@acme.test", password: "" }),
    (err: unknown) =>
      err instanceof AuthError && err.code === "invalid_credentials"
  );
});

test("login with non-@ email rejects as invalid_credentials (no trace of the normalizer)", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  await assert.rejects(
    () => auth.login({ email: "not-an-email", password: "whatever-long-enough" }),
    (err: unknown) =>
      err instanceof AuthError && err.code === "invalid_credentials"
  );
});

test("timing: login with unknown email takes comparable time to login with known email", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  const pw = "correct-horse-battery-staple";
  await auth.signup({ email: "timing-known@acme.test", password: pw });

  // Warm caches — measure AFTER a dry run so first-call overhead is gone.
  await auth.login({ email: "timing-known@acme.test", password: pw }).catch(() => {});
  await auth
    .login({ email: "timing-unknown@acme.test", password: pw })
    .catch(() => {});

  const N = 3;
  let knownWrong = 0;
  let unknown = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await auth
      .login({ email: "timing-known@acme.test", password: "wrong-long-enough" })
      .catch(() => {});
    knownWrong += performance.now() - t0;

    const t1 = performance.now();
    await auth
      .login({ email: "timing-unknown@acme.test", password: "wrong-long-enough" })
      .catch(() => {});
    unknown += performance.now() - t1;
  }
  const ratio = unknown / knownWrong;
  // Give generous slack for noisy CI: the dummy-hash path should be
  // within 50%-200% of the real-user path. If it were 10x faster, we'd
  // fail — that's the enumeration leak we're preventing.
  assert.ok(
    ratio > 0.3 && ratio < 3,
    `dummy-hash timing drifted: unknown/knownWrong = ${ratio.toFixed(2)} ` +
      `(knownWrong=${knownWrong.toFixed(1)}ms, unknown=${unknown.toFixed(1)}ms)`
  );
});

test("a session token from issueSession survives round-trip via verifySession", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  const { user } = await auth.signup({
    email: "issue@acme.test",
    password: "correct-horse-battery-staple",
  });
  // issueSession is used post-refresh in Sprint 3; confirm it produces
  // tokens that verify without going through login.
  const fresh = await auth.issueSession(user.id);
  const verified = await auth.verifySession(fresh.sealed);
  assert.ok(verified);
  assert.equal(verified.id, user.id);
});

test("logout is idempotent (second logout on same session is a no-op)", async () => {
  resetRevocation();
  const auth = new LocalAuthProvider();
  const { session } = await auth.signup({
    email: "double-logout@acme.test",
    password: "correct-horse-battery-staple",
  });
  await auth.logout(session.sealed);
  await auth.logout(session.sealed); // must not throw
  assert.equal(await auth.verifySession(session.sealed), null);
});

test("logout on a garbage token is a silent no-op (never throws)", async () => {
  const auth = new LocalAuthProvider();
  await auth.logout("not-a-real-token"); // must not throw
  await auth.logout(""); // must not throw
});
