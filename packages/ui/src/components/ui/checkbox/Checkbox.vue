<script setup lang="ts">
import { CheckboxIndicator, CheckboxRoot, type CheckboxRootEmits, type CheckboxRootProps, useForwardPropsEmits } from "reka-ui";
import { Check } from "lucide-vue-next";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<CheckboxRootProps & { class?: HTMLAttributes["class"] }>();
const emits = defineEmits<CheckboxRootEmits>();
const forwarded = useForwardPropsEmits(props, emits);

const classes = computed(() =>
  cn(
    "size-3.5 shrink-0 rounded-[3px] border border-rule-strong bg-surface transition-colors",
    "data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-brand-on",
    "data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand",
    "disabled:cursor-not-allowed disabled:opacity-50",
    props.class,
  ),
);
</script>

<template>
  <CheckboxRoot v-bind="forwarded" :class="classes">
    <CheckboxIndicator class="flex h-full w-full items-center justify-center text-current">
      <Check class="size-3" :stroke-width="3" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
