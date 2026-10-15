<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { DialogTitle, type DialogTitleProps, useForwardProps } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<DialogTitleProps & { class?: HTMLAttributes["class"] }>();
const forwarded = useForwardProps(reactiveOmit(props, "class"));
</script>

<template>
  <DialogTitle v-bind="forwarded" :class="cn('text-[16px] font-semibold leading-snug tracking-[-0.01em]', props.class)">
    <slot />
  </DialogTitle>
</template>
