#!/usr/bin/env node
/**
 * Launcher.
 *
 * Node 22.18+ runs TypeScript directly. The engine range starts at 22.5, where
 * type stripping still needs a flag, so this re-execs once instead of asking the
 * user to remember anything or adding a build step. Keeps the package
 * dependency-free: no bundler, no tsc, no node_modules.
 *
 * Two guards matter here, because getting this wrong spawns processes in a
 * loop: `process.features.typescript` is the string "strip" when enabled and
 * false when not (it is never `true`), and SESSIONHUB_LAUNCHED makes a second
 * re-exec structurally impossible.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const supported = Boolean(process.features.typescript);
const alreadyRelaunched = process.env.SESSIONHUB_LAUNCHED === "1";

if (!supported && !alreadyRelaunched) {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", self, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, SESSIONHUB_LAUNCHED: "1" },
    },
  );
  if (child.error) {
    process.stderr.write(
      `sessionhub needs Node 22.5 or newer and could not restart itself (found ${process.version}): ${child.error.message}\n`,
    );
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

if (!supported) {
  process.stderr.write(
    `sessionhub needs Node 22.5 or newer with TypeScript support (found ${process.version}).\n`,
  );
  process.exit(1);
}

await import("./cli.ts");
