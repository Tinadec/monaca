<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import {
  DropdownMenuContent,
  type DropdownMenuContentEmits,
  type DropdownMenuContentProps,
  DropdownMenuPortal,
  useForwardPropsEmits,
} from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = withDefaults(defineProps<DropdownMenuContentProps & { class?: HTMLAttributes["class"] }>(), {
  sideOffset: 6,
});
const emits = defineEmits<DropdownMenuContentEmits>();
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class"), emits);
</script>

<template>
  <DropdownMenuPortal>
    <DropdownMenuContent
      v-bind="forwarded"
      :class="
        cn(
          'animate-pop-in z-50 min-w-[11rem] overflow-hidden rounded-lg border border-rule bg-surface p-1 text-ink',
          'shadow-[var(--shadow-pop)]',
          props.class,
        )
      "
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>
