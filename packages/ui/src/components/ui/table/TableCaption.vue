<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <caption :class="cn('mt-3 text-[12px] text-ink-faint', props.class)"><slot /></caption>
</template>
