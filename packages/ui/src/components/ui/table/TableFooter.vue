<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <tfoot :class="cn('border-t border-rule bg-surface-muted font-medium', props.class)"><slot /></tfoot>
</template>
