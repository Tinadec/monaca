<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <div class="scroll-thin relative w-full overflow-auto rounded-lg border border-rule bg-surface">
    <table :class="cn('w-full caption-bottom border-collapse text-[13px]', props.class)">
      <slot />
    </table>
  </div>
</template>
