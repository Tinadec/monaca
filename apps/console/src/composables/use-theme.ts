import { computed, onMounted, onUnmounted, ref } from "vue";

import type { ThemeChoice } from "@/stores/ui";

/**
 * Theme is a `class` on `<html>`, matching `@custom-variant dark` in packages/ui/src/styles.css.
 *
 * Three states, not two: "system" is the default and the only one that keeps following the OS. It
 * is resolved through `matchMedia` and re-resolved live, so a user who flips their OS theme at dusk
 * sees the console follow — but only if they never picked a side, which is the polite reading of
 * "system".
 */
export function useTheme(choice: () => ThemeChoice) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const systemIsDark = ref(media.matches);

  const resolved = computed<"light" | "dark">(() => {
    const value = choice();
    return value === "system" ? (systemIsDark.value ? "dark" : "light") : value;
  });

  function apply(): void {
    document.documentElement.classList.toggle("dark", resolved.value === "dark");
  }

  const onChange = (): void => {
    systemIsDark.value = media.matches;
  };

  onMounted(() => {
    apply();
    media.addEventListener("change", onChange);
  });
  onUnmounted(() => media.removeEventListener("change", onChange));

  return { resolved, apply };
}
