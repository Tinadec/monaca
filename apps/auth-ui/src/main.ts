import { VueQueryPlugin, QueryClient } from "@tanstack/vue-query";
import { createApp } from "vue";

import App from "./App.vue";
import "./app.css";
import { router } from "./router";

/**
 * Hosted sign-in entry point.
 *
 * There is no Pinia store here on purpose: the page has exactly one piece of state, it is scoped to
 * the interaction in the URL, and it should not survive a reload or leak between tenants. Query is
 * installed only so the interaction lookup gets its retry policy.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A sign-in page is short-lived and its requests are cheap; refetching on focus would race
      // the redirect, so it is off.
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

createApp(App).use(router).use(VueQueryPlugin, { queryClient }).mount("#app");
