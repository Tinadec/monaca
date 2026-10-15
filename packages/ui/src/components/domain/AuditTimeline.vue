<script setup lang="ts">
import { ChevronRight, Link2, Link2Off, ShieldAlert } from "lucide-vue-next";
import { computed, ref, type HTMLAttributes } from "vue";

import { cn } from "../../lib/cn";
import {
  formatEventTime,
  isKnownAction,
  shortId,
  subjectLabel,
  truncateHash,
  type AuditEvent,
  type AuditIntegrity,
} from "./audit";

/**
 * The audit trail as a chain, not a table.
 *
 * The product's claim is that every decision is appended to a per-org hash chain that anyone can
 * re-verify, so the chain link is the primary structure here: each row carries the hash it commits
 * to, and the rail between rows is drawn solid only where `prev_hash` actually matches the hash of
 * the row above. A break in the page (a filtered query, a page boundary) reads as a dashed rail —
 * visible, but not an alarm. Tampering is reported only by the server's verifier, passed in as
 * `integrity`; this component never claims a chain is broken on its own.
 *
 * Rows are pre-paired with their link state because a template cannot hold the previous element
 * without an indexed lookup, and `indexOf` on objects is both O(n²) and wrong once two events are
 * structurally equal.
 */
const props = withDefaults(
  defineProps<{
    events: readonly AuditEvent[];
    /** Server verdict from `GET /v1/orgs/{org}/audit/verify`. Absent means "not checked here". */
    integrity?: AuditIntegrity;
    /** True when the rows came from a filtered query, so gaps between rows are expected. */
    filtered?: boolean;
    class?: HTMLAttributes["class"];
    labels?: Partial<Record<keyof typeof defaultLabels, string>>;
  }>(),
  { filtered: false },
);

const defaultLabels = {
  empty: "No events yet",
  emptyHint: "Decisions appear here as soon as an agent requests a token or calls a tool.",
  verified: "Chain verified",
  unverified: "Chain not verified",
  broken: "Chain broken",
  brokenAt: "first mismatch at seq",
  checked: "rows checked",
  head: "chain head",
  linkOk: "commits to the event above",
  linkGap: "the event above is not in this list",
  unknownAction: "not an M0 action",
  details: "Payload",
  chainLabel: "Chain",
  chainPrev: "prev",
  chainThis: "this",
} as const;

const text = computed(() => ({ ...defaultLabels, ...props.labels }));
const expanded = ref<string | null>(null);

interface Row {
  event: AuditEvent;
  /** This row's `prev_hash` equals the hash of the row above it in this list. */
  linked: boolean;
  time: string;
  date: string | null;
}

const rows = computed<Row[]>(() =>
  props.events.map((event, index) => {
    const previous = props.events[index - 1];
    const { time, date } = formatEventTime(event.at);
    return { event, linked: previous !== undefined && previous.hash === event.prev_hash, time, date };
  }),
);

/** Consecutive rows sharing a UTC day; grouped over `rows` so day headers align with the rail. */
const groups = computed(() => {
  const out: { day: string; rows: Row[] }[] = [];
  for (const row of rows.value) {
    const day = row.event.at.slice(0, 10);
    const last = out.at(-1);
    if (last && last.day === day) last.rows.push(row);
    else out.push({ day, rows: [row] });
  }
  return out;
});

const verdict = computed(() => {
  const integrity = props.integrity;
  if (!integrity) return { kind: "unchecked" as const, ok: false };
  if (integrity.valid) return { kind: "valid" as const, ok: true, checked: integrity.checked };
  return { kind: "broken" as const, ok: false, first: integrity.first_broken };
});

function toggle(event: AuditEvent): void {
  expanded.value = expanded.value === event.id ? null : event.id;
}

function payloadJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

const decisionClass: Record<AuditEvent["decision"], string> = {
  allow: "bg-allow",
  deny: "bg-deny",
  info: "bg-ink-faint",
};
</script>

