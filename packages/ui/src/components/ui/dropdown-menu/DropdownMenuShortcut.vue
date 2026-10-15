<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <span :class="cn('ml-auto flex items-center gap-0.5 text-[11px] text-ink-faint', props.class)"><slot /></span>
</template>
