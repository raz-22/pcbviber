/**
 * Single entry point for picking an AuthProvider based on the
 * environment. Kept separate from the provider implementations so
 * tests can construct a specific provider directly without going
 * through env probing.
 */

import type { AuthProvider } from "./provider.js";
import { LocalAuthProvider } from "./local.js";
import { WorkOSAuthProvider } from "./workos.js";

let cached: AuthProvider | null = null;
let loggedBanner = false;

export function selectAuthProvider(): AuthProvider {
  if (cached) return cached;

  const workosConfigured =
    !!process.env.WORKOS_API_KEY && !!process.env.WORKOS_CLIENT_ID;

  if (workosConfigured) {
    cached = new WorkOSAuthProvider();
    if (!loggedBanner && process.env.NODE_ENV !== "test") {
      console.error("[auth] Using WorkOSAuthProvider");
      loggedBanner = true;
    }
    return cached;
  }

  cached = new LocalAuthProvider();
  if (!loggedBanner && process.env.NODE_ENV !== "test") {
    console.error(
      "[auth] WORKOS_API_KEY not set — using LocalAuthProvider. " +
        "Suitable for dev/test only; production must configure WorkOS " +
        "(see packages/auth/README.md)."
    );
    loggedBanner = true;
  }
  return cached;
}

/** Test-only: drop the cached provider so a new one is picked. */
export function __resetAuthProviderCacheForTests(): void {
  cached = null;
  loggedBanner = false;
}
