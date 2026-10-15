<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";
import { type AlertVariants, alertVariants } from "./variants";

const props = withDefaults(
  defineProps<{ variant?: AlertVariants["variant"]; class?: HTMLAttributes["class"] }>(),
  { variant: "info" },
);

// Errors interrupt; everything else waits its turn.
const role = computed(() => (props.variant === "error" ? "alert" : "status"));
const classes = computed(() => cn(alertVariants({ variant: props.variant }), props.class));
</script>

<template>
  <div :role="role" :class="classes">
    <slot />
  </div>
</template>
