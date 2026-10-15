#!/usr/bin/env bun
/*
 * bun run verify:ci
 *
 * Mode C (docs/contracts/m0.md §3): watch the rust.yml and web.yml runs for HEAD and report
 * their conclusions, then download the e2e report artifacts into `.monaca/reports/<sha>/`.
 *
 * This script NEVER pushes and never dispatches a run. It reports on what is already on the
 * remote, and when HEAD is not there it says so and stops — a "verify" that quietly triggered
 * CI would make the red/green result depend on state the developer did not push.
 *
 * Self-contained on purpose: scripts/lib/ is shared with other script owners and this file
 * must not race them for a module name.
 */

import { mkdirSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** Workflows watched for HEAD, in report order. Both are required (§10.1, §10.2). */
const WORKFLOWS = ["rust.yml", "web.yml"] as const;

/** Artifact families downloaded into `.monaca/reports/<sha>/` (§2.3, §10.5). */
const REPORT_ARTIFACTS = ["e2e-report"] as const;

/** A failure the user can act on; printed without a stack trace. */
class CliError extends Error {}

interface RunInfo {
  databaseId: number;
  headSha: string;
  headBranch: string;
  url: string;
  status: string;
  conclusion: string | null;
  workflowName: string;
}

const RUN_FIELDS = "databaseId,headSha,headBranch,url,status,conclusion,workflowName";

// ---------------------------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------------------------

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `cmd`, or returns null when the executable could not be started (Bun throws ENOENT). */
async function probe(cmd: string[]): Promise<ProcResult | null> {
  const program = cmd[0];
  if (program === undefined) return null;
  try {
    const proc = Bun.spawn(cmd, { cwd: ROOT, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch {
    return null;
  }
}

async function must(cmd: string[], what: string): Promise<ProcResult> {
  const result = await probe(cmd);
  if (result === null) throw new CliError(`${cmd[0]} could not be started while ${what}.`);
  return result;
}

/**
 * Runs `cmd` with its output going straight to this terminal — used for `gh run watch`, which
 * draws a live progress view that is worth more than anything this script could print.
 */
async function passthrough(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

// ---------------------------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------------------------

async function preflight(): Promise<string> {
  const version = await probe(["gh", "--version"]);
  if (version === null) {
    throw new CliError(`This command needs the GitHub CLI (gh) on PATH, and it is not installed.

  Windows:  winget install --id GitHub.cli
  macOS:    brew install gh
  Linux:    https://github.com/cli/cli/blob/trunk/docs/install_linux.md

Then authenticate once with:  gh auth login`);
  }

  const auth = await probe(["gh", "auth", "status"]);
  if (auth === null || auth.code !== 0) {
    throw new CliError(`The GitHub CLI is installed but not authenticated.

Run:  gh auth login

Watching a run needs the "repo" scope.`);
  }

  const origin = await probe(["git", "remote", "get-url", "origin"]);
  const originUrl = origin === null ? "" : origin.stdout.trim();
  if (origin === null || origin.code !== 0 || originUrl === "") {
    throw new CliError(`This checkout has no GitHub remote, so there is no CI to verify.

  git remote -v reports: ${originUrl || "(no origin remote)"}

Add one and push, then retry:

  git remote add origin git@github.com:<owner>/<repo>.git
  git push -u origin main
  bun run verify:ci`);
  }

  const repo = await must(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], "resolving the repository");
  if (repo.code !== 0) {
    throw new CliError(`gh could not resolve the repository for remote ${originUrl}:\n${repo.stderr.trim()}`);
  }
  return repo.stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function gitHead(): Promise<string> {
  const head = await must(["git", "rev-parse", "HEAD"], "reading HEAD");
  if (head.code !== 0) throw new CliError(`git rev-parse HEAD failed:\n${head.stderr.trim()}`);
  return head.stdout.trim();
}

async function runFor(workflow: string, sha: string): Promise<RunInfo | null> {
  const result = await must(
    ["gh", "run", "list", "--workflow", workflow, "--commit", sha, "--limit", "1", "--json", RUN_FIELDS],
    `listing ${workflow} runs`,
  );
  if (result.code !== 0) {
    // A workflow that does not exist on the remote yet is not a failure of this script.
    warn(`could not list ${workflow} runs: ${result.stderr.trim()}`);
    return null;
  }
  let runs: RunInfo[];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    runs = parsed as RunInfo[];
  } catch {
    throw new CliError(`gh returned something that is not a run list for ${workflow}.`);
  }
  return runs[0] ?? null;
}

/** True when `sha` is reachable from a remote-tracking branch — i.e. the remote has this commit. */
async function onRemote(sha: string): Promise<boolean> {
  const fetch = await probe(["git", "fetch", "--quiet", "origin"]);
  if (fetch !== null && fetch.code !== 0) {
    warn(`git fetch origin failed; deciding "is HEAD pushed" from the refs already on disk:\n${fetch.stderr.trim()}`);
  }
  const contains = await probe(["git", "branch", "-r", "--contains", sha]);
  if (contains === null || contains.code !== 0) return false;
  return contains.stdout.trim().length > 0;
}

function summarize(run: RunInfo): string {
  const state = run.conclusion ?? run.status;
  return `${run.workflowName || "?"} run ${run.databaseId}: ${state}`;
}

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return total;
}

async function main(): Promise<number> {
  const repo = await preflight();
  const head = await gitHead();

  log(`monaca verify:ci — ${repo} @ ${head.slice(0, 12)}`);

  if (!(await onRemote(head))) {
    process.stderr.write(`
verify:ci: HEAD is not on the remote.

  HEAD:    ${head}
  remote:  origin

CI runs on commits the remote has, and this script deliberately does not push. Push first:

  git push -u origin $(git rev-parse --abbrev-ref HEAD)

Then re-run:  bun run verify:ci
`);
    return 1;
  }

  // ---- locate the runs ---------------------------------------------------------------------
  const found: { workflow: string; run: RunInfo }[] = [];
  const missing: string[] = [];
  for (const workflow of WORKFLOWS) {
    const run = await runFor(workflow, head);
    if (run === null) missing.push(workflow);
    else found.push({ workflow, run });
  }

  if (found.length === 0) {
    process.stderr.write(`
verify:ci: HEAD is on the remote but no workflow run exists for it yet.

  HEAD: ${head}

A run appears within a few seconds of the push and then queues. Nothing was watched.

  gh run list --limit 10          # see what the remote has
  gh run watch                    # watch the newest run
`);
    return 1;
  }
  if (missing.length > 0) {
    warn(`no run for ${missing.join(", ")} at this commit — their paths filters probably skipped it`);
  }

  log("");
  for (const { workflow, run } of found) log(`  ${workflow.padEnd(10)} ${summarize(run)}`);
  log("");

  // ---- watch -------------------------------------------------------------------------------
  let failed = 0;
  const watched: { workflow: string; run: RunInfo; code: number }[] = [];
  for (const { workflow, run } of found) {
    log(`--- gh run watch ${run.databaseId} (${workflow}) ---`);
    // --exit-status is what turns a red job into a non-zero exit here; without it gh watches
    // and reports success regardless of the run's conclusion.
    const code = await passthrough(["gh", "run", "watch", String(run.databaseId), "--exit-status", "--compact"]);
    watched.push({ workflow, run, code });
    if (code !== 0) failed++;
  }

  // ---- collect reports ---------------------------------------------------------------------
  // One directory per commit, with the artifact's *contents* directly inside it, so the shape
  // matches §2.3 (skeleton.json, playwright-report/, test-results/) with a sha to keep two
  // verifications from overwriting each other. `gh run download --name` extracts a single
  // artifact's contents into --dir; without --name it would add a redundant artifact-name level.
  const reportDir = join(ROOT, ".monaca", "reports", head);
  mkdirSync(reportDir, { recursive: true });

  const collected: string[] = [];
  for (const { run } of found) {
    for (const artifact of REPORT_ARTIFACTS) {
      const result = await probe([
        "gh", "run", "download", String(run.databaseId),
        "--name", artifact,
        "--dir", reportDir,
      ]);
      // Only rust.yml uploads e2e-report; its absence in web.yml is expected, not a failure.
      if (result === null || result.code !== 0) continue;
      if (!collected.includes(artifact)) collected.push(artifact);
    }
  }

  log("");
  log("results:");
  for (const { workflow, run, code } of watched) {
    log(`  ${code === 0 ? "PASS" : "FAIL"}  ${workflow.padEnd(10)} ${run.url}`);
  }
  if (collected.length > 0) {
    log("");
    log(`reports: ${relative(ROOT, reportDir).replaceAll("\\", "/")} (${countFiles(reportDir)} file(s))`);
    for (const artifact of collected) log(`  ${artifact} contents`);
  } else {
    log("");
    log(`reports: none — no ${REPORT_ARTIFACTS.join("/")} artifact was available`);
  }

  if (failed > 0) {
    log("");
    log(`${failed} of ${watched.length} watched workflow(s) failed. Per-job conclusions:`);
    for (const { run } of watched) {
      const jobs = await probe(["gh", "run", "view", String(run.databaseId), "--json", "jobs", "--jq", '.jobs[] | "    \\(.conclusion // .status)  \\(.name)"']);
      if (jobs !== null && jobs.code === 0) process.stdout.write(`${jobs.stdout}`);
    }
    return 1;
  }

  log("");
  log("all watched workflows passed.");
  return 0;
}

try {
  process.exitCode = await main();
} catch (cause) {
  if (cause instanceof CliError) {
    process.stderr.write(`\nverify:ci: ${cause.message}\n`);
  } else {
    process.stderr.write(`\nverify:ci failed: ${(cause as Error).message ?? String(cause)}\n`);
  }
  process.exitCode = 1;
}
