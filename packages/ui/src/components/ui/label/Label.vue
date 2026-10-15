<script setup lang="ts">
import { Label, type LabelProps } from "reka-ui";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<LabelProps & { class?: HTMLAttributes["class"] }>();

const classes = computed(() =>
  cn(
    "flex items-center gap-1.5 text-[12px] font-medium text-ink-muted",
    "peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
    props.class,
  ),
);
</script>

<template>
  <Label :class="classes"><slot /></Label>
</template>
