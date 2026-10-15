import { dedupe } from "./scopes";

export interface ChainHop {
  /** Typed id such as `acc_…`, `agt_…`, or a bare tool name. */
  id: string;
  kind: "account" | "agent" | "sub-agent" | "grant" | "tool";
  /** Human label (email, agent name, tool name). Falls back to the id. */
  label?: string;
  /** The scope set this hop holds. Absent means "unchanged from the previous hop". */
  scopes?: readonly string[];
  /** Scopes a tool demands. Any not present in `scopes` is shown as refused. */
  required?: readonly string[];
  outcome?: "allow" | "deny";
}

export interface ChainIntegrity {
  valid: boolean;
  reason?: string;
}

/**
 * - held:    carried over from the previous hop (or present at the root)
 * - added:   present here but NOT at the previous hop — an attenuation violation
 * - dropped: present at the previous hop, removed here
 * - denied:  required by this hop but not held
 */
export type CellKind = "held" | "added" | "dropped" | "denied" | "empty";

export interface Cell {
  kind: CellKind;
  /** A lane line enters from the left edge of the cell. */
  lineIn: boolean;
  /** A lane line leaves through the right edge of the cell. */
  lineOut: boolean;
}

export interface Lane {
  scope: string;
  cells: Cell[];
}

export interface ChainLayout {
  lanes: Lane[];
  /** Effective scope set per hop, with pass-through hops resolved. */
  held: string[][];
  /** Hop indexes where a scope appeared that the previous hop did not hold. */
  widenedAt: number[];
  droppedCount: number;
  finalCount: number;
}

export function resolveHeld(hops: readonly ChainHop[]): string[][] {
  const resolved: string[][] = [];
  hops.forEach((hop, index) => {
    resolved.push(hop.scopes ? dedupe(hop.scopes) : (resolved[index - 1] ?? []));
  });
  return resolved;
}

/**
 * Lay a delegation chain out as scope lanes: one lane per scope, one cell per hop. Lanes that live
 * longest sort first, so losses read as a descending staircase and any widening stands out.
 */
export function buildChain(hops: readonly ChainHop[]): ChainLayout {
  const held = resolveHeld(hops);
  const count = hops.length;

  const order: string[] = [];
  const remember = (scope: string): void => {
    if (!order.includes(scope)) order.push(scope);
  };
  held.forEach((set) => set.forEach(remember));
  hops.forEach((hop) => hop.required?.forEach(remember));

  const holds = (scope: string, index: number): boolean => held[index]?.includes(scope) ?? false;

  const built = order.map((scope): Lane => {
    const cells: Cell[] = [];
    for (let i = 0; i < count; i += 1) {
      const here = holds(scope, i);
      const before = i > 0 && holds(scope, i - 1);
      const missing = !here && (hops[i]?.required?.includes(scope) ?? false);
      let kind: CellKind = "empty";
      if (here) kind = i === 0 || before ? "held" : "added";
      else if (missing) kind = "denied";
      else if (before) kind = "dropped";
      cells.push({
        kind,
        lineIn: (kind === "held" && i > 0) || kind === "dropped",
        lineOut: (kind === "held" || kind === "added") && i < count - 1,
      });
    }
    return { scope, cells };
  });

  const lifetime = (lane: Lane): number => {
    let run = 0;
    for (const cell of lane.cells) {
      if (cell.kind === "held" || cell.kind === "added") run += 1;
      else break;
    }
    return run;
  };

  const lanes = built
    .map((lane, index) => ({ lane, index, run: lifetime(lane) }))
    .sort((a, b) => b.run - a.run || a.index - b.index)
    .map((entry) => entry.lane);

  const widened = new Set<number>();
  let droppedCount = 0;
  for (const lane of lanes) {
    lane.cells.forEach((cell, index) => {
      if (cell.kind === "added") widened.add(index);
      if (cell.kind === "dropped") droppedCount += 1;
    });
  }

  return {
    lanes,
    held,
    widenedAt: [...widened].sort((a, b) => a - b),
    droppedCount,
    finalCount: held.at(-1)?.length ?? 0,
  };
}
