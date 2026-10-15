<script setup lang="ts">
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Separator,
  toast,
} from "@monaca/ui";
import { Check, Copy, Monitor, Moon, Sun } from "lucide-vue-next";
import { computed } from "vue";

import { GATEWAY_URL, USE_MOCKS } from "@/api";
import PageHeader from "@/components/PageHeader.vue";
import { useTheme } from "@/composables/use-theme";
import { t } from "@/i18n";
import { useSession } from "@/queries";
import { useUiStore, type ThemeChoice } from "@/stores/ui";

/**
 * Settings.
 *
 * Read-mostly by design. Everything here that is a server policy — token lifetime, org membership,
 * the tenant — is shown as a fact rather than an editable field, because a console that renders a
 * disabled-looking control for something it cannot change is worse than one that states the value.
 *
 * The diagnostics block exists so a bug report can be one copy-paste: version, mode, origins, and
 * the ids that identify the session.
 */
const ui = useUiStore();
const session = useSession();
const { resolved, apply } = useTheme(() => ui.theme);

function setTheme(choice: ThemeChoice): void {
  ui.setTheme(choice);
  apply();
}

const diagnostics = computed(() => ({
  mode: import.meta.env.MODE,
  mocks: USE_MOCKS,
  gateway: GATEWAY_URL,
  tenant: ui.tenant,
  org: ui.org,
  account_id: session.data.value?.account_id ?? null,
  theme: `${ui.theme} (${resolved.value})`,
  user_agent: navigator.userAgent,
}));

async function copyDiagnostics(): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify(diagnostics.value, null, 2));
  toast({ title: t("settings.diagnosticsCopied"), variant: "success" });
}

const themeOptions: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "system", label: t("theme.system"), icon: Monitor },
  { value: "light", label: t("theme.light"), icon: Sun },
  { value: "dark", label: t("theme.dark"), icon: Moon },
];
</script>

<template>
  <div class="flex flex-col gap-5">
    <PageHeader :title="t('settings.title')" :subtitle="t('settings.subtitle')" />

    <Card>
      <CardHeader>
        <CardTitle>{{ t('settings.appearance') }}</CardTitle>
        <CardDescription>{{ t('settings.appearanceHint') }}</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-2">
        <Label>{{ t('settings.theme') }}</Label>
        <div class="flex flex-wrap gap-1.5" role="group" :aria-label="t('settings.theme')">
          <Button
            v-for="option in themeOptions"
            :key="option.value"
            :variant="ui.theme === option.value ? 'secondary' : 'ghost'"
            size="sm"
            :aria-pressed="ui.theme === option.value"
            @click="setTheme(option.value)"
          >
            <component :is="option.icon" />
            {{ option.label }}
            <Check v-if="ui.theme === option.value" class="size-3 text-brand" />
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>{{ t('settings.identity') }}</CardTitle>
        <CardDescription>{{ t('session.signedInAs') }}</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col">
        <dl class="grid grid-cols-[minmax(9rem,auto)_1fr] items-baseline gap-x-4 gap-y-2.5 text-[13px]">
          <dt class="text-ink-faint">{{ t('settings.account') }}</dt>
          <dd class="m-0 truncate text-ink">{{ session.data.value?.email ?? t('common.unknown') }}</dd>

          <dt class="text-ink-faint">{{ t('settings.tenant') }}</dt>
          <dd class="m-0">
            <Badge variant="muted">{{ ui.tenant }}</Badge>
          </dd>

          <dt class="text-ink-faint">{{ t('settings.organization') }}</dt>
          <dd class="m-0 flex flex-wrap items-center gap-1.5">
            <Badge variant="brand">{{ ui.org }}</Badge>
            <span class="mono-data text-[11.5px] text-ink-faint">
              {{ session.data.value?.orgs.find((o) => o.slug === ui.org)?.role ?? "" }}
            </span>
          </dd>

          <dt class="text-ink-faint">{{ t('members.accountId') }}</dt>
          <dd class="mono-data m-0 break-all text-[11.5px] text-ink-muted">
            {{ session.data.value?.account_id ?? "—" }}
          </dd>

          <dt class="text-ink-faint">{{ t('settings.tokenTtl') }}</dt>
          <dd class="m-0 text-[12.5px] text-ink-muted">{{ t('settings.tokenTtlHint') }}</dd>
        </dl>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>{{ t('settings.mockMode') }}</CardTitle>
        <CardDescription>{{ t('settings.mockModeHint') }}</CardDescription>
      </CardHeader>
      <CardContent class="flex items-center gap-2">
        <Badge :variant="USE_MOCKS ? 'warn' : 'allow'">
          VITE_USE_MOCKS={{ USE_MOCKS ? "true" : "false" }}
        </Badge>
      </CardContent>
    </Card>

    <Card>
      <CardHeader class="flex-row items-center justify-between">
        <div>
          <CardTitle>{{ t('settings.diagnostics') }}</CardTitle>
          <CardDescription>{{ t('settings.gateway') }}</CardDescription>
        </div>
        <Button variant="secondary" size="sm" @click="copyDiagnostics">
          <Copy />
          {{ t('settings.copyDiagnostics') }}
        </Button>
      </CardHeader>
      <CardContent>
        <Separator class="mb-3" />
        <dl class="mono-data grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[11.5px]">
          <template v-for="(value, key) in diagnostics" :key="key">
            <dt class="text-ink-faint">{{ key }}</dt>
            <dd class="m-0 break-all text-ink-muted">{{ value }}</dd>
          </template>
        </dl>
      </CardContent>
    </Card>
  </div>
</template>
