<script setup lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  NativeSelect,
  ScopeBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@monaca/ui";
import { Plus, RefreshCw, Trash2 } from "lucide-vue-next";
import { computed, ref } from "vue";

import { describeError } from "@/api/contract";
import { DEMO_RESOURCE } from "@/api/fixtures";
import type { Grant, OrgRole } from "@/api/types";
import PageHeader from "@/components/PageHeader.vue";
import QueryBoundary from "@/components/QueryBoundary.vue";
import { t } from "@/i18n";
import { useAgents, useCreateGrant, useGrants, useMembers, useRevokeGrant } from "@/queries";
import { useUiStore } from "@/stores/ui";

/**
 * Grants.
 *
 * One row per grant, with the two facts that decide everything read from the row itself: the scope
 * chips and the resource it is scoped to. A grant that is expired or revoked stays visible with a
 * status badge rather than disappearing — "why did this token fail" is answered by what is still on
 * screen, and a console that hides revoked grants makes that question unanswerable.
 *
 * The expiry filter is a status filter, not a date picker: in practice people ask "what is active",
 * not "what expired between the 3rd and the 9th".
 */
const ui = useUiStore();
const org = computed(() => ui.org);

const grants = useGrants(org);
const agents = useAgents(org);
const members = useMembers(org);
const createGrant = useCreateGrant(org);
const revokeGrant = useRevokeGrant(org);

type StatusFilter = "all" | "active" | "revoked" | "expired";
const statusFilter = ref<StatusFilter>("active");

const open = ref(false);
const agentId = ref("");
const accountId = ref("");
const scopes = ref<string[]>(["tools:read"]);
const resource = ref(DEMO_RESOURCE);
const formError = ref<string | null>(null);

const revokeTarget = ref<Grant | null>(null);

const AVAILABLE_SCOPES = ["tools:read", "tools:write"] as const;

function statusOf(grant: Grant): StatusFilter {
  if (grant.revoked_at !== null) return "revoked";
  if (grant.expires_at !== null && Date.parse(grant.expires_at) <= Date.now()) return "expired";
  return "active";
}

const statusLabel: Record<StatusFilter, string> = {
  all: t("grants.filterAll"),
  active: t("grants.statusActive"),
  revoked: t("grants.statusRevoked"),
  expired: t("grants.statusExpired"),
};

const rows = computed(() => {
  const items = grants.data.value?.items ?? [];
  return statusFilter.value === "all" ? items : items.filter((grant) => statusOf(grant) === statusFilter.value);
});

const counts = computed(() => {
  const items = grants.data.value?.items ?? [];
  return {
    all: items.length,
    active: items.filter((grant) => statusOf(grant) === "active").length,
    revoked: items.filter((grant) => statusOf(grant) === "revoked").length,
    expired: items.filter((grant) => statusOf(grant) === "expired").length,
  };
});

const agentOptions = computed(() => agents.data.value?.items ?? []);
const memberOptions = computed(() => members.data.value?.items ?? []);

function openDialog(): void {
  agentId.value = agentOptions.value[0]?.id ?? "";
  accountId.value = memberOptions.value[0]?.account_id ?? "";
  scopes.value = ["tools:read"];
  resource.value = DEMO_RESOURCE;
  formError.value = null;
  open.value = true;
}

function toggleScope(scope: string): void {
  scopes.value = scopes.value.includes(scope)
    ? scopes.value.filter((value) => value !== scope)
    : [...scopes.value, scope];
}

async function submit(): Promise<void> {
  if (scopes.value.length === 0) {
    formError.value = "A grant needs at least one scope.";
    return;
  }
  if (!/^https?:\/\//.test(resource.value)) {
    formError.value = "The resource must be an absolute http(s) URL.";
    return;
  }
  formError.value = null;

  try {
    await createGrant.mutateAsync({
      agent_id: agentId.value,
      account_id: accountId.value,
      scopes: scopes.value,
      resource: resource.value,
      expires_at: null,
    });
    toast({ title: t("grants.statusActive"), variant: "success", description: scopes.value.join(" ") });
    open.value = false;
  } catch (error) {
    formError.value = describeError(error).title;
  }
}

async function confirmRevoke(): Promise<void> {
  const grant = revokeTarget.value;
  if (!grant) return;
  try {
    await revokeGrant.mutateAsync(grant.id);
    toast({ title: t("grants.revoked"), description: grant.id, variant: "success" });
    revokeTarget.value = null;
  } catch (error) {
    toast({ title: t("grants.revokeFailed"), description: describeError(error).title, variant: "error" });
  }
}

function agentName(id: string): string {
  return agentOptions.value.find((agent) => agent.id === id)?.name ?? id;
}

function memberEmail(id: string): string {
  return memberOptions.value.find((member) => member.account_id === id)?.email ?? id;
}

