<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { DropdownMenuLabel, type DropdownMenuLabelProps, useForwardProps } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<DropdownMenuLabelProps & { class?: HTMLAttributes["class"] }>();
const forwarded = useForwardProps(reactiveOmit(props, "class"));
</script>

<template>
  <DropdownMenuLabel v-bind="forwarded" :class="cn('px-2 py-1.5 text-[11.5px] font-medium text-ink-faint', props.class)">
    <slot />
  </DropdownMenuLabel>
</template>
