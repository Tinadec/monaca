import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

/**
 * Badges carry state, not decoration: `allow` / `deny` / `info` / `warn` are reserved for a
 * decision or a risk level, `brand` for the current actor, `muted` for everything neutral.
 */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[11px] font-medium leading-[16px] whitespace-nowrap",
  {
    variants: {
      variant: {
        muted: "border-rule bg-surface-muted text-ink-muted",
        outline: "border-rule-strong bg-transparent text-ink-muted",
        brand: "border-brand/30 bg-brand-soft text-brand-ink",
        allow: "border-allow/30 bg-allow-soft text-allow",
        deny: "border-deny/30 bg-deny-soft text-deny",
        info: "border-info/30 bg-info-soft text-info",
        warn: "border-warn/35 bg-warn-soft text-warn",
      },
    },
    defaultVariants: { variant: "muted" },
  },
);

export type BadgeVariants = VariantProps<typeof badgeVariants>;
