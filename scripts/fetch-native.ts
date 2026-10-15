#!/usr/bin/env bun
/*
 * bun run fetch:native [--run <id>] [--branch <name>] [--fmt] [--dry-run]
 *
 * Places this platform's CI artifacts exactly where docs/contracts/m0.md §2.4 and §10.5 say
 * they belong. Rust compiles only in GitHub Actions (there is no local toolchain), so this is
 * how a developer gets a runnable `monaca-server` and a native `@monaca/core` verifier.
 *
 * Self-contained on purpose: scripts/lib/ is shared with other script owners and this file
 * must not race them for a module name.
 *
 * Failure contract: every path out of here either prints a summary and exits 0, or prints a
 * single actionable message and exits 1. An unhandled stack trace is a bug in this script —
 * `main()` catches everything, and `gh`/`git` are always spawned through `probe()`, which
 * turns ENOENT into a value instead of a throw.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const USAGE = `bun run fetch:native [options]

Downloads the CI artifacts for one rust.yml run into the destinations in
docs/contracts/m0.md §2.4.

  --run <id>        use this workflow run id
  --branch <name>   newest successful run on that branch (default: the current branch,
                    tried only when the current commit has no successful run)
  --fmt             also download the "rustfmt-patch" artifact and \`git apply\` it
  --dry-run         print the gh commands and destinations; download nothing
  -h, --help        this text
`;

/** A failure the user can act on; printed without a stack trace. */
class CliError extends Error {}

