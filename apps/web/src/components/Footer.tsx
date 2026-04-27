/**
 * App-wide footer with links to legal pages.
 *
 * Light-touch — single row, no clickbait. Visible everywhere
 * including the auth pages, since prospects under enterprise
 * procurement want to read the DPA before signing up.
 */

import { Link } from "react-router-dom";

export function Footer() {
  return (
    <footer className="mt-16 border-t border-slate-200 px-6 py-6 text-xs text-slate-500">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <span>© {new Date().getFullYear()} PCBviber</span>
        <span aria-hidden>·</span>
        <Link to="/docs" className="hover:text-slate-700 hover:underline">
          Docs
        </Link>
        <span aria-hidden>·</span>
        <Link to="/status" className="hover:text-slate-700 hover:underline">
          Status
        </Link>
        <span aria-hidden>·</span>
        <Link to="/legal/privacy" className="hover:text-slate-700 hover:underline">
          Privacy
        </Link>
        <span aria-hidden>·</span>
        <Link to="/legal/terms" className="hover:text-slate-700 hover:underline">
          Terms
        </Link>
        <span aria-hidden>·</span>
        <Link to="/legal/dpa" className="hover:text-slate-700 hover:underline">
          DPA
        </Link>
        <span aria-hidden>·</span>
        <Link
          to="/legal/subprocessors"
          className="hover:text-slate-700 hover:underline"
        >
          Subprocessors
        </Link>
      </div>
    </footer>
  );
}
