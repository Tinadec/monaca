<script setup lang="ts">
import { Button } from "@monaca/ui";
import { ArrowLeft } from "lucide-vue-next";
import { RouterLink } from "vue-router";

import { t } from "@/i18n";
</script>

<template>
  <div class="flex flex-col items-start gap-3 py-20">
    <p class="mono-data text-[11.5px] text-ink-faint">404</p>
    <h1 class="text-[19px] font-semibold tracking-[-0.015em]">{{ t('error.notFound') }}</h1>
    <p class="max-w-[60ch] text-[13px] leading-relaxed text-ink-muted">{{ t('error.notFoundHint') }}</p>
    <RouterLink :to="{ name: 'overview' }" class="mt-1">
      <Button variant="secondary" size="sm">
        <ArrowLeft />
        {{ t('error.backToOverview') }}
      </Button>
    </RouterLink>
  </div>
</template>