interface Options {
  run: string | null;
  branch: string | null;
  fmt: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { run: null, branch: null, fmt: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    switch (arg) {
      case "--run": {
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) throw new CliError("--run needs a workflow run id");
        opts.run = value;
        break;
      }
      case "--branch": {
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) throw new CliError("--branch needs a branch name");
        opts.branch = value;
        break;
      }
      case "--fmt":
        opts.fmt = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new CliError(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// process plumbing
// ---------------------------------------------------------------------------------------------

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `cmd` and returns its result, or null when the executable could not be started at all
 * (Bun throws ENOENT for a missing binary rather than returning a non-zero exit code).
 */
async function probe(cmd: string[]): Promise<ProcResult | null> {
  const program = cmd[0];
  if (program === undefined) return null;
  try {
    const proc = Bun.spawn(cmd, { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

/** `probe`, but a missing executable is a CliError. */
async function must(cmd: string[], what: string): Promise<ProcResult> {
  const result = await probe(cmd);
  if (result === null) throw new CliError(`${cmd[0]} could not be started while ${what}.`);
  return result;
}

/** Quotes an argument for display only — it is passed to spawn as-is. */
function display(cmd: string[]): string {
  return cmd.map((part) => (/^[\w./:=@-]+$/.test(part) ? part : `'${part}'`)).join(" ");
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

const GH_MISSING = `This command needs the GitHub CLI (gh) on PATH, and it is not installed.

  Windows:  winget install --id GitHub.cli
  macOS:    brew install gh
  Linux:    https://github.com/cli/cli/blob/trunk/docs/install_linux.md

Then authenticate once with:  gh auth login`;

const GH_UNAUTHENTICATED = `The GitHub CLI is installed but not authenticated.

Run:  gh auth login

Artifacts are read from the repository's Actions runs, so the token needs the "repo" scope
("workflow" too if you also want to dispatch runs).`;

function noRemoteMessage(origin: string): string {
  return `This checkout has no usable GitHub remote, so there is nowhere to fetch artifacts from.

  git remote -v reports: ${origin.trim() || "(no origin remote)"}

Artifacts come from the rust.yml runs on GitHub. Once the repository has a remote:

  git remote add origin git@github.com:<owner>/<repo>.git
  git push -u origin main          # CI then produces the artifacts
  bun run fetch:native

Until then, mode A is not available: build locally is not possible either, because Rust is
compiled only in CI.`;
}

async function preflight(): Promise<string> {
  const version = await probe(["gh", "--version"]);
  if (version === null) throw new CliError(GH_MISSING);

  const auth = await probe(["gh", "auth", "status"]);
  if (auth === null || auth.code !== 0) {
    throw new CliError(`${GH_UNAUTHENTICATED}\n\ngh auth status said:\n${(auth?.stderr ?? "").trim()}`);
  }

  const origin = await probe(["git", "remote", "get-url", "origin"]);
  const originUrl = origin === null ? "" : origin.stdout.trim();
  if (origin === null || origin.code !== 0 || originUrl === "") throw new CliError(noRemoteMessage(originUrl));

  // A remote URL is not enough: gh resolves the repository from the remote, and a remote that
  // gh cannot map (a fork with no upstream, an unknown host) fails here rather than mid-download.
  const repo = await must(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], "resolving the repository");
  if (repo.code !== 0) {
    throw new CliError(
      `gh could not resolve the repository for remote ${originUrl}:\n${repo.stderr.trim()}\n\n` +
        `Check the remote points at a GitHub repository you can read.`,
    );
  }
  return repo.stdout.trim();
}

// ---------------------------------------------------------------------------------------------
// run lookup
// ---------------------------------------------------------------------------------------------

interface RunInfo {
  databaseId: number;
  headSha: string;
  headBranch: string;
  url: string;
  conclusion: string | null;
}

const RUN_FIELDS = "databaseId,headSha,headBranch,url,conclusion";

async function gitHead(): Promise<string> {
  const head = await must(["git", "rev-parse", "HEAD"], "reading HEAD");
  if (head.code !== 0) throw new CliError(`git rev-parse HEAD failed:\n${head.stderr.trim()}`);
  return head.stdout.trim();
}

async function gitBranch(): Promise<string> {
  const branch = await probe(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  const name = branch === null ? "" : branch.stdout.trim();
  // A detached HEAD has no branch name; the caller reports that instead of guessing one.
  return name === "HEAD" ? "" : name;
}

function parseRuns(stdout: string, what: string): RunInfo[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed as RunInfo[];
  } catch {
    throw new CliError(`gh returned something that is not a run list while ${what}.`);
  }
}

/**
 * `gh run list --workflow <file>` 404s when the workflow has never run — GitHub only registers
 * a workflow on the default branch once a run for it exists. That is the ordinary state of a
 * fresh repository, so it becomes an empty list and the caller reports "no successful run".
 */
function isUnregisteredWorkflow(result: ProcResult): boolean {
  return result.stderr.includes("workflow") && result.stderr.includes("not found");
}

async function listRuns(args: string[], what: string): Promise<RunInfo[]> {
  const result = await must(["gh", "run", "list", "--workflow", "rust.yml", ...args, "--limit", "1", "--json", RUN_FIELDS], what);
  if (result.code !== 0) {
    if (isUnregisteredWorkflow(result)) return [];
    throw new CliError(`gh run list failed:\n${result.stderr.trim()}`);
  }
  return parseRuns(result.stdout, what);
}

function runsForCommit(sha: string): Promise<RunInfo[]> {
  return listRuns(["--commit", sha, "--status", "success"], "listing runs for this commit");
}

function runsForBranch(branch: string): Promise<RunInfo[]> {
  return listRuns(["--branch", branch, "--status", "success"], "listing runs for this branch");
}

async function runById(id: string): Promise<RunInfo> {
  const result = await must(["gh", "run", "view", id, "--json", RUN_FIELDS], "reading the run");
  if (result.code !== 0) throw new CliError(`gh run view ${id} failed:\n${result.stderr.trim()}`);
  let info: RunInfo;
  try {
    info = JSON.parse(result.stdout) as RunInfo;
  } catch {
    throw new CliError(`gh returned something that is not a run while reading run ${id}.`);
  }
  if (info.conclusion !== "success") {
    warn(`run ${id} concluded ${info.conclusion ?? "unknown"}, not success; its artifacts may be incomplete`);
  }
  return info;
}

const NO_RUNS = (sha: string, branch: string): string => `No successful rust.yml run found for this commit.

  HEAD:    ${sha}
  branch:  ${branch || "(detached HEAD)"}

Rust artifacts exist only as CI build artifacts, so there is nothing to fetch until a run
succeeds. Most likely causes, in order:

  1. The commit is not pushed. Check with:  git log --oneline origin/main..HEAD
  2. The run is still going. Check with:    gh run list --workflow rust.yml --limit 5
  3. The run failed. Read it with:          gh run view --log-failed
  4. rust.yml's paths filter skipped it: a commit touching only docs/ or *.md produces no run
     at all, because nothing in it can change a Rust artifact.

Once a run is green, retry — or name one explicitly:

  bun run fetch:native --run <run-id>
  bun run fetch:native --branch main`;

// ---------------------------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------------------------

interface Download {
  /** Artifact name as uploaded by rust.yml (§10.5). */
  artifact: string;
  /** File the artifact contains. */
  file: string;
  /** Destination, relative to the repository root. */
  dest: string;
}

interface PlatformPlan {
  downloads: Download[];
}

function platformPlan(): PlatformPlan {
  const platform = `${process.platform}/${process.arch}`;

  if (process.platform === "win32" && process.arch === "x64") {
    return {
      downloads: [
        { artifact: "server-x86_64-pc-windows-msvc", file: "monaca-server.exe", dest: ".monaca/bin/monaca-server.exe" },
        { artifact: "binding-x86_64-pc-windows-msvc", file: "monaca-core.win32-x64-msvc.node", dest: "packages/core/monaca-core.win32-x64-msvc.node" },
      ],
    };
  }

  if (process.platform === "linux" && process.arch === "x64") {
    return {
      downloads: [
        { artifact: "server-x86_64-unknown-linux-gnu", file: "monaca-server", dest: ".monaca/bin/monaca-server" },
        { artifact: "binding-x86_64-unknown-linux-gnu", file: "monaca-core.linux-x64-gnu.node", dest: "packages/core/monaca-core.linux-x64-gnu.node" },
      ],
    };
  }

  throw new CliError(
    `No CI artifacts are built for ${platform}.\n\n` +
      `rust.yml builds x86_64-pc-windows-msvc and x86_64-unknown-linux-gnu ` +
      `(packages/core/package.json "napi".targets).`,
  );
}

/** `codegen` is one artifact with three destinations (§10.5), so it is handled separately. */
const CODEGEN_ARTIFACT = "codegen";
const RUSTFMT_ARTIFACT = "rustfmt-patch";

function bytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/**
 * Short digest of a placed file, for the summary. `Bun.file(path)` cannot be handed straight
 * to CryptoHasher ("Bun.file() is not supported here yet"), so the bytes are read first.
 */
async function digest(path: string): Promise<string> {
  try {
    const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
    return Bun.CryptoHasher.hash("sha256", buf, "hex").slice(0, 16);
  } catch {
    return "unavailable";
  }
}

function human(size: number): string {
  if (size < 0) return "?";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

async function downloadArtifact(runId: number, artifact: string, dir: string): Promise<void> {
  const cmd = ["gh", "run", "download", String(runId), "--name", artifact, "--dir", dir];
  const result = await must(cmd, `downloading ${artifact}`);
  if (result.code !== 0) {
    throw new CliError(`Downloading artifact "${artifact}" failed:\n${result.stderr.trim()}`);
  }
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const repo = await preflight();
  const plan = platformPlan();
  const head = await gitHead();

  log(`monaca fetch:native — ${repo}`);

  if (opts.dryRun) log("(dry run)");

  // ---- pick a run ---------------------------------------------------------------------------
  let run: RunInfo;
  let fallbackNote: string | null = null;

  if (opts.run !== null) {
    run = await runById(opts.run);
  } else if (opts.branch !== null) {
    const candidates = await runsForBranch(opts.branch);
    const first = candidates[0];
    if (first === undefined) {
      throw new CliError(`No successful rust.yml run on branch "${opts.branch}".\n\nCheck with: gh run list --workflow rust.yml --branch ${opts.branch}`);
    }
    run = first;
  } else {
    const forHead = (await runsForCommit(head))[0];
    if (forHead !== undefined) {
      run = forHead;
    } else {
      const branch = await gitBranch();
      if (branch === "") throw new CliError(NO_RUNS(head, ""));
      const forBranch = (await runsForBranch(branch))[0];
      if (forBranch === undefined) throw new CliError(NO_RUNS(head, branch));
      run = forBranch;
      fallbackNote =
        `no successful rust.yml run for HEAD ${head.slice(0, 12)}; falling back to the newest ` +
        `successful run on ${branch}`;
    }
  }

  if (run.headSha !== head) {
    warn(
      `run ${run.databaseId} built ${run.headSha.slice(0, 12)} (${run.headBranch}), ` +
        `but HEAD is ${head.slice(0, 12)} — the artifacts may not match your working tree`,
    );
  }
  if (fallbackNote !== null) warn(fallbackNote);

  log(`run      ${run.databaseId} (${run.headBranch} @ ${run.headSha.slice(0, 12)})`);
  log(`url      ${run.url}`);

  // ---- plan --------------------------------------------------------------------------------
  const cacheRoot = join(ROOT, ".monaca", "cache", String(run.databaseId));
  const codegenStaging = join(cacheRoot, "codegen");
  const rustfmtStaging = join(cacheRoot, "rustfmt-patch");
  /** One empty staging directory per binary artifact — see the download loop for why. */
  const stagingDir = (artifact: string): string => join(cacheRoot, "unpack", artifact);

  interface Planned {
    artifact: string;
    dir: string;
    into: string[];
  }

  const planned: Planned[] = plan.downloads.map((download) => ({
    artifact: download.artifact,
    dir: stagingDir(download.artifact),
    into: [join(ROOT, download.dest)],
  }));
  planned.push({
    artifact: CODEGEN_ARTIFACT,
    dir: codegenStaging,
    into: [join(ROOT, "packages/core/index.d.ts"), join(ROOT, "spec/openapi.json"), join(ROOT, "spec/events/")],
  });
  if (opts.fmt) {
    planned.push({ artifact: RUSTFMT_ARTIFACT, dir: rustfmtStaging, into: ["git apply"] });
  }

  if (opts.dryRun) {
    log("");
    log("dry run — nothing will be downloaded. Planned commands:");
    for (const item of planned) {
      log("");
      log(`  ${display(["gh", "run", "download", String(run.databaseId), "--name", item.artifact, "--dir", item.dir])}`);
      for (const dest of item.into) log(`      → ${dest}`);
    }
    log("");
    log("Re-run without --dry-run to perform the download.");
    return 0;
  }

  // ---- download ----------------------------------------------------------------------------
  const placed: { artifact: string; dest: string; size: number; digest: string }[] = [];

  for (const download of plan.downloads) {
    // Each artifact unpacks into an empty directory, never into its final destination. Two
    // reasons: a stale file from a previous run would otherwise satisfy the existence check
    // below and be reported as freshly fetched, and unpacking into packages/core would drop
    // whatever else the artifact happened to contain straight into a committed source tree.
    const staging = stagingDir(download.artifact);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    await downloadArtifact(run.databaseId, download.artifact, staging);

    const staged = join(staging, download.file);
    if (!existsSync(staged)) {
      throw new CliError(
        `artifact "${download.artifact}" does not contain ${download.file}.\n` +
          `Looked in ${staging}, which holds: ${readdirSync(staging).join(", ") || "(nothing)"}.\n` +
          `The artifact name and its contents are the interface with rust.yml ` +
          `(docs/contracts/m0.md §10.5); fix the workflow, not this script.`,
      );
    }
    const dest = join(ROOT, download.dest);
    mkdirSync(resolve(dest, ".."), { recursive: true });
    copyFileSync(staged, dest);
    // The server binary is executed directly on linux/macOS; the .node is dlopen'd, so only
    // the binary needs the bit.
    if (download.dest.endsWith("monaca-server")) chmodSync(dest, 0o755);
    placed.push({ artifact: download.artifact, dest: download.dest, size: bytes(dest), digest: await digest(dest) });
  }

  // codegen: one artifact, three committed destinations (§2.4, §10.5).
  mkdirSync(codegenStaging, { recursive: true });
  try {
    await downloadArtifact(run.databaseId, CODEGEN_ARTIFACT, codegenStaging);
  } catch (cause) {
    throw new CliError(
      `${(cause as Error).message}\n\n` +
        `The "codegen" artifact carries the committed generated files (packages/core/index.d.ts, ` +
        `spec/openapi.json, spec/events/*.json). Without it the committed copies stay as they ` +
        `are, which is why this is fatal rather than a warning: a silent skip would look like a ` +
        `successful refresh.`,
    );
  }

  const codegenFiles = [
    { from: "index.d.ts", to: "packages/core/index.d.ts" },
    { from: "openapi.json", to: "spec/openapi.json" },
  ];
  for (const file of codegenFiles) {
    const from = join(codegenStaging, file.from);
    if (!existsSync(from)) throw new CliError(`the "codegen" artifact is missing ${file.from}`);
    mkdirSync(resolve(join(ROOT, file.to), ".."), { recursive: true });
    copyFileSync(from, join(ROOT, file.to));
    placed.push({ artifact: CODEGEN_ARTIFACT, dest: file.to, size: bytes(join(ROOT, file.to)), digest: await digest(join(ROOT, file.to)) });
  }

  const eventsFrom = join(codegenStaging, "events");
  if (!existsSync(eventsFrom)) throw new CliError(`the "codegen" artifact is missing events/`);
  const eventsTo = join(ROOT, "spec", "events");
  mkdirSync(eventsTo, { recursive: true });
  // The generated directory owns its contents: a stale schema must not survive a rename of an
  // action name, which is the same rule the codegen job applies to its own working tree.
  for (const entry of readdirSync(eventsTo)) {
    if (entry.endsWith(".json")) rmSync(join(eventsTo, entry));
  }
  let eventCount = 0;
  for (const entry of readdirSync(eventsFrom)) {
    if (!entry.endsWith(".json")) continue;
    copyFileSync(join(eventsFrom, entry), join(eventsTo, entry));
    eventCount++;
  }
  placed.push({
    artifact: CODEGEN_ARTIFACT,
    dest: `spec/events/ (${eventCount} file${eventCount === 1 ? "" : "s"})`,
    size: -1,
    digest: "-",
  });

  // ---- summary -----------------------------------------------------------------------------
  // Printed before the --fmt step below, not after: the downloads are the primary job, and a
  // failed `git apply` must not hide the fact that they all succeeded.
  log("");
  log("placed:");
  for (const item of placed) {
    log(`  ${item.dest.padEnd(48)} ${human(item.size).padStart(9)}  ${item.digest}`);
  }
  log("");
  log(`commit   ${run.headSha}`);
  log(`run      ${run.url}`);

  // ---- rustfmt -----------------------------------------------------------------------------
  // `--fmt` exists so a red `check` job on main has a documented local fix (§10.1). A failure
  // here is reported but does not discard the summary above, and it does not pretend the
  // downloads failed.
  let fmtFailed = false;
  if (opts.fmt) {
    log("");
    mkdirSync(rustfmtStaging, { recursive: true });
    let downloaded = true;
    try {
      await downloadArtifact(run.databaseId, RUSTFMT_ARTIFACT, rustfmtStaging);
    } catch {
      downloaded = false;
      log(`--fmt: this run has no "${RUSTFMT_ARTIFACT}" artifact, so the tree is already formatted.`);
      rmSync(rustfmtStaging, { recursive: true, force: true });
    }
    const patch = join(rustfmtStaging, "rustfmt.patch");
    if (downloaded && existsSync(patch)) {
      const applied = await must(["git", "apply", "--whitespace=nowarn", patch], "applying the rustfmt patch");
      if (applied.code === 0) {
        log(`--fmt: applied the rustfmt patch from run ${run.databaseId} (${bytes(patch)} bytes).`);
        rmSync(rustfmtStaging, { recursive: true, force: true });
      } else {
        fmtFailed = true;
        warn(
          `git apply of the rustfmt patch failed:\n${applied.stderr.trim()}\n\n` +
            `The patch was kept at ${patch} — apply it by hand, or delete it if it is stale.`,
        );
      }
    }
  }

  log("");
  log("Next: bun run dev   (mode A)   or   bun run e2e:skeleton --base-url <url>");
  return fmtFailed ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (cause) {
  if (cause instanceof CliError) {
    process.stderr.write(`\nfetch:native: ${cause.message}\n`);
  } else {
    process.stderr.write(`\nfetch:native failed: ${(cause as Error).message ?? String(cause)}\n`);
  }
  process.exitCode = 1;
}