<template>
  <div :class="cn('flex flex-col', props.class)">
    <!-- Verifier verdict: the only element allowed to say "broken". -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule pb-3">
      <p
        class="flex items-center gap-1.5 text-[12.5px] font-medium"
        :class="verdict.ok ? 'text-allow' : verdict.kind === 'broken' ? 'text-deny' : 'text-ink-faint'"
      >
        <ShieldAlert v-if="verdict.kind === 'broken'" class="size-3.5" aria-hidden="true" />
        <Link2 v-else-if="verdict.ok" class="size-3.5" aria-hidden="true" />
        <Link2Off v-else class="size-3.5" aria-hidden="true" />
        <template v-if="verdict.kind === 'valid'">{{ text.verified }}</template>
        <template v-else-if="verdict.kind === 'broken'">{{ text.broken }}</template>
        <template v-else>{{ text.unverified }}</template>
      </p>
      <p v-if="verdict.kind === 'valid'" class="mono-data text-[11.5px] text-ink-faint">
        {{ verdict.checked }} {{ text.checked }}
        <template v-if="integrity"> · {{ text.head }} #{{ integrity.head.seq }}</template>
      </p>
      <p v-else-if="verdict.kind === 'broken'" class="mono-data text-[11.5px] text-ink-faint">
        {{ text.brokenAt }} {{ verdict.first?.seq }} · {{ verdict.first?.reason }}
      </p>
      <p v-if="filtered && events.length > 0" class="mono-data text-[11.5px] text-ink-faint">
        {{ text.linkGap }}
      </p>
    </div>

    <div v-if="rows.length === 0" class="py-12 text-center">
      <p class="text-[13px] text-ink-muted">{{ text.empty }}</p>
      <p class="mt-1 text-[12.5px] text-ink-faint">{{ text.emptyHint }}</p>
    </div>

    <div v-else class="scroll-thin flex flex-col">
      <template v-for="group in groups" :key="group.day">
        <p class="sticky top-0 z-[1] bg-surface py-1.5 text-[11.5px] font-medium text-ink-faint">
          {{ group.day }}
        </p>

        <ol class="m-0 flex list-none flex-col p-0">
          <li v-for="row in group.rows" :key="row.event.id" class="relative flex gap-3">
            <!-- Chain rail: solid exactly where this row's prev_hash matches the row above. -->
            <div class="relative flex w-3 shrink-0 justify-center" aria-hidden="true">
              <span
                class="absolute inset-y-0 w-px"
                :class="
                  row.linked
                    ? 'bg-brand/40'
                    : 'bg-[repeating-linear-gradient(to_bottom,var(--rule-strong)_0_3px,transparent_3px_7px)]'
                "
              />
              <span
                class="absolute top-[13px] size-[7px] rounded-full ring-2 ring-surface"
                :class="decisionClass[row.event.decision]"
              />
            </div>

            <div class="min-w-0 flex-1 border-b border-rule py-2.5 last:border-b-0">
              <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <button
                  type="button"
                  class="group/row flex min-w-0 items-baseline gap-1.5 text-left outline-offset-2"
                  :aria-expanded="expanded === row.event.id"
                  @click="toggle(row.event)"
                >
                  <ChevronRight
                    class="size-3 shrink-0 translate-y-px text-ink-faint transition-transform"
                    :class="expanded === row.event.id ? 'rotate-90' : ''"
                    aria-hidden="true"
                  />
                  <span class="mono-data text-[12.5px] font-medium text-ink">{{ row.event.action }}</span>
                  <span class="text-[12.5px] text-ink-muted">{{ subjectLabel(row.event.subject) }}</span>
                </button>

                <span
                  v-if="!isKnownAction(row.event.action)"
                  class="rounded-sm border border-warn/35 bg-warn-soft px-1 text-[11px] text-warn"
                >
                  {{ text.unknownAction }}
                </span>

                <span class="mono-data ml-auto shrink-0 text-[11.5px] text-ink-faint">
                  <template v-if="row.date">{{ row.date }} </template>{{ row.time }}
                </span>
              </div>

              <div class="mono-data mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-[18px] text-[11.5px] text-ink-faint">
                <span>#{{ row.event.seq }}</span>
                <span class="flex items-center gap-1" :title="row.linked ? text.linkOk : text.linkGap">
                  <Link2 v-if="row.linked" class="size-3" aria-hidden="true" />
                  <Link2Off v-else class="size-3" aria-hidden="true" />
                  {{ truncateHash(row.event.hash) }}
                </span>
                <span v-if="row.event.grant_id">{{ shortId(row.event.grant_id) }}</span>
                <span v-if="row.event.jti">jti {{ row.event.jti.slice(0, 8) }}…</span>
              </div>

              <!-- Actors, outermost first, as the contract orders them. -->
              <div class="mt-1 flex flex-wrap items-center gap-1.5 pl-[18px]">
                <template v-for="(actor, index) in row.event.actor_chain" :key="`${row.event.id}-${index}`">
                  <ChevronRight v-if="index > 0" class="size-3 text-ink-faint" aria-hidden="true" />
                  <span
                    class="rounded-sm border border-rule bg-surface-muted px-1.5 py-px font-mono text-[11px] leading-[16px] text-ink-muted"
                  >
                    {{ actor.type }} {{ shortId(actor.id) }}
                  </span>
                </template>
              </div>

              <div v-if="expanded === row.event.id" class="animate-slide-down mt-2.5 pl-[18px]">
                <p class="mb-1 text-[11.5px] font-medium text-ink-faint">{{ text.details }}</p>
                <pre
                  class="scroll-thin max-h-64 overflow-auto rounded-md border border-rule bg-surface-muted p-2.5 font-mono text-[11.5px] leading-relaxed text-ink"
                  >{{ payloadJson(row.event.payload) }}</pre
                >
                <dl class="mono-data mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                  <dt>{{ text.chainLabel }}</dt>
                  <dd class="m-0 break-all text-ink-muted">
                    {{ text.chainPrev }} {{ row.event.prev_hash }}<br />{{ text.chainThis }} {{ row.event.hash }}
                  </dd>
                </dl>
              </div>
            </div>
          </li>
        </ol>
      </template>
    </div>
  </div>
</template>
