#!/usr/bin/env node
/**
 * MCP server for session-hub.
 *
 * A stdio JSON-RPC server, written by hand so the package keeps zero runtime
 * dependencies. "Server" here means a child process the harness spawns and kills
 * with the session: no port, no daemon, no network.
 *
 * Tools are deliberately few and named after what the user wants, not after the
 * storage:
 *   search  - find sessions across every harness
 *   context - bring one session's conversation into this conversation
 *   native  - the verified command that reopens that session where it lives
 *
 * Every tool returns text that a model can act on directly, and every failure
 * says what failed instead of returning an empty list.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

// Same guard as the CLI launcher, and for the same reason: re-exec at most once.
if (!Boolean(process.features.typescript) && process.env.SESSIONHUB_LAUNCHED !== "1") {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", self], {
    stdio: "inherit",
    env: { ...process.env, SESSIONHUB_LAUNCHED: "1" },
  });
  process.exit(child.status ?? 1);
}

const { start } = await import("./server.impl.ts");
await start();
