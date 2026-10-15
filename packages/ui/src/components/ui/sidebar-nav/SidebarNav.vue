<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ label: string; class?: HTMLAttributes["class"] }>();
</script>

<template>
  <nav :aria-label="props.label" :class="cn('flex flex-col gap-0.5', props.class)">
    <slot />
  </nav>
</template>
