<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <kbd :class="cn('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] border border-rule bg-surface px-1 font-mono text-[10.5px] font-medium leading-none text-ink-muted', props.class)"><slot /></kbd>
</template>
