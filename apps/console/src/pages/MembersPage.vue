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
  Input,
  Label,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@monaca/ui";
import { Plus, RefreshCw } from "lucide-vue-next";
import { computed, ref, watch } from "vue";

import { describeError } from "@/api/contract";
import type { OrgRole } from "@/api/types";
import PageHeader from "@/components/PageHeader.vue";
import QueryBoundary from "@/components/QueryBoundary.vue";
import { t } from "@/i18n";
import { useAddMember, useMembers } from "@/queries";
import { useUiStore } from "@/stores/ui";

/**
 * Members.
 *
 * A flat table, because that is what the data is: one row per account, three facts each. No
 * avatars (there are none in the contract), no expandable rows, no grouping — the moment a table
 * of five rows needs a disclosure triangle, it should have been a different page.
 */
const ui = useUiStore();
const org = computed(() => ui.org);

const members = useMembers(org);
const addMember = useAddMember(org);

const open = ref(false);
const accountId = ref("");
const role = ref<OrgRole>("member");
const formError = ref<string | null>(null);

const roleLabel: Record<OrgRole, string> = {
  owner: t("members.roleOwner"),
  admin: t("members.roleAdmin"),
  member: t("members.roleMember"),
};

/** The account id must look like a typed id before we spend a round trip on it (§5.2). */
const accountIdLooksValid = computed(() => /^acc_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(accountId.value.trim()));

function openDialog(): void {
  accountId.value = "";
  role.value = "member";
  formError.value = null;
  open.value = true;
}

watch(accountId, () => (formError.value = null));

async function submit(): Promise<void> {
  if (!accountIdLooksValid.value) {
    formError.value = t("members.accountIdHint");
    return;
  }
  formError.value = null;
  try {
    const member = await addMember.mutateAsync({ account_id: accountId.value.trim(), role: role.value });
    toast({
      title: t("members.added"),
      description: t("members.addedDescription", { email: member.email, role: roleLabel[member.role] }),
      variant: "success",
    });
    open.value = false;
  } catch (error) {
    formError.value = describeError(error).title;
  }
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader
      :title="t('members.title')"
      :subtitle="t('members.subtitle', { org })"
      :stats="members.data.value ? [t('members.count', { count: members.data.value.items.length })] : []"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="members.refetch()">
          <RefreshCw :class="members.isFetching.value ? 'animate-spin' : ''" />
          {{ t('common.refresh') }}
        </Button>
        <Button variant="primary" size="sm" @click="openDialog">
          <Plus />
          {{ t('members.invite') }}
        </Button>
      </template>
    </PageHeader>

    <QueryBoundary
      :loading="members.isPending.value"
      :error="members.error.value"
      :empty="(members.data.value?.items.length ?? 0) === 0"
      :empty-title="t('members.empty')"
      :empty-hint="t('members.emptyHint')"
      :on-retry="() => members.refetch()"
    >
      <template #empty-action>
        <Button variant="primary" size="sm" class="mt-2" @click="openDialog">
          <Plus />
          {{ t('members.invite') }}
        </Button>
      </template>

      <Table>
        <TableHeader>
          <TableRow class="hover:bg-transparent">
            <TableHead>{{ t('members.account') }}</TableHead>
            <TableHead>{{ t('members.email') }}</TableHead>
            <TableHead>{{ t('members.role') }}</TableHead>
            <TableHead>{{ t('members.accountId') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="member in members.data.value?.items ?? []" :key="member.account_id">
            <TableCell class="font-medium text-ink">{{ member.email.split('@')[0] }}</TableCell>
            <TableCell class="text-ink-muted">{{ member.email }}</TableCell>
            <TableCell>
              <Badge :variant="member.role === 'owner' ? 'brand' : member.role === 'admin' ? 'info' : 'muted'">
                {{ roleLabel[member.role] }}
              </Badge>
            </TableCell>
            <TableCell class="mono-data text-[11.5px] text-ink-faint">{{ member.account_id }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </QueryBoundary>

    <Dialog v-model:open="open">
      <DialogContent class="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{{ t('members.inviteTitle', { org }) }}</DialogTitle>
          <DialogDescription>{{ t('members.inviteDescription') }}</DialogDescription>
        </DialogHeader>

        <form class="flex flex-col gap-3.5" @submit.prevent="submit">
          <div class="flex flex-col gap-1.5">
            <Label for="member-account">{{ t('members.accountId') }}</Label>
            <Input
              id="member-account"
              v-model="accountId"
              :invalid="accountId.length > 0 && !accountIdLooksValid"
              placeholder="acc_01h455vb4pex5vsknk084sn02q"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="text-[11.5px] leading-snug text-ink-faint">{{ t('members.accountIdHint') }}</p>
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="member-role">{{ t('members.role') }}</Label>
            <NativeSelect id="member-role" v-model="role">
              <option value="member">{{ roleLabel.member }}</option>
              <option value="admin">{{ roleLabel.admin }}</option>
              <option value="owner">{{ roleLabel.owner }}</option>
            </NativeSelect>
          </div>

          <p v-if="formError" class="text-[12.5px] text-deny">{{ formError }}</p>

          <DialogFooter>
            <Button variant="ghost" type="button" @click="open = false">{{ t('common.cancel') }}</Button>
            <Button variant="primary" type="submit" :disabled="addMember.isPending.value">
              {{ addMember.isPending.value ? t('common.saving') : t('members.invite') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
