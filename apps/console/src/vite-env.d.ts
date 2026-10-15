/// <reference types="vite/client" />

/**
 * Browser-visible configuration.
 *
 * Declared here rather than left to `import.meta.env`'s index signature so a typo is a compile error
 * and each variable's meaning is written down next to its type. Only `VITE_*` values exist in the
 * browser — everything else in `.env.example` is server-side (§2.2).
 */
interface ImportMetaEnv {
  /** `true` (default) renders the local mock layer; `false` binds the gateway BFF client. */
  readonly VITE_USE_MOCKS?: string;
  /** The Vite dev-proxy target. Not read by application code, only by `vite.config.ts`. */
  readonly VITE_MONACA_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
