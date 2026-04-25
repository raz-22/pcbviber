/// <reference types="vite/client" />

// Vite injects `import.meta.env.<KEY>` for any env var prefixed
// with `VITE_`. Without a reference to vite/client, TypeScript
// doesn't know that ImportMeta has an `env` field.
//
// Strongly-typed env vars: any that the SPA reads — extend the
// generated `ImportMetaEnv` so callsites get autocomplete +
// missing-env compile errors instead of `string | undefined`
// everywhere.

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  readonly VITE_SENTRY_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
