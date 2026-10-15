<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ heading?: string; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div :class="cn('flex flex-col gap-0.5', props.class)">
    <p v-if="heading" class="px-2 pb-1 pt-3 text-[11.5px] font-medium text-ink-faint">{{ heading }}</p>
    <slot />
  </div>
</template>
