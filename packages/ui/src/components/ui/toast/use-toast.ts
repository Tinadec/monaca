import { readonly, shallowRef } from "vue";

export type ToastVariant = "default" | "success" | "error";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. `0` keeps the toast until it is closed. */
  duration?: number;
}

export interface ToastItem {
  id: number;
  title: string;
  description: string | undefined;
  variant: ToastVariant;
}

const DEFAULT_DURATION_MS = 4200;
const MAX_VISIBLE = 4;

const items = shallowRef<readonly ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  items.value = items.value.filter((t) => t.id !== id);
}

/** Show a toast. Module-level state means any code (not only components) can raise one. */
export function toast(options: ToastOptions): { id: number; dismiss: () => void } {
  const id = nextId++;
  const item: ToastItem = {
    id,
    title: options.title,
    description: options.description,
    variant: options.variant ?? "default",
  };
  items.value = [...items.value, item].slice(-MAX_VISIBLE);

  const duration = options.duration ?? DEFAULT_DURATION_MS;
  if (duration > 0) timers.set(id, setTimeout(() => dismiss(id), duration));
  return { id, dismiss: () => dismiss(id) };
}

export function useToast() {
  return { toasts: readonly(items), toast, dismiss };
}
