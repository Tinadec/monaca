<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { TabsList, type TabsListProps } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<TabsListProps & { class?: HTMLAttributes["class"] }>();
const delegated = reactiveOmit(props, "class");
</script>

<template>
  <TabsList v-bind="delegated" :class="cn('inline-flex items-center gap-5 border-b border-rule', props.class)">
    <slot />
  </TabsList>
</template>
