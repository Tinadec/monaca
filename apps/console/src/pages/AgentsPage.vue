<script setup lang="ts">
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  KeyFingerprint,
  Label,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@monaca/ui";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-vue-next";
import { computed, nextTick, ref, watch } from "vue";

import { describeError } from "@/api/contract";
import type { Agent } from "@/api/types";
import PageHeader from "@/components/PageHeader.vue";
import QueryBoundary from "@/components/QueryBoundary.vue";
import {
  GenerateKeyError,
  downloadPrivateJwk,
  generateEs256Key,
  type GeneratedKey,
} from "@/composables/use-agent-key";
import { t } from "@/i18n";
import { useAgents, useCreateAgent, useMembers, useRegisterAgentKey, useRevokeAgentKey } from "@/queries";
import { useUiStore } from "@/stores/ui";

/**
 * Agents — the page where the product's security story is actually performed.
 *
 * Registering an agent runs in two deliberate steps, and the split is the design:
 *
 *   1. **Generate** — the key pair is created by WebCrypto *in this tab*. Nothing is sent.
 *   2. **Register** — the public half and its RFC 7638 thumbprint are uploaded; the private half is
 *      offered as a download and then discarded.
 *
 * A single "Register" button that did both would hide the moment that matters. Splitting it means
 * the user sees the fingerprint before anything is transmitted, and sees the private key leave only
 * as a file they chose to save. The page states, in place, that the private key is never uploaded —
 * because a claim like that is worth nothing if the user has to take it on faith.
 */
const ui = useUiStore();
const org = computed(() => ui.org);

const agents = useAgents(org);
const members = useMembers(org);
const createAgent = useCreateAgent(org);
const registerKey = useRegisterAgentKey(org);
const revokeKey = useRevokeAgentKey(org);

type Step = "details" | "key" | "done";

const open = ref(false);
const step = ref<Step>("details");
const name = ref("");
const description = ref("");
const ownerId = ref("");
const formError = ref<string | null>(null);

let generated: GeneratedKey | null = null;
/** Mirrored into refs only for *display* — never the private half. */
const publicFingerprint = ref<string | null>(null);
const publicKid = ref<string | null>(null);
const publicJwkPreview = ref<string>("{}");
const hasGenerated = ref(false);
const privateDownloaded = ref(false);
const registeredAgent = ref<Agent | null>(null);

const revokeTarget = ref<{ agent: Agent; keyId: string; kid: string } | null>(null);

const nameLooksValid = computed(() => /^[a-z0-9][a-z0-9-]{1,62}$/.test(name.value.trim()));

const ownerOptions = computed(() => members.data.value?.items ?? []);

function openDialog(): void {
  step.value = "details";
  name.value = "";
  description.value = "";
  ownerId.value = ownerOptions.value[0]?.account_id ?? "";
  formError.value = null;
  generated = null;
  publicFingerprint.value = null;
  publicKid.value = null;
  publicJwkPreview.value = "{}";
  hasGenerated.value = false;
  privateDownloaded.value = false;
  registeredAgent.value = null;
  open.value = true;
}

watch(name, () => (formError.value = null));

/** Step 1: create the agent record, then generate the key locally. No key material is sent yet. */
async function submitDetails(): Promise<void> {
  if (!nameLooksValid.value) {
    formError.value = t("agents.registerNameHint");
    return;
  }
  if (!ownerId.value) {
    formError.value = t("agents.registerOwnerHint");
    return;
  }
  formError.value = null;

  try {
    const agent = await createAgent.mutateAsync({
      name: name.value.trim(),
      description: description.value.trim(),
      owner_account_id: ownerId.value,
    });
    registeredAgent.value = agent;

    generated = await generateEs256Key(agent.keys);
    publicFingerprint.value = generated.fingerprint;
    publicKid.value = generated.kid;
    // Only the public half is mirrored into reactive state, so the private key is never reachable
    // from a devtools state dump or an error reporter.
    publicJwkPreview.value = JSON.stringify(generated.publicJwk, null, 2);
    hasGenerated.value = true;
    step.value = "key";
  } catch (error) {
    formError.value =
      error instanceof GenerateKeyError ? error.message : describeError(error).title;
  }
}

