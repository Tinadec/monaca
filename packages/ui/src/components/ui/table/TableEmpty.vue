<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/cn";
import TableCell from "./TableCell.vue";
import TableRow from "./TableRow.vue";

const props = withDefaults(defineProps<{ colspan?: number; class?: HTMLAttributes["class"] }>(), {
  colspan: 1,
});
</script>

<template>
  <TableRow class="hover:bg-transparent">
    <TableCell :colspan="props.colspan" :class="cn('py-10 text-center text-ink-muted', props.class)">
      <slot />
    </TableCell>
  </TableRow>
</template>
