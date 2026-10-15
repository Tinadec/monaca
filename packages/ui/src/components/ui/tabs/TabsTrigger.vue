<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { TabsTrigger, type TabsTriggerProps, useForwardProps } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<TabsTriggerProps & { class?: HTMLAttributes["class"] }>();
const forwarded = useForwardProps(reactiveOmit(props, "class"));
</script>

<template>
  <TabsTrigger
    v-bind="forwarded"
    :class="
      cn(
        '-mb-px inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-0.5 text-[13px] font-medium text-ink-muted',
        'transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-50',
        'data-[state=active]:border-brand data-[state=active]:text-ink',
        props.class,
      )
    "
  >
    <slot />
  </TabsTrigger>
</template>
