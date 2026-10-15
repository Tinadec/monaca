<script setup lang="ts">
import { Primitive, type PrimitiveProps } from "reka-ui";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";
import { type ButtonVariants, buttonVariants } from "./variants";

const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      variant?: ButtonVariants["variant"];
      size?: ButtonVariants["size"];
      block?: boolean;
      class?: HTMLAttributes["class"];
    }
  >(),
  { as: "button", variant: "secondary", size: "default", block: false },
);

const classes = computed(() =>
  cn(buttonVariants({ variant: props.variant, size: props.size }), props.block && "w-full", props.class),
);
</script>

<template>
  <Primitive :as="as" :as-child="asChild" :class="classes">
    <slot />
  </Primitive>
</template>
