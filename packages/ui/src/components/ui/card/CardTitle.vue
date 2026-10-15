<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <h3 :class="cn('text-[15px] font-semibold leading-tight tracking-[-0.005em]', props.class)"><slot /></h3>
</template>
