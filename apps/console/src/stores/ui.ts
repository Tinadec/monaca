import { defineStore } from "pinia";

/**
 * UI state only — never server data.
 *
 * TanStack Query owns everything fetched from the API (see `src/queries.ts`). This store holds the
 * things that are genuinely local: which tenant/org the user has selected, the theme, and whether
 * the sidebar is collapsed. Mixing the two is the usual way a console ends up with two caches that
 * disagree after a mutation.
 *
 * Selections persist to `localStorage` so a reload keeps the user in the org they were working in.
 */
export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "monaca.console.ui";

interface Persisted {
  tenant: string;
  org: string;
  theme: ThemeChoice;
  sidebarCollapsed: boolean;
}

function read(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
  } catch {
    // Private mode, a corrupted value, or storage disabled: fall back to defaults rather than
    // failing to boot. A UI preference is never worth an exception on startup.
    return {};
  }
}

export const useUiStore = defineStore("ui", {
  state: () => {
    const stored = read();
    return {
      // M0 points the console at tenant `demo` and its default org (§5.7).
      tenant: stored.tenant ?? "demo",
      org: stored.org ?? "acme",
      theme: (stored.theme ?? "system") as ThemeChoice,
      sidebarCollapsed: stored.sidebarCollapsed ?? false,
    };
  },

  actions: {
    setOrg(org: string): void {
      this.org = org;
      this.persist();
    },

    setTenant(tenant: string): void {
      this.tenant = tenant;
      this.persist();
    },

    setTheme(theme: ThemeChoice): void {
      this.theme = theme;
      this.persist();
    },

    toggleSidebar(): void {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      this.persist();
    },

    persist(): void {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            tenant: this.tenant,
            org: this.org,
            theme: this.theme,
            sidebarCollapsed: this.sidebarCollapsed,
          } satisfies Persisted),
        );
      } catch {
        // Ignore: the preference simply does not survive the reload.
      }
    },
  },
});
