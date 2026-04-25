import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Nav } from "./components/Nav";
import { BillingBanner } from "./components/BillingBanner";
import { RequireAuth, RedirectIfAuthed } from "./components/RequireAuth";
import { HomePage } from "./pages/Home";
import { LoginPage } from "./pages/Login";
import { SignupPage } from "./pages/Signup";
import { PartsSearch } from "./pages/PartsSearch";
import { SettingsRoutes } from "./pages/Settings";
import { AcceptInvitePage } from "./pages/AcceptInvite";

/**
 * Top-level router.
 *
 *   /                      — protected: home (org summary + tool links)
 *   /login                 — public, redirects to / when already authed
 *   /signup                — public, redirects to / when already authed
 *   /parts                 — protected: PartsSearch (workspace-scoped)
 *   /settings/*            — protected: Settings shell, see Settings/index.tsx
 *   *                      — 404 → /
 */
export function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen">
        <Nav />
        <BillingBanner />
        <main>
          <Routes>
            <Route
              path="/"
              element={
                <RequireAuth>
                  <HomePage />
                </RequireAuth>
              }
            />
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
