<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <tr :class="cn('border-b border-rule transition-colors hover:bg-surface-muted/60 data-[state=selected]:bg-brand-soft', props.class)"><slot /></tr>
</template>