/** Step 2: upload only the public half and its thumbprint. */
async function submitKey(): Promise<void> {
  const agent = registeredAgent.value;
  if (!agent || !generated) return;

  formError.value = null;
  try {
    const updated = await registerKey.mutateAsync({
      agentId: agent.id,
      body: { public_jwk: generated.publicJwk, alg: "ES256", kid: generated.kid },
    });
    registeredAgent.value = updated;
    step.value = "done";
    toast({
      title: t("agents.registered"),
      description: t("agents.registeredDescription", { name: updated.name }),
      variant: "success",
    });
  } catch (error) {
    formError.value = describeError(error).title;
  }
}

function downloadKey(): void {
  if (!generated || !registeredAgent.value) return;
  downloadPrivateJwk(generated.privateJwk, `${registeredAgent.value.name}.${generated.kid}.private.jwk.json`);
  privateDownloaded.value = true;
}

async function copyJson(value: unknown): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
  toast({ title: t("common.copied"), variant: "success" });
}

/** Close for good: drop the private key from memory and reset the wizard. */
function close(): void {
  generated = null;
  hasGenerated.value = false;
  open.value = false;
  void nextTick(() => {
    publicFingerprint.value = null;
    publicKid.value = null;
    publicJwkPreview.value = "{}";
  });
}

async function confirmRevoke(): Promise<void> {
  const target = revokeTarget.value;
  if (!target) return;
  try {
    await revokeKey.mutateAsync({ agentId: target.agent.id, keyId: target.keyId });
    toast({ title: t("agents.keyRevoked"), description: target.kid, variant: "success" });
    revokeTarget.value = null;
  } catch (error) {
    toast({ title: t("agents.revokeFailed"), description: describeError(error).title, variant: "error" });
  }
}

