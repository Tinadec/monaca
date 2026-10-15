import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

/**
 * The button scale is deliberately tight: 28px (sm) is the console's default action height, 32px
 * (default) is for primary page actions, 24px (xs) for row-level controls in dense tables.
 */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium",
    "transition-colors duration-100 select-none",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-brand text-brand-on shadow-[0_1px_0_oklch(0_0_0/0.06)_inset] hover:brightness-[1.08] active:brightness-95",
        secondary:
          "border border-rule bg-surface text-ink hover:border-rule-strong hover:bg-surface-muted",
        ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink",
        outline: "border border-dashed border-rule-strong text-ink-muted hover:border-brand hover:text-brand-ink",
        danger: "bg-deny text-white hover:brightness-[1.08] dark:text-ink",
        link: "text-brand-ink underline decoration-brand/40 underline-offset-4 hover:decoration-brand",
      },
      size: {
        xs: "h-6 rounded-sm px-2 text-[12px]",
        sm: "h-7 px-2.5",
        default: "h-8 px-3",
        lg: "h-9 px-4 text-[14px]",
        icon: "size-8",
        "icon-sm": "size-7 rounded-sm",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;
