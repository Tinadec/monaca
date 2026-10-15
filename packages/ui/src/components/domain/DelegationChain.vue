<script setup lang="ts">
import { Ban, Plus, ShieldAlert, ShieldCheck, X } from "lucide-vue-next";
import { computed, type HTMLAttributes } from "vue";

import { cn } from "../../lib/cn";
import { buildChain, type ChainHop, type ChainIntegrity, type Lane } from "./chain";

const props = defineProps<{
  hops: readonly ChainHop[];
  /** Server-side verdict, when there is one. Otherwise the verdict is computed from the hops. */
  integrity?: ChainIntegrity;
  class?: HTMLAttributes["class"];
  /** Override any piece of copy (i18n hook). */
  labels?: Partial<Record<keyof typeof defaultLabels, string>>;
}>();

const defaultLabels = {
  narrows: "Scope only narrows along the chain",
  widened: "A hop holds scopes its parent never granted",
  hops: "hops",
  dropped: "dropped",
  effective: "effective",
  allowed: "allowed",
  denied: "denied",
  held: "held",
  droppedHere: "dropped at this hop",
  refused: "refused, not held",
  addedHere: "not granted by the previous hop",
  caption: "Delegation chain: each row is a scope, each column a hop",
};

const text = computed(() => ({ ...defaultLabels, ...props.labels }));
const layout = computed(() => buildChain(props.hops));

const verdictOk = computed(() => props.integrity?.valid ?? layout.value.widenedAt.length === 0);
const verdictText = computed(() => {
  if (props.integrity && !props.integrity.valid) return props.integrity.reason ?? text.value.widened;
  return layout.value.widenedAt.length > 0 ? text.value.widened : text.value.narrows;
});

function dropsAt(index: number): number {
  return layout.value.lanes.filter((lane) => lane.cells[index]?.kind === "dropped").length;
}

function cellLabel(lane: Lane, index: number): string | undefined {
  switch (lane.cells[index]?.kind) {
    case "held":
      return `${lane.scope}, ${text.value.held}`;
    case "added":
      return `${lane.scope}, ${text.value.addedHere}`;
    case "dropped":
      return `${lane.scope}, ${text.value.droppedHere}`;
    case "denied":
      return `${lane.scope}, ${text.value.refused}`;
    default:
      return undefined;
  }
}
</script>

<template>
  <div :class="cn('flex flex-col gap-3', props.class)">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p class="flex items-center gap-1.5 text-[12.5px] font-medium" :class="verdictOk ? 'text-allow' : 'text-deny'">
        <ShieldCheck v-if="verdictOk" class="size-3.5" aria-hidden="true" />
        <ShieldAlert v-else class="size-3.5" aria-hidden="true" />
        {{ verdictText }}
      </p>
      <p class="mono-data text-[11.5px] text-ink-faint">
        {{ hops.length }} {{ text.hops }}<template v-if="layout.droppedCount > 0">
          · {{ layout.droppedCount }} {{ text.dropped }}</template
        >
        · {{ layout.finalCount }} {{ text.effective }}
      </p>
    </div>

    <div class="scroll-thin overflow-x-auto">
      <table class="w-full min-w-max border-collapse">
        <caption class="sr-only">
          {{ text.caption }}
        </caption>
        <thead>
          <tr>
            <th
              v-for="(hop, index) in hops"
              :key="`h-${index}-${hop.id}`"
              scope="col"
              class="min-w-[11.5rem] p-0 pb-2.5 pr-4 text-left align-top font-normal"
            >
              <div
                class="relative rounded-lg border bg-surface px-2.5 py-2"
                :class="[
                  hop.outcome === 'deny' ? 'border-deny/40' : 'border-rule',
                  index < hops.length - 1
                    ? 'after:absolute after:left-full after:top-1/2 after:h-px after:w-4 after:bg-rule-strong'
                    : '',
                ]"
              >
                <div class="flex items-center gap-1.5">
                  <span
                    class="rounded-[3px] px-1 py-px text-[11px] font-medium"
                    :class="hop.kind === 'tool' ? 'bg-brand-soft text-brand-ink' : 'bg-surface-muted text-ink-muted'"
                  >
                    {{ hop.kind }}
                  </span>
                  <span
                    v-if="hop.outcome"
                    class="rounded-[3px] px-1 py-px text-[11px] font-medium"
                    :class="hop.outcome === 'allow' ? 'bg-allow-soft text-allow' : 'bg-deny-soft text-deny'"
                  >
                    {{ hop.outcome === "allow" ? text.allowed : text.denied }}
                  </span>
                  <span v-if="dropsAt(index) > 0" class="mono-data ml-auto text-[11px] text-ink-faint">
                    −{{ dropsAt(index) }}
                  </span>
                </div>
                <p class="mt-1.5 truncate text-[13px] font-medium text-ink" :title="hop.label ?? hop.id">
                  {{ hop.label ?? hop.id }}
                </p>
                <p class="mono-data max-w-[10.5rem] truncate text-[11px] text-ink-faint" :title="hop.id">
                  {{ hop.id }}
                </p>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="lane in layout.lanes" :key="lane.scope">
            <td
              v-for="(cell, index) in lane.cells"
              :key="`${lane.scope}-${index}`"
              class="h-8 p-0 align-middle"
              :aria-label="cellLabel(lane, index)"
            >
              <div class="flex h-8 items-center">
                <span
                  class="h-[1.5px] shrink-0"
                  :class="[cell.kind === 'dropped' ? 'w-4' : 'w-3', cell.lineIn ? 'bg-brand/55' : 'bg-transparent']"
                  aria-hidden="true"
                />

                <template v-if="cell.kind === 'held' || cell.kind === 'added'">
                  <span
                    class="relative z-[1] inline-flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-[11.5px] leading-[16px] tracking-[-0.01em]"
                    :class="
                      cell.kind === 'held'
                        ? 'border-rule bg-surface-muted text-ink'
                        : 'border-warn/45 bg-warn-soft text-warn'
                    "
                  >
                    <Plus v-if="cell.kind === 'added'" class="size-2.5" aria-hidden="true" />
                    {{ lane.scope }}
                  </span>
                  <span
                    class="h-[1.5px] min-w-3 flex-1"
                    :class="cell.lineOut ? 'bg-brand/55' : 'bg-transparent'"
                    aria-hidden="true"
                  />
                </template>

                <template v-else-if="cell.kind === 'dropped'">
                  <span
                    class="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-rule-strong bg-surface text-ink-faint"
                    aria-hidden="true"
                  >
                    <X class="size-2.5" :stroke-width="2.5" />
                  </span>
                  <span class="ml-1.5 truncate font-mono text-[11.5px] tracking-[-0.01em] text-ink-faint line-through">
                    {{ lane.scope }}
                  </span>
                </template>

                <template v-else-if="cell.kind === 'denied'">
                  <span
                    class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-deny/45 bg-deny-soft px-1.5 py-px font-mono text-[11.5px] leading-[16px] tracking-[-0.01em] text-deny"
                  >
                    <Ban class="size-2.5" aria-hidden="true" />
                    {{ lane.scope }}
                  </span>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
