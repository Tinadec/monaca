<script setup lang="ts">
import { Primitive, type PrimitiveProps } from "reka-ui";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";
import { type BadgeVariants, badgeVariants } from "./variants";

const props = withDefaults(
  defineProps<PrimitiveProps & { variant?: BadgeVariants["variant"]; class?: HTMLAttributes["class"] }>(),
  { as: "span", variant: "muted" },
);

const classes = computed(() => cn(badgeVariants({ variant: props.variant }), props.class));
</script>

<template>
  <Primitive :as="as" :as-child="asChild" :class="classes"><slot /></Primitive>
</template>
