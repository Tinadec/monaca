/**
 * The design system's public surface.
 *
 * Two layers: `components/ui` is the shadcn-vue primitive set (Button, Dialog, Table, …), and
 * `components/domain` holds components that know about Monaca's own concepts — scope strings,
 * delegation chains, key fingerprints, audit events. Apps import from `@monaca/ui` and never reach
 * into `src/`; keeping the barrel complete means a component can move without breaking callers.
 */
export * from "./components/ui/alert";
export * from "./components/ui/badge";
export * from "./components/ui/button";
export * from "./components/ui/card";
export * from "./components/ui/checkbox";
export * from "./components/ui/dialog";
export * from "./components/ui/dropdown-menu";
export * from "./components/ui/input";
export * from "./components/ui/kbd";
export * from "./components/ui/label";
export * from "./components/ui/native-select";
export * from "./components/ui/separator";
export * from "./components/ui/sidebar-nav";
export * from "./components/ui/skeleton";
export * from "./components/ui/table";
export * from "./components/ui/tabs";
export * from "./components/ui/textarea";
export * from "./components/ui/toast";
export * from "./components/ui/tooltip";

export { default as AuditTimeline } from "./components/domain/AuditTimeline.vue";
export { default as DelegationChain } from "./components/domain/DelegationChain.vue";
export { default as KeyFingerprint } from "./components/domain/KeyFingerprint.vue";
export { default as ScopeBadge } from "./components/domain/ScopeBadge.vue";
export * from "./components/domain/audit";
export * from "./components/domain/chain";
export * from "./components/domain/scopes";

export { cn } from "./lib/cn";
export * from "./lib/thumbprint";
