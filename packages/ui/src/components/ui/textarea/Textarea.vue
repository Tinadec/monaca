<script setup lang="ts">
import { useVModel } from "@vueuse/core";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    defaultValue?: string;
    invalid?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { invalid: false },
);

const emits = defineEmits<{ "update:modelValue": [value: string] }>();
const model = useVModel(props, "modelValue", emits, { passive: true, defaultValue: props.defaultValue });

const classes = computed(() =>
  cn(
    "flex min-h-[72px] w-full rounded-md border border-rule bg-surface px-2.5 py-1.5 text-[13px] text-ink",
    "transition-[border-color,box-shadow] duration-100 hover:border-rule-strong",
    "focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/15",
    "disabled:cursor-not-allowed disabled:opacity-50",
    props.invalid && "border-deny focus-visible:border-deny focus-visible:ring-deny/20",
    props.class,
  ),
);
</script>

<template>
  <textarea v-model="model" :class="classes" :aria-invalid="invalid || undefined" />
</template>
