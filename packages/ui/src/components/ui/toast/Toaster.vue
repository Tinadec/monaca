<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, X } from "lucide-vue-next";

import { useToast } from "./use-toast";

withDefaults(defineProps<{ dismissLabel?: string; regionLabel?: string }>(), {
  dismissLabel: "Dismiss notification",
  regionLabel: "Notifications",
});

const { toasts, dismiss } = useToast();
</script>

<template>
  <Teleport to="body">
    <ol
      class="pointer-events-none fixed inset-x-0 bottom-0 z-[100] m-0 flex list-none flex-col items-end gap-2 p-4 sm:inset-x-auto sm:right-0"
      :aria-label="regionLabel"
    >
      <li
        v-for="t in toasts"
        :key="t.id"
        :role="t.variant === 'error' ? 'alert' : 'status'"
        class="animate-toast-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border border-rule bg-surface p-3 shadow-[var(--shadow-pop)]"
      >
        <CircleCheck v-if="t.variant === 'success'" class="mt-px size-4 shrink-0 text-allow" aria-hidden="true" />
        <CircleAlert v-else-if="t.variant === 'error'" class="mt-px size-4 shrink-0 text-deny" aria-hidden="true" />
        <Info v-else class="mt-px size-4 shrink-0 text-info" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="text-[13px] font-medium leading-snug text-ink">{{ t.title }}</p>
          <p v-if="t.description" class="mt-0.5 break-words text-[12.5px] leading-snug text-ink-muted">
            {{ t.description }}
          </p>
        </div>
        <button
          type="button"
          class="-mr-1 -mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-surface-muted hover:text-ink"
          :aria-label="dismissLabel"
          @click="dismiss(t.id)"
        >
          <X class="size-3.5" />
        </button>
      </li>
    </ol>
  </Teleport>
</template>
