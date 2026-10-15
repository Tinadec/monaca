<script setup lang="ts">
/**
 * The page header: title, one line of context, and the page's actions on the right.
 *
 * Kept as one dense row rather than a hero block — a console is visited many times a day, and
 * vertical space spent on a heading is space not spent on the table. The stat runs are rendered in
 * mono/tabular so they do not jitter as their numbers change.
 */
defineProps<{
  title: string;
  subtitle?: string;
  /** Small mono facts shown beside the subtitle, e.g. "42 agents". */
  stats?: readonly string[];
}>();
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-rule pb-4">
    <div class="min-w-0">
      <h1 class="text-[19px] font-semibold leading-tight tracking-[-0.015em] text-ink">{{ title }}</h1>
      <p v-if="subtitle" class="mt-0.5 truncate text-[12.5px] text-ink-muted">{{ subtitle }}</p>
      <p v-if="stats?.length" class="mono-data mt-1 flex flex-wrap items-center gap-x-3 text-[11.5px] text-ink-faint">
        <span v-for="stat in stats" :key="stat">{{ stat }}</span>
      </p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
