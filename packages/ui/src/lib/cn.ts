import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class lists, then resolve Tailwind conflicts so a caller's `class` always wins
 * over a component's default. Same contract as shadcn-vue's `cn`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
