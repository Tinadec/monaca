import { VueQueryPlugin, QueryClient } from "@tanstack/vue-query";
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import "./app.css";
import { router } from "./router";

/**
 * Console entry point.
 *
 * Pinia holds UI state only (selected org, theme, sidebar); TanStack Query owns every server
 * response, so there is exactly one cache for server data and one for local preferences.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A console is usually left open in a tab; refetching on every focus is what makes one feel
      // slow. Staleness is declared per query instead (see `src/queries.ts`).
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry an auth failure: the answer will not change until the user signs in.
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
    },
  },
});

createApp(App).use(createPinia()).use(router).use(VueQueryPlugin, { queryClient }).mount("#app");
