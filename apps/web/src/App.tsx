import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Nav } from "./components/Nav";
import { BillingBanner } from "./components/BillingBanner";
import { Footer } from "./components/Footer";
import { RequireAuth, RedirectIfAuthed } from "./components/RequireAuth";
import { HomePage } from "./pages/Home";
import { LandingPage } from "./pages/Landing";
import { LoginPage } from "./pages/Login";
import { SignupPage } from "./pages/Signup";
import { PartsSearch } from "./pages/PartsSearch";
import { SettingsRoutes } from "./pages/Settings";
import { AcceptInvitePage } from "./pages/AcceptInvite";
import { DpaPage } from "./pages/Legal/Dpa";
import { SubprocessorsPage } from "./pages/Legal/Subprocessors";
import { PrivacyPage } from "./pages/Legal/Privacy";
import { TermsPage } from "./pages/Legal/Terms";
import { DocsPage } from "./pages/Docs";
import { StatusPage } from "./pages/Status";
import { useAuth } from "./lib/auth";

/**
 * Top-level router.
 *
 *   /                      — public Landing for anonymous, in-app HomePage for authed
 *   /login                 — public, redirects to / when already authed
 *   /signup                — public, redirects to / when already authed
 *   /parts                 — protected: PartsSearch (workspace-scoped)
 *   /settings/*            — protected: Settings shell, see Settings/index.tsx
 *   /docs                  — public: quickstart + tool reference
 *   /status                — public: live API health probe
 *   /legal/privacy         — public: privacy policy
 *   /legal/terms           — public: terms of service
 *   /legal/dpa             — public: data processing addendum
 *   /legal/subprocessors   — public: subprocessor list
 *   *                      — 404 → /
 */
function HomeOrLanding() {
  const { isLoading, isAuthenticated } = useAuth();
  // While the session is still loading, render nothing — flashing the
  // marketing landing for ~150ms before redirecting an authed user to
  // their dashboard looks broken. Nav already shows a "…" placeholder.
  if (isLoading) return null;
  return isAuthenticated ? <HomePage /> : <LandingPage />;
}

export function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col">
        <Nav />
        <BillingBanner />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<HomeOrLanding />} />
            <Route
              path="/login"
              element={
                <RedirectIfAuthed>
                  <LoginPage />
                </RedirectIfAuthed>
              }
            />
            <Route
              path="/signup"
              element={
                <RedirectIfAuthed>
                  <SignupPage />
                </RedirectIfAuthed>
              }
            />
            <Route
              path="/parts"
              element={
                <RequireAuth>
                  <div className="mx-auto max-w-6xl px-6 py-8">
                    <PartsSearch />
                  </div>
                </RequireAuth>
              }
            />
            <Route
              path="/settings/*"
              element={
                <RequireAuth>
                  <SettingsRoutes />
                </RequireAuth>
              }
            />
            <Route
              path="/invites/accept"
              element={
                <RequireAuth>
                  <AcceptInvitePage />
                </RequireAuth>
              }
            />
            {/* Public docs — same audience as the marketing landing
                + linked from registry submission and launch posts. */}
            <Route path="/docs" element={<DocsPage />} />
            {/* Public status probe — for customers + uptime monitors. */}
            <Route path="/status" element={<StatusPage />} />
            {/* Public legal pages — readable without a session so
                prospects under procurement review can link directly. */}
            <Route path="/legal/privacy" element={<PrivacyPage />} />
            <Route path="/legal/terms" element={<TermsPage />} />
            <Route path="/legal/dpa" element={<DpaPage />} />
            <Route
              path="/legal/subprocessors"
              element={<SubprocessorsPage />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </BrowserRouter>
  );
}
