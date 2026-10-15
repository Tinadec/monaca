// Mode selection for `bun run dev` (contract §2.3, §3): the persisted choice in `.monaca/dev.json`,
// the `--mode` / `--with-gateway` flags, and the `MONACA_DEV_MODE` override.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type DevMode = "a" | "b" | "c";

/** `.monaca/dev.json` exactly as contract §2.3 declares it. */
export interface DevChoice {
  mode: DevMode;
  chosenAt: string;
  notes: string;
}

export const MODE_HELP: Record<DevMode, string> = {
  a: "local full stack — fetched server binary + embedded PostgreSQL + gateway + console + auth-ui",
  b: "remote dev — Vue apps only, Vite proxied to the deployed dev gateway (--with-gateway adds the local gateway)",
  c: "ci only — typecheck and unit tests locally, real builds and e2e on GitHub Actions",
};

export const MODES: DevMode[] = ["a", "b", "c"];

export function isDevMode(value: unknown): value is DevMode {
  return value === "a" || value === "b" || value === "c";
}

export function devJsonPath(root: string): string {
  return join(root, ".monaca", "dev.json");
}

export function readDevChoice(root: string): DevChoice | undefined {
  const path = devJsonPath(root);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DevChoice>;
    if (!isDevMode(raw.mode)) return undefined;
    return { mode: raw.mode, chosenAt: raw.chosenAt ?? "", notes: raw.notes ?? "" };
  } catch {
    // A corrupt dev.json must not brick `bun run dev`; the caller re-prompts.
    return undefined;
  }
}

export async function writeDevChoice(root: string, choice: DevChoice): Promise<void> {
  const path = devJsonPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(choice, null, 2)}\n`, "utf8");
}

export interface ParsedArgs {
  mode?: DevMode;
  withGateway: boolean;
  help: boolean;
  /** Anything the caller did not recognise, so a typo fails loudly instead of silently. */
  unknown: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { withGateway: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--with-gateway") {
      parsed.withGateway = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--mode") {
      const value = argv[++i];
      if (!isDevMode(value)) parsed.unknown.push(`--mode ${value ?? ""}`.trim());
      else parsed.mode = value;
    } else if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!isDevMode(value)) parsed.unknown.push(arg);
      else parsed.mode = value;
    } else {
      parsed.unknown.push(arg);
    }
  }
  return parsed;
}

/** Asks the developer to pick a mode. `--mode`, then `MONACA_DEV_MODE`, then the prompt. */
export async function chooseMode(
  root: string,
  args: ParsedArgs,
  interactive: boolean,
): Promise<{ mode: DevMode; source: string; choice?: DevChoice }> {
  const stored = readDevChoice(root);
  if (args.mode) return { mode: args.mode, source: "--mode", choice: stored };

  const fromEnv = process.env.MONACA_DEV_MODE;
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isDevMode(fromEnv)) {
      throw new Error(`MONACA_DEV_MODE must be one of a, b, c (got ${JSON.stringify(fromEnv)})`);
    }
    return { mode: fromEnv, source: "MONACA_DEV_MODE", choice: stored };
  }

  if (stored) return { mode: stored.mode, source: devJsonPath(root), choice: stored };

  if (!interactive) {
    throw new Error(
      `no mode recorded in ${devJsonPath(root)} and stdin is not a TTY; pass --mode a|b|c or set MONACA_DEV_MODE`,
    );
  }

  console.log("Monaca dev mode (recorded in .monaca/dev.json; override with --mode a|b|c):");
  for (const mode of MODES) console.log(`  ${mode}) ${MODE_HELP[mode]}`);

  for (;;) {
    const answer = (prompt("Choose a dev mode [a/b/c]:", "a") ?? "").trim().toLowerCase();
    if (isDevMode(answer)) {
      const choice: DevChoice = { mode: answer, chosenAt: new Date().toISOString(), notes: "" };
      await writeDevChoice(root, choice);
      console.log(`recorded mode ${answer} in .monaca/dev.json`);
      return { mode: answer, source: "prompt", choice };
    }
    console.log("please answer a, b or c");
  }
}
