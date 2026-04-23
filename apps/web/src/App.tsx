import { PartsSearch } from "./pages/PartsSearch";

export function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Altium MCP</h1>
          <span className="text-xs text-slate-500">v0.2.0 · Parts Search</span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <PartsSearch />
      </main>
    </div>
  );
}
