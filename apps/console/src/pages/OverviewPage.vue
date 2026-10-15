<script setup lang="ts">
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@monaca/ui";
import { RefreshCw, ShieldCheck, ShieldQuestion } from "lucide-vue-next";
import { computed } from "vue";
import { RouterLink } from "vue-router";

import PageHeader from "@/components/PageHeader.vue";
import { t } from "@/i18n";
import { useAgents, useAudit, useGrants, useMembers, useVerifyAudit } from "@/queries";
import { useUiStore } from "@/stores/ui";

/**
 * Overview.
 *
 * The one place the console raises its voice. Everything else is disciplined tables and hairline
 * rules; here the audit chain head gets a seal — the largest type on the page, in the accent, with
 * a real verify button beside it. That is the product's actual claim (every decision is in an
 * append-only chain you can re-check), so it is the only thing on screen allowed to look important.
 *
 * The counters above it are deliberately not cards. Four equal rounded boxes is the default the
 * brief asks us to avoid, so they are one row of figures divided by rules, which also reads faster.
 */
const ui = useUiStore();
const org = computed(() => ui.org);

const members = useMembers(org);
const agents = useAgents(org);
const grants = useGrants(org);
const audit = useAudit(org, { limit: 12 });
const verify = useVerifyAudit(org);

const stats = computed(() => {
  const agentList = agents.data.value?.items ?? [];
  const grantList = grants.data.value?.items ?? [];
  return {
    members: members.data.value?.items.length ?? 0,
    agents: agentList.filter((agent) => agent.state === "active").length,
    agentsTotal: agentList.length,
    grants: grantList.filter((grant) => grant.revoked_at === null).length,
    grantsTotal: grantList.length,
    keys: agentList.reduce((total, agent) => total + agent.keys.filter((key) => key.revoked_at === null).length, 0),
  };
});

/** Decisions over the last 24h, and what share of them were allowed. */
const day = computed(() => {
  const events = audit.data.value?.items ?? [];
  const cutoff = Date.now() - 24 * 3_600_000;
  const recent = events.filter((event) => Date.parse(event.at) >= cutoff);
  const allowed = recent.filter((event) => event.decision === "allow").length;
  return { total: recent.length, allowed, rate: recent.length === 0 ? null : allowed / recent.length };
});

const lastEvent = computed(() => audit.data.value?.items[0] ?? null);

const chainVerdict = computed(() => {
  if (verify.isPending.value) return "checking" as const;
  const result = verify.data.value;
  if (!result) return "unknown" as const;
  return result.valid ? ("valid" as const) : ("broken" as const);
});

