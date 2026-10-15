<script setup lang="ts">
import { Primitive, type PrimitiveProps } from "reka-ui";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = withDefaults(
  defineProps<PrimitiveProps & { active?: boolean; class?: HTMLAttributes["class"] }>(),
  { as: "a", active: false },
);

const classes = computed(() =>
  cn(
    "group/nav relative flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium outline-offset-0",
    "text-ink-muted transition-colors duration-100 hover:bg-surface-muted hover:text-ink",
    "[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-ink-faint [&>svg]:transition-colors",
    "hover:[&>svg]:text-ink-muted",
    props.active &&
      "bg-surface-muted text-ink [&>svg]:text-brand hover:[&>svg]:text-brand before:absolute before:-left-[9px] before:top-1.5 before:h-5 before:w-[3px] before:rounded-r-full before:bg-brand",
    props.class,
  ),
);
</script>

<template>
  <Primitive :as="as" :as-child="asChild" :class="classes" :aria-current="active ? 'page' : undefined">
    <slot />
  </Primitive>
</template>
