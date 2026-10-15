<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { DropdownMenuSeparator, type DropdownMenuSeparatorProps, useForwardProps } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<DropdownMenuSeparatorProps & { class?: HTMLAttributes["class"] }>();
const forwarded = useForwardProps(reactiveOmit(props, "class"));
</script>

<template>
  <DropdownMenuSeparator v-bind="forwarded" :class="cn('-mx-1 my-1 h-px bg-rule', props.class)" />
</template>
