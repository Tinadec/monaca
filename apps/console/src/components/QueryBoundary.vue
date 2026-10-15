<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle, Button, Skeleton } from "@monaca/ui";
import { CircleAlert, Inbox, RotateCw } from "lucide-vue-next";

import { t } from "@/i18n";

/**
 * The three states every page shares: loading, failed, empty.
 *
 * Kept as one component so all six pages fail the same way. A retry button whose label changes per
 * page, or an error that shows a raw exception in one place and a friendly sentence in another, is
 * how a console starts feeling unreliable — the reader stops trusting the pages that look fine.
 *
 * The error branch prints `title` and `detail` from the RFC 9457 problem, and the error code in
 * mono. It never dumps a stack: the code is what a developer needs to search for, and the stack is
 * what leaks internals into a screenshot.
 */
const props = defineProps<{
  loading?: boolean;
  error?: unknown;
  /** Show the empty branch instead of the default slot. */
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  /** Retry handler; when absent the error branch shows no button. */
  onRetry?: () => void;
}>();

function title(error: unknown): string {
  if (error && typeof error === "object" && "problem" in error) {
    const problem = (error as { problem?: { title?: string; detail?: string } }).problem;
    if (problem?.title) return problem.title;
  }
  if (error instanceof Error && error.message) return error.message;
  return t("error.loadFailed");
}

function detail(error: unknown): string | undefined {
  if (error && typeof error === "object" && "problem" in error) {
    return (error as { problem?: { detail?: string } }).problem?.detail;
  }
  return undefined;
}

function code(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
</script>

<template>
  <!-- Skeletons, not a spinner: the page keeps its shape while it loads, so nothing jumps. -->
  <div v-if="props.loading" class="flex flex-col gap-3 pt-4" aria-busy="true" :aria-label="t('common.loading')">
    <Skeleton class="h-8 w-64" />
    <Skeleton class="h-40 w-full" />
    <Skeleton class="h-5 w-40" />
  </div>

  <Alert v-else-if="props.error" variant="error" class="mt-4">
    <CircleAlert />
    <div class="min-w-0">
      <AlertTitle>{{ title(props.error) }}</AlertTitle>
      <AlertDescription>
        <template v-if="detail(props.error)">{{ detail(props.error) }}</template>
        <template v-else>{{ t("error.loadFailedHint") }}</template>
      </AlertDescription>
      <p v-if="code(props.error)" class="mono-data mt-1.5 text-[11.5px] text-ink-faint">{{ code(props.error) }}</p>
      <Button v-if="props.onRetry" variant="secondary" size="sm" class="mt-2.5" @click="props.onRetry()">
        <RotateCw />
        {{ t("common.retry") }}
      </Button>
    </div>
  </Alert>

  <!-- Empty is an invitation to act, so it always says what to do next. -->
  <div v-else-if="props.empty" class="flex flex-col items-center gap-1.5 py-16 text-center">
    <Inbox class="size-5 text-ink-faint" aria-hidden="true" />
    <p class="text-[13px] font-medium text-ink">{{ props.emptyTitle ?? t("common.none") }}</p>
    <p v-if="props.emptyHint" class="max-w-sm text-[12.5px] leading-snug text-ink-muted">{{ props.emptyHint }}</p>
    <slot name="empty-action" />
  </div>

  <slot v-else />
</template>
