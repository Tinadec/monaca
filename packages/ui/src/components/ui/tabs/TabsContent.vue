<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { TabsContent, type TabsContentProps } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<TabsContentProps & { class?: HTMLAttributes["class"] }>();
const delegated = reactiveOmit(props, "class");
</script>

<template>
  <TabsContent v-bind="delegated" :class="cn('mt-4', props.class)">
    <slot />
  </TabsContent>
</template>
