<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
</script>

<template>
  <thead :class="cn('[&_tr]:border-b [&_tr]:border-rule', props.class)"><slot /></thead>
</template>
