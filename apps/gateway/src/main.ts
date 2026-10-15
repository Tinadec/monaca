/**
 * The gateway's runnable entry (contract §9; `scripts/dev.ts` runs this file, and so does
 * `deploy/Dockerfile.gateway`). Deliberately thin: everything lives in `./index.ts`, whose
 * `createGateway()` is the library surface. This file only turns the environment into a
 * running server and wires the shutdown signals.
 */
import { createGateway } from "./index.ts";

const gateway = createGateway();

try {
  await gateway.listen();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`gateway failed to start: ${message}\n`);
  if (error instanceof Error && error.stack && process.env.MONACA_LOG_LEVEL === "debug") {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gateway.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`gateway shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
  });
}
