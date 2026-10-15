<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <span
    :class="
      cn(
        'ml-auto hidden items-center gap-0.5 opacity-0 transition-opacity group-hover/nav:opacity-100 group-focus-visible/nav:opacity-100 md:inline-flex',
        props.class,
      )
    "
    aria-hidden="true"
  >
    <slot />
  </span>
</template>
