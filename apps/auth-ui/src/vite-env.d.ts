/// <reference types="vite/client" />

/**
 * Browser-visible configuration. The sign-in page reads no `VITE_*` value itself: it derives the
 * tenant from the interaction URL and calls the gateway through same-origin relative paths, so there
 * is nothing to configure here and nothing to leak into the bundle.
 */
interface ImportMetaEnv {
  /** The Vite dev-proxy target. Read by `vite.config.ts` only. */
  readonly VITE_MONACA_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