function activeKeys(agent: Agent) {
  return agent.keys.filter((key) => key.revoked_at === null);
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader
      :title="t('agents.title')"
      :subtitle="t('agents.subtitle', { org })"
      :stats="agents.data.value ? [t('agents.count', { count: agents.data.value.items.length })] : []"
    >
      <template #actions>
        <Button variant="ghost" size="sm" @click="agents.refetch()">
          <RefreshCw :class="agents.isFetching.value ? 'animate-spin' : ''" />
          {{ t('common.refresh') }}
        </Button>
        <Button variant="primary" size="sm" @click="openDialog">
          <Plus />
          {{ t('agents.register') }}
        </Button>
      </template>
    </PageHeader>

    <QueryBoundary
      :loading="agents.isPending.value"
      :error="agents.error.value"
      :empty="(agents.data.value?.items.length ?? 0) === 0"
      :empty-title="t('agents.empty')"
      :empty-hint="t('agents.emptyHint')"
      :on-retry="() => agents.refetch()"
    >
      <template #empty-action>
        <Button variant="primary" size="sm" class="mt-2" @click="openDialog">
          <Plus />
          {{ t('agents.register') }}
        </Button>
      </template>

      <Table>
        <TableHeader>
          <TableRow class="hover:bg-transparent">
            <TableHead>{{ t('agents.name') }}</TableHead>
            <TableHead>{{ t('agents.owner') }}</TableHead>
            <TableHead>{{ t('agents.state') }}</TableHead>
            <TableHead>{{ t('agents.keys') }}</TableHead>
            <TableHead class="w-[1%]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="agent in agents.data.value?.items ?? []" :key="agent.id">
            <TableCell>
              <span class="font-medium text-ink">{{ agent.name }}</span>
              <span v-if="agent.description" class="mt-0.5 block max-w-[46ch] truncate text-[12px] text-ink-muted">
                {{ agent.description }}
              </span>
              <span class="mono-data mt-0.5 block text-[11px] text-ink-faint">{{ agent.id }}</span>
            </TableCell>
            <TableCell class="text-ink-muted">
              {{ ownerOptions.find((m) => m.account_id === agent.owner_account_id)?.email ?? agent.owner_account_id }}
            </TableCell>
            <TableCell>
              <Badge :variant="agent.state === 'active' ? 'allow' : 'muted'">
                {{ agent.state === 'active' ? t('agents.stateActive') : t('agents.stateDisabled') }}
              </Badge>
            </TableCell>
            <TableCell>
              <ul v-if="agent.keys.length > 0" class="m-0 flex list-none flex-col gap-1.5 p-0">
                <li v-for="key in agent.keys" :key="key.id" class="flex items-center gap-2">
                  <Badge :variant="key.revoked_at ? 'muted' : 'outline'">{{ key.kid }}</Badge>
                  <KeyFingerprint :fingerprint="key.fingerprint" :head="12" />
                  <Button
                    v-if="!key.revoked_at"
                    variant="ghost"
                    size="icon-sm"
                    :aria-label="t('agents.revokeKey')"
                    @click="revokeTarget = { agent, keyId: key.id, kid: key.kid }"
                  >
                    <Trash2 />
                  </Button>
                </li>
              </ul>
              <span v-else class="text-[12px] text-ink-faint">{{ t('agents.noKeys') }}</span>
            </TableCell>
            <TableCell class="mono-data text-[11px] text-ink-faint">
              {{ t('agents.keyCount', { count: activeKeys(agent).length }) }}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </QueryBoundary>

    <!-- Register wizard. -->
    <Dialog v-model:open="open" @update:open="(value: boolean) => (value ? null : close())">
      <DialogContent class="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{{ t('agents.registerTitle') }}</DialogTitle>
          <DialogDescription>{{ t('agents.registerDescription') }}</DialogDescription>
        </DialogHeader>

        <!-- Step 1: the record. -->
        <form v-if="step === 'details'" class="flex flex-col gap-3.5" @submit.prevent="submitDetails">
          <div class="flex flex-col gap-1.5">
            <Label for="agent-name">{{ t('agents.registerName') }}</Label>
            <Input
              id="agent-name"
              v-model="name"
              :invalid="name.length > 0 && !nameLooksValid"
              placeholder="ci-bot"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="text-[11.5px] leading-snug text-ink-faint">{{ t('agents.registerNameHint') }}</p>
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="agent-description">{{ t('agents.registerDescriptionField') }}</Label>
            <Textarea id="agent-description" v-model="description" rows="2" />
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="agent-owner">{{ t('agents.registerOwner') }}</Label>
            <NativeSelect id="agent-owner" v-model="ownerId">
              <option v-for="member in ownerOptions" :key="member.account_id" :value="member.account_id">
                {{ member.email }}
              </option>
            </NativeSelect>
            <p class="text-[11.5px] leading-snug text-ink-faint">{{ t('agents.registerOwnerHint') }}</p>
          </div>

          <p v-if="formError" class="text-[12.5px] text-deny">{{ formError }}</p>

          <DialogFooter>
            <Button variant="ghost" type="button" @click="close">{{ t('common.cancel') }}</Button>
            <Button variant="primary" type="submit" :disabled="createAgent.isPending.value">
              <KeyRound />
              {{ createAgent.isPending.value ? t('agents.generating') : t('agents.generate') }}
            </Button>
          </DialogFooter>
        </form>

        <!-- Step 2: review the key, then upload the public half. -->
        <div v-else-if="step === 'key'" class="flex flex-col gap-3.5">
          <Alert variant="warn">
            <AlertTriangle />
            <div class="min-w-0">
              <AlertTitle>{{ t('agents.privateJwk') }}</AlertTitle>
              <AlertDescription>{{ t('agents.downloadPrivateHint') }}</AlertDescription>
            </div>
          </Alert>

          <div class="flex flex-col gap-1.5">
            <p class="text-[11.5px] font-medium text-ink-faint">{{ t('agents.fingerprint') }}</p>
            <div class="rounded-md border border-rule bg-surface-muted px-2.5 py-2">
              <KeyFingerprint v-if="publicFingerprint" :fingerprint="publicFingerprint" :head="0" />
            </div>
            <p class="text-[11.5px] leading-snug text-ink-faint">{{ t('agents.fingerprintHint') }}</p>
          </div>

          <div class="flex flex-col gap-1.5">
            <p class="text-[11.5px] font-medium text-ink-faint">
              {{ t('agents.publicJwk') }}
              <Badge variant="outline" class="ml-1">{{ publicKid }}</Badge>
            </p>
            <pre
              class="scroll-thin max-h-40 overflow-auto rounded-md border border-rule bg-surface-muted p-2.5 font-mono text-[11px] leading-relaxed text-ink"
              >{{ publicJwkPreview }}</pre
            >
          </div>

          <p v-if="formError" class="text-[12.5px] text-deny">{{ formError }}</p>

          <DialogFooter class="sm:justify-between">
            <Button variant="secondary" type="button" @click="downloadKey">
              <Download />
              {{ t('agents.downloadPrivate') }}
            </Button>
            <Button variant="primary" type="button" :disabled="registerKey.isPending.value" @click="submitKey">
              <ShieldCheck />
              {{ registerKey.isPending.value ? t('agents.registering') : t('agents.register') }}
            </Button>
          </DialogFooter>
        </div>

        <!-- Step 3: confirm, and make the one irreversible fact unmissable. -->
        <div v-else class="flex flex-col gap-3.5">
          <Alert :variant="privateDownloaded ? 'success' : 'warn'">
            <CheckCircle2 v-if="privateDownloaded" />
            <AlertTriangle v-else />
            <div class="min-w-0">
              <AlertTitle>{{ t('agents.registered') }}</AlertTitle>
              <AlertDescription>
                {{
                  privateDownloaded
                    ? t('agents.registeredDescription', { name: registeredAgent?.name ?? '' })
                    : t('agents.downloadPrivateHint')
                }}
              </AlertDescription>
            </div>
          </Alert>

          <div class="flex flex-col gap-1.5">
            <p class="text-[11.5px] font-medium text-ink-faint">{{ t('agents.fingerprint') }}</p>
            <div class="rounded-md border border-rule bg-surface-muted px-2.5 py-2">
              <KeyFingerprint v-if="publicFingerprint" :fingerprint="publicFingerprint" :head="0" />
            </div>
          </div>

          <DialogFooter class="sm:justify-between">
            <Button variant="secondary" type="button" @click="downloadKey">
              <Download />
              {{ t('agents.downloadPrivate') }}
            </Button>
            <div class="flex gap-2">
              <Button
                variant="ghost"
                type="button"
                :disabled="!hasGenerated"
                @click="generated && copyJson(generated.publicJwk)"
              >
                <Copy />
                {{ t('common.copy') }}
              </Button>
              <Button variant="primary" type="button" @click="close">{{ t('agents.done') }}</Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Revoke confirmation. -->
    <Dialog :open="revokeTarget !== null" @update:open="(value: boolean) => (value ? null : (revokeTarget = null))">
      <DialogContent class="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t('agents.revokeKeyTitle') }}</DialogTitle>
          <DialogDescription>
            {{ t('agents.revokeKeyDescription', { kid: revokeTarget?.kid ?? '' }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="revokeTarget = null">{{ t('common.cancel') }}</Button>
          <Button variant="danger" :disabled="revokeKey.isPending.value" @click="confirmRevoke">
            <Trash2 />
            {{ t('agents.revokeKey') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
