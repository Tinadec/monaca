<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import {
  TooltipContent,
  type TooltipContentEmits,
  type TooltipContentProps,
  TooltipPortal,
  useForwardPropsEmits,
} from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = withDefaults(defineProps<TooltipContentProps & { class?: HTMLAttributes["class"] }>(), {
  sideOffset: 6,
});
const emits = defineEmits<TooltipContentEmits>();
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class"), emits);
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      v-bind="forwarded"
      :class="
        cn(
          'animate-fade-in z-50 max-w-[18rem] rounded-md bg-ink px-2 py-1 text-[12px] leading-snug text-paper shadow-[var(--shadow-pop)]',
          props.class,
        )
      "
    >
      <slot />
    </TooltipContent>
  </TooltipPortal>
</template>
