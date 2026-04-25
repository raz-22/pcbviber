import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { initSentry } from "./lib/sentry";
import "./index.css";

// Initialize Sentry before React renders. No-op when
// VITE_SENTRY_DSN is unset — dev / preview builds without
// observability stay cost-free.
initSentry(import.meta.env);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Sentry.ErrorBoundary catches React render errors and ships
        them to Sentry. The fallback shows a minimal recoverable
        UI; resetError lets the user retry without a full reload. */}
    <Sentry.ErrorBoundary
      fallback={({ resetError }) => (
        <div className="mx-auto max-w-md p-6 text-center">
          <h1 className="text-lg font-semibold text-rose-700">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            We've been notified. You can try the action again or
            reload the page.
          </p>
          <button
            type="button"
            onClick={resetError}
            className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white"
          >
            Try again
          </button>
        </div>
      )}
    >
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);
