import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export const alertVariants = cva(
  "relative flex gap-2.5 rounded-md border px-3 py-2.5 text-[13px] leading-snug [&>svg]:mt-px [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        info: "border-info/30 bg-info-soft text-ink [&>svg]:text-info",
        warn: "border-warn/35 bg-warn-soft text-ink [&>svg]:text-warn",
        error: "border-deny/30 bg-deny-soft text-ink [&>svg]:text-deny",
        success: "border-allow/30 bg-allow-soft text-ink [&>svg]:text-allow",
      },
    },
    defaultVariants: { variant: "info" },
  },
);

export type AlertVariants = VariantProps<typeof alertVariants>;