const roleOf = (id: string): OrgRole | undefined =>
  memberOptions.value.find((member) => member.account_id === id)?.role;
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader
      :title="t('grants.title')"
      :subtitle="t('grants.subtitle')"
      :stats="[
        t('grants.count', { count: counts.all }),
        `${counts.active} ${statusLabel.active.toLowerCase()}`,
      ]"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="grants.refetch()">
          <RefreshCw :class="grants.isFetching.value ? 'animate-spin' : ''" />
          {{ t('common.refresh') }}
        </Button>
        <Button variant="primary" size="sm" @click="openDialog">
          <Plus />
          {{ t('grants.title') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Status as a segmented row, since there are exactly four states and no free-text need. -->
    <div class="flex flex-wrap items-center gap-1.5" role="group" :aria-label="t('grants.filterStatus')">
      <Button
        v-for="option in (['active', 'all', 'revoked', 'expired'] as StatusFilter[])"
        :key="option"
        :variant="statusFilter === option ? 'secondary' : 'ghost'"
        size="xs"
        :aria-pressed="statusFilter === option"
        @click="statusFilter = option"
      >
        {{ statusLabel[option] }}
        <span class="mono-data text-[11px] text-ink-faint">{{ counts[option] }}</span>
      </Button>
    </div>

    <QueryBoundary
      :loading="grants.isPending.value"
      :error="grants.error.value"
      :empty="rows.length === 0"
      :empty-title="counts.all === 0 ? t('grants.empty') : t('grants.filterStatus')"
      :empty-hint="counts.all === 0 ? t('grants.emptyHint') : undefined"
      :on-retry="() => grants.refetch()"
    >
      <Table>
        <TableHeader>
          <TableRow class="hover:bg-transparent">
            <TableHead>{{ t('grants.agent') }}</TableHead>
            <TableHead>{{ t('grants.delegator') }}</TableHead>
            <TableHead>{{ t('grants.scopes') }}</TableHead>
            <TableHead>{{ t('grants.resource') }}</TableHead>
            <TableHead>{{ t('grants.status') }}</TableHead>
            <TableHead class="w-[1%]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="grant in rows" :key="grant.id">
            <TableCell>
              <span class="font-medium text-ink">{{ agentName(grant.agent_id) }}</span>
              <span class="mono-data mt-0.5 block text-[11px] text-ink-faint">{{ grant.id }}</span>
            </TableCell>
            <TableCell class="text-ink-muted">
              {{ memberEmail(grant.account_id) }}
              <Badge v-if="roleOf(grant.account_id)" variant="muted" class="ml-1.5">
                {{ roleOf(grant.account_id) }}
              </Badge>
            </TableCell>
            <TableCell>
              <div class="flex flex-wrap gap-1">
                <ScopeBadge v-for="scope in grant.scopes" :key="scope" :scope="scope" />
              </div>
            </TableCell>
            <TableCell class="mono-data max-w-[24ch] truncate text-[11.5px] text-ink-muted" :title="grant.resource">
              {{ grant.resource }}
            </TableCell>
            <TableCell>
              <Badge
                :variant="
                  statusOf(grant) === 'active' ? 'allow' : statusOf(grant) === 'revoked' ? 'deny' : 'warn'
                "
              >
                {{ statusLabel[statusOf(grant)] }}
              </Badge>
            </TableCell>
            <TableCell>
              <Button
                v-if="statusOf(grant) === 'active'"
                variant="ghost"
                size="icon-sm"
                :aria-label="t('grants.revoke')"
                @click="revokeTarget = grant"
              >
                <Trash2 />
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </QueryBoundary>

    <!-- Create. -->
    <Dialog v-model:open="open">
      <DialogContent class="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{{ t('grants.title') }}</DialogTitle>
          <DialogDescription>{{ t('grants.emptyHint') }}</DialogDescription>
        </DialogHeader>

        <form class="flex flex-col gap-3.5" @submit.prevent="submit">
          <div class="flex flex-col gap-1.5">
            <label class="text-[12px] font-medium text-ink-muted" for="grant-agent">{{ t('grants.agent') }}</label>
            <NativeSelect id="grant-agent" v-model="agentId">
              <option v-for="agent in agentOptions" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </NativeSelect>
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-[12px] font-medium text-ink-muted" for="grant-account">
              {{ t('grants.delegator') }}
            </label>
            <NativeSelect id="grant-account" v-model="accountId">
              <option v-for="member in memberOptions" :key="member.account_id" :value="member.account_id">
                {{ member.email }}
              </option>
            </NativeSelect>
          </div>

          <fieldset class="flex flex-col gap-1.5 border-0 p-0">
            <legend class="mb-1.5 text-[12px] font-medium text-ink-muted">{{ t('grants.scopes') }}</legend>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="scope in AVAILABLE_SCOPES"
                :key="scope"
                type="button"
                :aria-pressed="scopes.includes(scope)"
                class="rounded-sm outline-offset-2"
                @click="toggleScope(scope)"
              >
                <ScopeBadge :scope="scope" :state="scopes.includes(scope) ? 'granted' : 'dropped'" />
              </button>
            </div>
          </fieldset>

          <div class="flex flex-col gap-1.5">
            <label class="text-[12px] font-medium text-ink-muted" for="grant-resource">
              {{ t('grants.resource') }}
            </label>
            <input
              id="grant-resource"
              v-model="resource"
              class="mono-data h-8 w-full rounded-md border border-rule bg-surface px-2.5 text-[12.5px] text-ink focus-visible:border-brand"
              spellcheck="false"
            />
          </div>

          <p v-if="formError" class="text-[12.5px] text-deny">{{ formError }}</p>

          <DialogFooter>
            <Button variant="ghost" type="button" @click="open = false">{{ t('common.cancel') }}</Button>
            <Button variant="primary" type="submit" :disabled="createGrant.isPending.value">
              {{ createGrant.isPending.value ? t('common.saving') : t('common.yes') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- Revoke. -->
    <Dialog
      :open="revokeTarget !== null"
      @update:open="(value: boolean) => (value ? null : (revokeTarget = null))"
    >
      <DialogContent class="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t('grants.revokeTitle') }}</DialogTitle>
          <DialogDescription>
            {{ t('grants.revokeDescription', { agent: revokeTarget ? agentName(revokeTarget.agent_id) : '' }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="revokeTarget = null">{{ t('common.cancel') }}</Button>
          <Button variant="danger" :disabled="revokeGrant.isPending.value" @click="confirmRevoke">
            <Trash2 />
            {{ t('grants.revoke') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
