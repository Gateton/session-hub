/**
 * Shared resolver for harness integrations. Plain JavaScript on purpose: hooks
 * and MCP servers run under whatever Node happens to be on PATH, before any
 * TypeScript support is guaranteed.
 *
 * Copy this file into each integration directory (see tools/sync-shared.mjs) so
 * every plugin stays self-contained when a harness copies it into its own cache.
 *
 * Resolution order, first hit wins:
 *   1. $SESSION_HUB_ROOT
 *   2. <plugin>/vendor          (self-contained copy, created by `sessionhub vendor`)
 *   3. ~/.session-hub/install.json  (written by `sessionhub setup`)
 *   4. an ancestor directory of cwd that looks like a checkout
 *   5. the `sessionhub` binary on PATH
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function looksLikeRoot(dir) {
  if (!dir) return false;
  try {
    return (
      fs.existsSync(path.join(dir, "bin", "sessionhub.mjs")) &&
      fs.existsSync(path.join(dir, "mcp", "server.mjs"))
    );
  } catch {
    return false;
  }
}

function readInstallRecord() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".session-hub", "install.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.root === "string" ? parsed.root : null;
  } catch {
    return null;
  }
}

function walkUpForRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (looksLikeRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function onPath(binary) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable PATH entry, keep looking */
    }
  }
  return null;
}

/** Where the hub lives, or null when it cannot be found anywhere. */
export function hubRoot(pluginRoot) {
  const fromEnv = process.env.SESSION_HUB_ROOT;
  if (looksLikeRoot(fromEnv)) return fromEnv;

  if (pluginRoot && looksLikeRoot(path.join(pluginRoot, "vendor"))) {
    return path.join(pluginRoot, "vendor");
  }

  const recorded = readInstallRecord();
  if (looksLikeRoot(recorded)) return recorded;

  const fromCwd = walkUpForRoot(process.cwd());
  if (fromCwd) return fromCwd;

  return null;
}

export function missingHubMessage() {
  return [
    "session-hub is installed but its command line cannot be found.",
    "",
    "Fix it with either:",
    "  sessionhub setup                      # records where the hub lives",
    "  export SESSION_HUB_ROOT=/path/to/session-hub",
    "",
    "The path must contain bin/sessionhub.mjs and mcp/server.mjs.",
  ].join("\n");
}

/**
 * Run the hub CLI. Returns { code, stdout, stderr, missing } and never throws on
 * a non-zero exit, because callers need to report the hub's own error text.
 */
export async function runHub(args, options = {}) {
  const pluginRoot = options.pluginRoot;
  const root = hubRoot(pluginRoot);
  const timeoutMs = options.timeoutMs ?? 120_000;

  let command;
  let argv;
  if (root) {
    command = process.execPath;
    argv = [path.join(root, "bin", "sessionhub.mjs"), ...args];
  } else {
    const binary = onPath("sessionhub");
    if (!binary) return { code: 127, stdout: "", stderr: missingHubMessage(), missing: true };
    command = binary;
    argv = args;
  }

  return await new Promise((resolve) => {
    const child = spawn(command, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SESSION_HUB_ROOT: root ?? process.env.SESSION_HUB_ROOT ?? "" },
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}\n`, missing: true }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Run the hub CLI with --json and parse it. */
export async function runHubJson(args, options = {}) {
  const result = await runHub([...args, "--json"], options);
  if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim(), result };
  try {
    return { ok: true, data: JSON.parse(result.stdout), result };
  } catch (err) {
    return { ok: false, error: `could not parse hub output: ${err.message}`, result };
  }
}
