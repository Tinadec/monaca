<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { X } from "lucide-vue-next";
import {
  DialogClose,
  DialogContent,
  type DialogContentEmits,
  type DialogContentProps,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = withDefaults(
  defineProps<DialogContentProps & { class?: HTMLAttributes["class"]; closeLabel?: string; hideClose?: boolean }>(),
  { closeLabel: "Close", hideClose: false },
);
const emits = defineEmits<DialogContentEmits>();
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class", "closeLabel", "hideClose"), emits);
</script>

<template>
  <DialogPortal>
    <DialogOverlay class="animate-fade-in fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px]" />
    <DialogContent
      v-bind="forwarded"
      :class="
        cn(
          'animate-pop-in fixed left-1/2 top-[12vh] z-50 grid max-h-[80vh] w-[calc(100vw-2rem)] max-w-[480px] -translate-x-1/2 gap-4',
          'scroll-thin overflow-y-auto rounded-xl border border-rule bg-surface p-5 shadow-[var(--shadow-pop)]',
          props.class,
        )
      "
    >
      <slot />
      <DialogClose
        v-if="!hideClose"
        class="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-sm text-ink-faint transition-colors hover:bg-surface-muted hover:text-ink"
        :aria-label="closeLabel"
      >
        <X class="size-4" />
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
