<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { Check } from "lucide-vue-next";
import {
  DropdownMenuItemIndicator,
  DropdownMenuRadioItem,
  type DropdownMenuRadioItemEmits,
  type DropdownMenuRadioItemProps,
  useForwardPropsEmits,
} from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<DropdownMenuRadioItemProps & { class?: HTMLAttributes["class"] }>();
const emits = defineEmits<DropdownMenuRadioItemEmits>();
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class"), emits);
</script>

<template>
  <DropdownMenuRadioItem
    v-bind="forwarded"
    :class="
      cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-2 pr-8 text-[13px] outline-none transition-colors',
        'focus:bg-surface-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        props.class,
      )
    "
  >
    <slot />
    <span class="absolute right-2 flex size-3.5 items-center justify-center">
      <DropdownMenuItemIndicator><Check class="size-3.5 text-brand" :stroke-width="2.5" /></DropdownMenuItemIndicator>
    </span>
  </DropdownMenuRadioItem>
</template>
