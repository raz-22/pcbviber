/**
 * Settings shell. Renders the sidebar + the active sub-page.
 *
 * In PR 2.4 the only tab is Workspaces; the navigation is built to
 * accept future tabs (Organization, Members, API keys, Billing) without
 * a structural rewrite. Each future tab becomes one entry in `tabs`
 * and one nested route in App.tsx.
 */

import { NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { WorkspacesSettingsPage } from "./Workspaces";

interface Tab {
  to: string;
  label: string;
  available: boolean;
  comingIn?: string;
}

const tabs: Tab[] = [
  { to: "/settings/workspaces", label: "Workspaces", available: true },
  { to: "/settings/members", label: "Members", available: false, comingIn: "Sprint 3" },
  { to: "/settings/api-keys", label: "API keys", available: false, comingIn: "Sprint 3" },
  { to: "/settings/organization", label: "Organization", available: false, comingIn: "Sprint 3" },
  { to: "/settings/billing", label: "Billing", available: false, comingIn: "Sprint 4" },
];

export function SettingsShell() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-6 grid grid-cols-[200px_1fr] gap-8">
        <aside>
          <nav className="space-y-1 text-sm">
            {tabs.map((tab) =>
              tab.available ? (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  className={({ isActive }) =>
                    [
                      "block rounded px-3 py-2",
                      isActive
                        ? "bg-slate-900 text-white"
                        : "text-slate-700 hover:bg-slate-100",
                    ].join(" ")
                  }
                >
                  {tab.label}
                </NavLink>
              ) : (
                <span
                  key={tab.to}
                  className="block rounded px-3 py-2 text-slate-400"
                  title={tab.comingIn ? `Coming in ${tab.comingIn}` : undefined}
                >
                  {tab.label}
                </span>
              )
            )}
          </nav>
        </aside>
        <section>
          <Outlet />
        </section>
      </div>
    </div>
  );
}

/**
 * Routes nested under /settings. Mounted from App.tsx — kept here so
 * the routing for this section lives next to its pages.
 */
export function SettingsRoutes() {
  return (
    <Routes>
      <Route element={<SettingsShell />}>
        <Route index element={<Navigate to="/settings/workspaces" replace />} />
        <Route path="workspaces" element={<WorkspacesSettingsPage />} />
      </Route>
    </Routes>
  );
}
