<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import {
  DropdownMenuItem,
  type DropdownMenuItemEmits,
  type DropdownMenuItemProps,
  useForwardPropsEmits,
} from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<
  DropdownMenuItemProps & { class?: HTMLAttributes["class"]; inset?: boolean; destructive?: boolean }
>();
const emits = defineEmits<DropdownMenuItemEmits>();
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class", "inset", "destructive"), emits);
</script>

<template>
  <DropdownMenuItem
    v-bind="forwarded"
    :class="
      cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors',
        'focus:bg-surface-muted focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        '[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-faint',
        inset && 'pl-8',
        destructive && 'text-deny focus:bg-deny-soft focus:text-deny [&_svg]:text-deny',
        props.class,
      )
    "
  >
    <slot />
  </DropdownMenuItem>
</template>
