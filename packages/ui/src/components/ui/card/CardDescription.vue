<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <p :class="cn('text-[13px] leading-snug text-ink-muted', props.class)"><slot /></p>
</template>
