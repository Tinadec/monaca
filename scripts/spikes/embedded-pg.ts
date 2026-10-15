// Spike #2 (plan §10 step 1, contract §5.1): does `embedded-postgres` run under Bun on this OS,
// and does the per-org isolation pattern (SET LOCAL search_path + SET LOCAL ROLE inside one
// transaction, org role granted to monaca_app) hold when driven through Bun.sql?
//
//   bun scripts/spikes/embedded-pg.ts [--verbose]
//
// Creates a throwaway cluster in .monaca/spike-pg on port 54329, runs the checks, stops the
// cluster and deletes the directory. Exit 0 only when every check passed.
import { SQL } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startEmbeddedPg, type EmbeddedPgHandle } from "../lib/embedded-pg.ts";
import { isListening } from "../lib/net.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BASE_DIR = join(ROOT, ".monaca", "spike-pg");
const PORT = 54329;
const SUPERUSER = "monaca";
const SUPERUSER_PASSWORD = "monaca";
const APP_ROLE = "monaca_app";
const APP_PASSWORD = "monaca_app_spike";
const verbose = process.argv.includes("--verbose");

interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

const results: CheckResult[] = [];
const timings: Record<string, number | null> = {};

async function check<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - t0);
    results.push({ name, ok: true, ms, detail });
    console.log(`  ok    ${name} (${ms} ms)${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
    return detail;
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const error = pgErrorText(err);
    results.push({ name, ok: false, ms, error });
    console.log(`  FAIL  ${name} (${ms} ms)  ${error}`);
    throw err;
  }
}

/** Runs `fn` and requires it to fail with SQLSTATE `sqlstate`; returns the server message. */
async function expectPgError(sqlstate: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const state = sqlState(err);
    if (state === sqlstate) return `${state} ${(err as Error).message}`;
    throw new Error(`expected SQLSTATE ${sqlstate}, got ${pgErrorText(err)}`);
  }
  throw new Error(`expected SQLSTATE ${sqlstate}, but the statement succeeded`);
}

function sqlState(err: unknown): string | undefined {
  if (err instanceof SQL.PostgresError) return err.errno ?? err.code;
  return undefined;
}

function pgErrorText(err: unknown): string {
  if (err instanceof SQL.PostgresError) return `[${err.errno ?? "?"}/${err.code}] ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main(): Promise<number> {
  console.log(`spike: embedded-postgres + Bun.sql on ${process.platform}-${process.arch}, Bun ${Bun.version}`);
  if (await isListening(PORT)) {
    console.log(`  FAIL  port ${PORT} is already in use (is \`bun run dev\` running?)`);
    return 1;
  }
  await rm(BASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  let pg: EmbeddedPgHandle | undefined;
  const pools: SQL[] = [];
  let failed = false;
  try {
    pg = await check("initialise + start cluster", async () => {
      const handle = await startEmbeddedPg({
        baseDir: BASE_DIR,
        port: PORT,
        user: SUPERUSER,
        password: SUPERUSER_PASSWORD,
        onLog: verbose ? (line) => console.log(`        pg │ ${line}`) : undefined,
      });
      timings.initialise_ms = handle.timings.initialiseMs;
      timings.start_ms = handle.timings.startMs;
      return handle;
    });
    const cluster = pg;

    const admin = new SQL(cluster.url("postgres"), { max: 1 });
    pools.push(admin);
    const version = await check("select version()", async () => {
      const [row] = (await admin`select version() as version, current_setting('server_version_num') as num`) as {
        version: string;
        num: string;
      }[];
      assert(row, "no row");
      return row;
    });
    timings.pg_version_num = Number(version.num);

    await check(`CREATE ROLE ${APP_ROLE} LOGIN`, () =>
      admin.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`).then(() => undefined),
    );
    // CREATE DATABASE cannot run in a transaction block; a lone extended-protocol statement is fine.
    await check("CREATE DATABASE mt_spike", () => admin.unsafe("CREATE DATABASE mt_spike").then(() => undefined));
    await admin.close();

    const tenantDb = new SQL(cluster.url("mt_spike"), { max: 1 });
    pools.push(tenantDb);
    await check("tenant + org schemas, org roles, grants", async () => {
      const ddl = [
        "CREATE SCHEMA tenant",
        "CREATE SCHEMA org_a",
        "CREATE SCHEMA org_b",
        "CREATE ROLE t1_oa NOLOGIN",
        "CREATE ROLE t1_ob NOLOGIN",
        "GRANT USAGE ON SCHEMA org_a TO t1_oa",
        "GRANT USAGE ON SCHEMA org_b TO t1_ob",
        `GRANT t1_oa TO ${APP_ROLE}`,
        `GRANT t1_ob TO ${APP_ROLE}`,
        "CREATE TABLE org_a.notes (id uuid PRIMARY KEY, title text NOT NULL)",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON org_a.notes TO t1_oa",
      ];
      for (const stmt of ddl) await tenantDb.unsafe(stmt);
      const id = Bun.randomUUIDv7();
      await tenantDb`insert into org_a.notes (id, title) values (${id}, ${"hello from org_a"})`;
      return { statements: ddl.length, seeded_note: id };
    });

    // max: 1 pins every query below to one physical connection, so the post-transaction check
    // really observes the connection the transaction used.
    const app = new SQL(cluster.url("mt_spike", APP_ROLE, APP_PASSWORD), { max: 1 });
    pools.push(app);

    await check("as monaca_app: one tx with SET LOCAL search_path=org_a + SET LOCAL ROLE t1_oa", () =>
      app.begin(async (tx) => {
        await tx`SET LOCAL search_path = org_a`;
        await tx`SET LOCAL ROLE t1_oa`;
        const [who] = (await tx`select current_user as role, current_setting('search_path') as search_path`) as {
          role: string;
          search_path: string;
        }[];
        const notes = (await tx`select id, title from notes`) as { id: string; title: string }[];
        assert(who?.role === "t1_oa", `current_user is ${who?.role}`);
        assert(notes.length === 1 && notes[0]?.title === "hello from org_a", "seeded note not visible");
        return { current_user: who.role, search_path: who.search_path, rows: notes.length };
      }),
    );

    await check("SET LOCAL does not leak past COMMIT on the pooled connection", async () => {
      const [row] = (await app`select current_user as role, current_setting('search_path') as search_path`) as {
        role: string;
        search_path: string;
      }[];
      assert(row?.role === APP_ROLE, `connection still runs as ${row?.role}`);
      assert(!row.search_path.includes("org_a"), `search_path leaked: ${row.search_path}`);
      return { current_user: row.role, search_path: row.search_path };
    });

    await check("isolation: role t1_ob reading org_a.notes → permission denied", () =>
      expectPgError("42501", () =>
        app.begin(async (tx) => {
          await tx`SET LOCAL search_path = org_b`;
          await tx`SET LOCAL ROLE t1_ob`;
          await tx`select * from org_a.notes`;
        }),
      ),
    );

    await check("isolation: wrong search_path (org_a) under role t1_ob resolves nothing", () =>
      expectPgError("42P01", () =>
        app.begin(async (tx) => {
          await tx`SET LOCAL search_path = org_a`;
          await tx`SET LOCAL ROLE t1_ob`;
          await tx`select * from notes`;
        }),
      ),
    );

    // Finding: a plain `GRANT role TO monaca_app` defaults to INHERIT TRUE (PG ≥ 16), so the login
    // role holds the union of every org's privileges whenever SET ROLE is skipped.
    const inherited = await check("defence in depth: monaca_app WITHOUT SET ROLE (default INHERIT TRUE)", async () => {
      const rows = (await app`select count(*)::int as n from org_a.notes`) as { n: number }[];
      return { readable_without_set_role: true, rows: rows[0]?.n ?? 0 };
    });
    assert(inherited.readable_without_set_role, "unexpected");

    await check(`GRANT t1_oa TO ${APP_ROLE} WITH INHERIT FALSE closes that hole`, async () => {
      await tenantDb.unsafe(`GRANT t1_oa TO ${APP_ROLE} WITH INHERIT FALSE`);
      await tenantDb.unsafe(`GRANT t1_ob TO ${APP_ROLE} WITH INHERIT FALSE`);
      const denied = await expectPgError("42501", () => app`select count(*) from org_a.notes`);
      const viaRole = await app.begin(async (tx) => {
        await tx`SET LOCAL search_path = org_a`;
        await tx`SET LOCAL ROLE t1_oa`;
        return (await tx`select count(*)::int as n from notes`) as { n: number }[];
      });
      assert(viaRole[0]?.n === 1, "SET ROLE path broke after INHERIT FALSE");
      return { without_set_role: denied, with_set_role_rows: viaRole[0].n };
    });
  } catch {
    failed = true;
  } finally {
    for (const pool of pools) await pool.close().catch(() => undefined);
    if (pg) {
      const cluster = pg;
      await check("stop cluster (pg_ctl stop -m fast)", async () => {
        const r = await cluster.stop();
        timings.stop_ms = r.ms;
        assert(r.graceful, "pg_ctl could not stop the server; it was killed");
        assert(!(await isListening(PORT)), `port ${PORT} still open after stop`);
        return r;
      }).catch(() => {
        failed = true;
      });
    }
    await check("delete .monaca/spike-pg", async () => {
      const t0 = performance.now();
      await rm(BASE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      timings.delete_ms = Math.round(performance.now() - t0);
    }).catch(() => {
      failed = true;
    });
  }

  const ok = !failed && results.every((r) => r.ok);
  console.log(JSON.stringify({ spike: "embedded-pg", ok, platform: `${process.platform}-${process.arch}`, bun: Bun.version, timings, results }));
  return ok ? 0 : 1;
}

process.exit(await main());
