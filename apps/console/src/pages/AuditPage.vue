<script setup lang="ts">
import { AuditTimeline, Button, NativeSelect, toast } from "@monaca/ui";
import { RefreshCw, ShieldCheck } from "lucide-vue-next";
import { computed, ref, watch } from "vue";

import { api } from "@/api";
import { describeError } from "@/api/contract";
import type { AuditEvent } from "@/api/types";
import PageHeader from "@/components/PageHeader.vue";
import QueryBoundary from "@/components/QueryBoundary.vue";
import { t } from "@/i18n";
import { useAudit, useGrants, useVerifyAudit } from "@/queries";
import { useUiStore } from "@/stores/ui";
import { M0_ACTIONS } from "@monaca/ui";

/**
 * Audit.
 *
 * The timeline is the page: the chain link is the structure, so there is no table here. Above it sit
 * the two things a reader needs before trusting what they see — the action filter, which makes gaps
 * in the chain expected (and the timeline says so rather than showing them as breaks), and the
 * verify button, which is the only authority on whether the chain is intact.
 *
 * Paging follows the contract exactly: `GET /v1/orgs/{org}/audit` takes `before=<seq>` and returns
 * `next` as the seq to pass back. The first page is a query (so it is cached, invalidated after
 * writes, and shared with the Overview page); older pages accumulate here, because they are
 * append-only history that cannot change and therefore does not belong in a cache.
 */
const PAGE_SIZE = 50;

const ui = useUiStore();
const org = computed(() => ui.org);

const action = ref("");
const firstPage = useAudit(org, computed(() => ({ action: action.value || undefined, limit: PAGE_SIZE })));
const grants = useGrants(org);
const verify = useVerifyAudit(org);

/** Older pages, oldest last. Cleared whenever the filter changes, since they belong to it. */
const older = ref<AuditEvent[]>([]);
const olderCursor = ref<number | null>(null);
const loadingOlder = ref(false);

watch(action, () => {
  older.value = [];
  olderCursor.value = null;
});

const events = computed(() => {
  const first = firstPage.data.value?.items ?? [];
  const seen = new Set(first.map((event) => event.id));
  return [...first, ...older.value.filter((event) => !seen.has(event.id))];
});

/** The cursor for the next fetch: the first page's `next`, or the last older page's. */
const nextCursor = computed(() => {
  if (older.value.length === 0) return firstPage.data.value?.next ?? null;
  return olderCursor.value;
});

const hasMore = computed(() => nextCursor.value !== null && events.value.length > 0);

async function loadOlder(): Promise<void> {
  const cursor = nextCursor.value;
  if (cursor === null || loadingOlder.value) return;

  loadingOlder.value = true;
  try {
    const page = await api.listAudit(org.value, {
      action: action.value || undefined,
      before: Number(cursor),
      limit: PAGE_SIZE,
    });
    older.value = [...older.value, ...page.items];
    olderCursor.value = page.next === null ? null : Number(page.next);
  } catch (error) {
    toast({ title: t("error.loadFailed"), description: describeError(error).title, variant: "error" });
  } finally {
    loadingOlder.value = false;
  }
}

async function runVerify(): Promise<void> {
  try {
    const result = await verify.mutateAsync();
    toast({
      title: result.valid ? t("audit.verified") : t("audit.broken"),
      description: result.valid
        ? t("audit.verifiedDescription", { count: result.checked })
        : t("audit.brokenDescription", {
            seq: result.first_broken?.seq ?? 0,
            reason: result.first_broken?.reason ?? "unknown",
          }),
      variant: result.valid ? "success" : "error",
    });
  } catch {
    toast({ title: t("audit.verifyFailed"), variant: "error" });
  }
}

function refresh(): void {
  older.value = [];
  olderCursor.value = null;
  void firstPage.refetch();
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader
      :title="t('audit.title')"
      :subtitle="t('audit.subtitle', { org })"
      :stats="[t('audit.count', { count: events.length })]"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="refresh">
          <RefreshCw :class="firstPage.isFetching.value ? 'animate-spin' : ''" />
          {{ t('common.refresh') }}
        </Button>
        <Button variant="primary" size="sm" :disabled="verify.isPending.value" @click="runVerify">
          <ShieldCheck />
          {{ verify.isPending.value ? t('audit.verifying') : t('audit.verify') }}
        </Button>
      </template>
    </PageHeader>

    <div class="flex flex-wrap items-center gap-2.5">
      <label class="sr-only" for="audit-action">{{ t('audit.filterAction') }}</label>
      <NativeSelect id="audit-action" class="w-60" :model-value="action" @update:model-value="action = $event">
        <option value="">{{ t('audit.filterAll') }}</option>
        <option v-for="known in M0_ACTIONS" :key="known" :value="known">{{ known }}</option>
      </NativeSelect>

      <span class="mono-data text-[11.5px] text-ink-faint">
        {{ (grants.data.value?.items ?? []).length }} {{ t('nav.grants').toLowerCase() }}
      </span>
    </div>

    <QueryBoundary
      :loading="firstPage.isPending.value"
      :error="firstPage.error.value"
      :empty="events.length === 0"
      :empty-title="t('audit.empty')"
      :empty-hint="t('audit.emptyHint')"
      :on-retry="() => firstPage.refetch()"
    >
      <AuditTimeline
        :events="events"
        :integrity="verify.data.value"
        :filtered="action !== ''"
      />

      <div v-if="hasMore" class="flex justify-center pt-4">
        <Button variant="secondary" size="sm" :disabled="loadingOlder" @click="loadOlder">
          {{ loadingOlder ? t('common.loading') : t('audit.loadMore') }}
        </Button>
      </div>
    </QueryBoundary>
  </div>
</template>
