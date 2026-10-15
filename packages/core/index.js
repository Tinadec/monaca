/*
 * @monaca/core native binding loader (CommonJS on purpose — see package.json "type").
 *
 * The .node binaries are CI build artifacts fetched into this directory by
 * `bun run fetch:native` (docs/contracts/m0.md §2.4) — they are NOT npm packages, and the
 * package deliberately declares no platform optionalDependencies. That is why this file
 * replaces the napi-rs generated loader: the generated one tells you to reinstall npm
 * dependencies, which cannot help here.
 *
 * The rust.yml `codegen` job regenerates index.d.ts from `crates/monaca-napi`;
 * `bun run fetch:native` copies it here, and CI fails when the committed copy drifts.
 */
"use strict";

const path = require("node:path");

const BINARY_NAME = "monaca-core";

/** Artifact filename tuple, or null on a platform we do not build for. */
function platformTuple() {
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64-msvc";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  return null;
}

const tuple = platformTuple();
if (tuple === null) {
  const err = new Error(
    `@monaca/core: unsupported platform ${process.platform}/${process.arch}. ` +
      `Built targets: x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu ` +
      `(see packages/core/package.json "napi".targets).`,
  );
  err.code = "MONACA_CORE_PLATFORM_UNSUPPORTED";
  throw err;
}

let nativeBinding = null;
const attempts = [];
for (const candidate of [`./${BINARY_NAME}.${tuple}.node`, `./${BINARY_NAME}.node`]) {
  try {
    nativeBinding = require(path.join(__dirname, candidate));
    break;
  } catch (cause) {
    attempts.push(cause);
  }
}

if (nativeBinding === null) {
  const err = new Error(
    `@monaca/core: no native binary for this platform in ${__dirname} ` +
      `(expected ${BINARY_NAME}.${tuple}.node).\n` +
      `Native binaries are CI build artifacts, not npm packages. Fetch one with:\n` +
      `\n    bun run fetch:native\n` +
      `or, for a specific CI run:\n` +
      `\n    bun run fetch:native --run <run-id> [--branch <branch>] [--fmt]\n`,
  );
  err.code = "MONACA_CORE_BINARY_MISSING";
  if (attempts.length > 0) err.cause = attempts.map(String).join("\n");
  throw err;
}

module.exports = nativeBinding;
// Static property reads so cjs-module-lexer (Node's CJS→ESM named-export detection) sees
// each export; a bare `module.exports = nativeBinding` is opaque to it.
module.exports.Verifier = nativeBinding.Verifier;
module.exports.scopeSatisfies = nativeBinding.scopeSatisfies;
module.exports.version = nativeBinding.version;
