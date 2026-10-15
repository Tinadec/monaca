<script setup lang="ts">
import { Ban, Minus, Plus } from "lucide-vue-next";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../lib/cn";
import type { ScopeState } from "./scopes";

/**
 * One scope string, coloured by what happened to it. `granted` is the calm default; `required` is
 * what a call asked for and did not get; `dropped` shows a scope that a delegation hop removed;
 * `denied` is a hard refusal. The leading glyph is what makes the state readable without colour.
 */
const props = withDefaults(
  defineProps<{ scope: string; state?: ScopeState; class?: HTMLAttributes["class"] }>(),
  { state: "granted" },
);

const classes = computed(() =>
  cn(
    "inline-flex items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-[11.5px] leading-[16px] tracking-[-0.01em] whitespace-nowrap",
    props.state === "granted" && "border-rule bg-surface-muted text-ink-muted",
    props.state === "required" && "border-warn/40 bg-warn-soft text-warn",
    props.state === "dropped" && "border-rule border-dashed bg-transparent text-ink-faint line-through",
    props.state === "denied" && "border-deny/40 bg-deny-soft text-deny",
    props.class,
  ),
);
</script>

<template>
  <span :class="classes" :data-state="state">
    <Plus v-if="state === 'required'" class="size-2.5" aria-hidden="true" />
    <Minus v-else-if="state === 'dropped'" class="size-2.5" aria-hidden="true" />
    <Ban v-else-if="state === 'denied'" class="size-2.5" aria-hidden="true" />
    {{ scope }}
  </span>
</template>
