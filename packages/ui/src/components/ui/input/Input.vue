<script setup lang="ts">
import { useVModel } from "@vueuse/core";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = withDefaults(
  defineProps<{
    modelValue?: string | number;
    defaultValue?: string | number;
    invalid?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { invalid: false },
);

const emits = defineEmits<{ "update:modelValue": [value: string | number] }>();

const model = useVModel(props, "modelValue", emits, { passive: true, defaultValue: props.defaultValue });

const classes = computed(() =>
  cn(
    "flex h-8 w-full rounded-md border border-rule bg-surface px-2.5 py-1 text-[13px] text-ink",
    "shadow-[0_1px_0_oklch(0_0_0/0.02)_inset] transition-[border-color,box-shadow] duration-100",
    "hover:border-rule-strong focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/15",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "file:mr-2 file:border-0 file:bg-transparent file:text-[12px] file:font-medium file:text-ink-muted",
    props.invalid && "border-deny focus-visible:border-deny focus-visible:ring-deny/20",
    props.class,
  ),
);
</script>

<template>
  <input v-model="model" :class="classes" :aria-invalid="invalid || undefined" />
</template>
