import { httpApi } from "./client";
import type { MonacaApi } from "./contract";
import { mockApi } from "./mock";

/**
 * Which implementation the pages get.
 *
 * `VITE_USE_MOCKS` defaults to **on** (stage 0): the console is fully usable before a server or a
 * gateway exists, which is the only way the UI work can proceed in parallel with the Rust work.
 * Setting it to `false` binds the BFF client; nothing else in the app changes.
 *
 * The default is deliberately on rather than off. An unset variable in a fresh clone should give a
 * working console, not a dead one — a missing env var is not a security boundary, and the mode is
 * surfaced in the UI (see the shell's "Mock data" notice) so it can never be mistaken for real data.
 */
export const USE_MOCKS: boolean =
  (import.meta.env["VITE_USE_MOCKS"] ?? "true").toString().toLowerCase() !== "false";

export const api: MonacaApi = USE_MOCKS ? mockApi : httpApi;

/** The gateway origin the Vite dev proxy forwards to, shown in Settings → Diagnostics. */
export const GATEWAY_URL: string = (import.meta.env["VITE_MONACA_GATEWAY_URL"] ?? "http://localhost:8080").toString();