async function runVerify(): Promise<void> {
  await verify.mutateAsync().catch(() => undefined);
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader
      :title="t('overview.title')"
      :subtitle="t('overview.subtitle', { org })"
      :stats="[
        `${stats.members} ${t('nav.members').toLowerCase()}`,
        `${stats.agents} ${t('nav.agents').toLowerCase()}`,
        `${stats.grants} ${t('nav.grants').toLowerCase()}`,
        `${stats.keys} keys`,
      ]"
    >
      <template #actions>
        <Button
          variant="ghost"
          size="sm"
          :disabled="members.isFetching.value || agents.isFetching.value || grants.isFetching.value"
          @click="
            () => {
              members.refetch();
              agents.refetch();
              grants.refetch();
              audit.refetch();
            }
          "
        >
          <RefreshCw :class="audit.isFetching.value ? 'animate-spin' : ''" />
          {{ t('common.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Counters: one row of figures divided by hairlines, not four rounded cards. -->
    <div class="grid grid-cols-2 divide-rule border-b border-rule pb-4 sm:grid-cols-4 sm:divide-x">
      <div class="px-0 sm:px-4 sm:first:pl-0">
        <p class="text-[11.5px] font-medium text-ink-faint">{{ t('overview.agents') }}</p>
        <p class="mono-data mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em]">
          {{ stats.agents }}
          <span class="text-[13px] font-normal text-ink-faint">/ {{ stats.agentsTotal }}</span>
        </p>
      </div>
      <div class="px-0 sm:px-4">
        <p class="text-[11.5px] font-medium text-ink-faint">{{ t('overview.grants') }}</p>
        <p class="mono-data mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em]">
          {{ stats.grants }}
          <span class="text-[13px] font-normal text-ink-faint">/ {{ stats.grantsTotal }}</span>
        </p>
      </div>
      <div class="px-0 sm:px-4">
        <p class="text-[11.5px] font-medium text-ink-faint">{{ t('overview.members') }}</p>
        <p class="mono-data mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em]">{{ stats.members }}</p>
      </div>
      <div class="px-0 sm:px-4">
        <p class="text-[11.5px] font-medium text-ink-faint">{{ t('overview.decisions24h') }}</p>
        <p class="mono-data mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em]">
          {{ day.total }}
          <span class="text-[13px] font-normal text-ink-faint">· {{ percent(day.rate) }} {{ t('overview.allowRate').toLowerCase() }}</span>
        </p>
      </div>
    </div>

    <!-- The seal. -->
    <Card>
      <CardHeader class="flex-row items-center justify-between gap-3">
        <CardTitle class="text-[14px]">{{ t('overview.chain') }}</CardTitle>
        <Badge :variant="chainVerdict === 'valid' ? 'allow' : chainVerdict === 'broken' ? 'deny' : 'muted'">
          <ShieldCheck v-if="chainVerdict === 'valid'" class="size-3" />
          <ShieldQuestion v-else class="size-3" />
          {{
            chainVerdict === "valid"
              ? t('overview.chainVerified')
              : chainVerdict === "broken"
                ? t('overview.chainBroken')
                : t('overview.chainUnverified')
          }}
        </Badge>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <p class="max-w-[68ch] text-[12.5px] leading-relaxed text-ink-muted">{{ t('overview.chainHint') }}</p>

        <div class="flex flex-wrap items-end justify-between gap-4">
          <div class="min-w-0">
            <p class="text-[11.5px] font-medium text-ink-faint">{{ t('overview.chainHead') }}</p>
            <Skeleton v-if="audit.isPending.value" class="mt-1.5 h-7 w-72" />
            <p v-else class="mono-data mt-1 break-all text-[15px] font-medium leading-snug text-brand-ink">
              {{ lastEvent?.hash ?? "—" }}
            </p>
            <p v-if="lastEvent" class="mono-data mt-1 text-[11.5px] text-ink-faint">
              seq {{ lastEvent.seq }} · {{ lastEvent.at }}
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <RouterLink :to="{ name: 'audit' }">
              <Button variant="secondary" size="sm">{{ t('overview.viewAll') }}</Button>
            </RouterLink>
            <Button variant="primary" size="sm" :disabled="verify.isPending.value" @click="runVerify">
              <RefreshCw :class="verify.isPending.value ? 'animate-spin' : ''" />
              {{ verify.isPending.value ? t('overview.verifying') : t('overview.verifyNow') }}
            </Button>
          </div>
        </div>

        <p
          v-if="verify.data.value"
          class="mono-data text-[11.5px]"
          :class="verify.data.value.valid ? 'text-allow' : 'text-deny'"
        >
          {{
            verify.data.value.valid
              ? `${t('audit.verified')} · ${verify.data.value.checked} ${t('overview.chainSeq').toLowerCase()}`
              : `${t('audit.broken')} · seq ${verify.data.value.first_broken?.seq} · ${verify.data.value.first_broken?.reason}`
          }}
        </p>
        <p v-else-if="verify.error.value" class="text-[11.5px] text-deny">
          {{ t('audit.verifyFailed') }}
        </p>
      </CardContent>
    </Card>

    <!-- Recent decisions. A short list that links out, not a second audit page. -->
    <section class="flex flex-col gap-2.5">
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-[13.5px] font-semibold tracking-[-0.01em]">{{ t('overview.recent') }}</h2>
        <p class="text-[12px] text-ink-faint">{{ t('overview.recentHint') }}</p>
      </div>

      <Skeleton v-if="audit.isPending.value" class="h-32 w-full" />
      <ul v-else class="flex list-none flex-col p-0">
        <li
          v-for="event in audit.data.value?.items ?? []"
          :key="event.id"
          class="flex items-center gap-3 border-b border-rule py-2 text-[12.5px] last:border-b-0"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            :class="
              event.decision === 'allow' ? 'bg-allow' : event.decision === 'deny' ? 'bg-deny' : 'bg-ink-faint'
            "
            :aria-label="event.decision"
          />
          <span class="mono-data shrink-0 font-medium text-ink">{{ event.action }}</span>
          <span class="min-w-0 flex-1 truncate text-ink-muted">
            {{ event.subject.type === "tool" ? event.subject.id : event.subject.id }}
          </span>
          <span class="mono-data shrink-0 text-[11.5px] text-ink-faint">{{ event.at.slice(11, 19) }}</span>
        </li>
        <li v-if="(audit.data.value?.items.length ?? 0) === 0" class="py-8 text-center text-[13px] text-ink-muted">
          {{ t('overview.noEvents') }}
        </li>
      </ul>
    </section>
  </div>
</template>
