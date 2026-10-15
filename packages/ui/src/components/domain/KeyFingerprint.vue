<script setup lang="ts">
import { Check, Copy } from "lucide-vue-next";
import { computed, ref, type HTMLAttributes } from "vue";

import { cn } from "../../lib/cn";

/**
 * A key or hash fingerprint. Hex is grouped in fours so it can be read aloud and compared by eye;
 * the copy button always copies the ungrouped value.
 */
const props = withDefaults(
  defineProps<{
    fingerprint: string;
    label?: string;
    /** How many leading hex characters to show before the ellipsis. `0` shows everything. */
    head?: number;
    copyLabel?: string;
    copiedLabel?: string;
    class?: HTMLAttributes["class"];
  }>(),
  { head: 16, copyLabel: "Copy fingerprint", copiedLabel: "Copied" },
);

const copied = ref(false);
const normalized = computed(() => props.fingerprint.trim().toLowerCase().replace(/\s+/g, ""));

const display = computed(() => {
  const value = normalized.value;
  const shown = props.head > 0 && value.length > props.head ? `${value.slice(0, props.head)}…` : value;
  return shown.replace(/(.{4})/g, "$1 ").trim();
});

let resetTimer: ReturnType<typeof setTimeout> | undefined;

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(normalized.value);
  } catch {
    // Clipboard is unavailable (insecure origin, denied permission); the value stays selectable.
    return;
  }
  copied.value = true;
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => (copied.value = false), 1400);
}
</script>

<template>
  <span :class="cn('inline-flex min-w-0 items-center gap-1.5', props.class)">
    <span v-if="label" class="text-[12px] text-ink-faint">{{ label }}</span>
    <span class="mono-data truncate text-[12px] text-ink-muted" :title="normalized">{{ display }}</span>
    <button
      type="button"
      class="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-surface-muted hover:text-ink focus-visible:outline-2"
      :aria-label="copied ? copiedLabel : copyLabel"
      @click="copy"
    >
      <Check v-if="copied" class="size-3 text-allow" aria-hidden="true" />
      <Copy v-else class="size-3" aria-hidden="true" />
    </button>
  </span>
</template>
