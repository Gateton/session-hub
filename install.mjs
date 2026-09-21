#!/usr/bin/env node
/**
 * The interactive installer, shared by every entry point.
 *
 * `install.sh` (curl | bash) and `install.ps1` (Windows) do nothing but find Node
 * and run this file, so there is exactly one implementation of the install logic
 * and one place where the questions are asked.
 *
 * What it does, in order:
 *   1. check Node is new enough (the hub needs node:sqlite with FTS5)
 *   2. find the hub: the directory this file is in, $SESSION_HUB_SOURCE, or a
 *      clone of $SESSION_HUB_REPO
 *   3. hand over to `sessionhub install`, which detects the agents on PATH, asks
 *      which ones to install into, and reports the one manual step left
 *
 * Nothing is installed without an answer from the person running it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const MIN_NODE = [22, 5];
const version = process.versions.node.split(".").map(Number);
if (version[0] < MIN_NODE[0] || (version[0] === MIN_NODE[0] && version[1] < MIN_NODE[1])) {
  console.error(
    [
      `session-hub needs Node ${MIN_NODE.join(".")} or newer, and this is ${process.versions.node}.`,
      "",
      "Install a newer Node (https://nodejs.org, or your package manager), then run this again.",
      "The reason is node:sqlite with FTS5: no other dependency is needed, and that one is built in.",
    ].join("\n"),
  );
  process.exit(1);
}

/** A directory is usable if it holds the CLI and the MCP server. */
function isHub(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, "bin", "sessionhub.mjs")) &&
    fs.existsSync(path.join(dir, "mcp", "server.mjs"));
}

function findHub() {
  const explicit = process.env.SESSION_HUB_SOURCE;
  if (isHub(explicit)) return explicit;
  if (isHub(here)) return here;

  // Running from a pipe (curl | bash): the file is somewhere in /tmp, so the code
  // has to be fetched. Cloning is the only thing that needs git; everything after
  // this point is plain Node.
  const repo = process.env.SESSION_HUB_REPO;
  if (!repo) return null;

  const target = process.env.SESSION_HUB_DIR || path.join(os.homedir(), ".session-hub", "src");
  console.log(`Fetching session-hub from ${repo} into ${target} ...`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const clone = spawnSync("git", ["clone", "--depth", "1", repo, target], { stdio: "inherit" });
  if ((clone.status ?? 1) !== 0 || !isHub(target)) {
    console.error(
      [
        "",
        "Could not fetch the repository.",
        "Set SESSION_HUB_DIR to a different path, or clone it yourself and run:",
        "  node <checkout>/install.mjs",
      ].join("\n"),
    );
    process.exit(1);
  }
  return target;
}

const hub = findHub();
if (!hub) {
  console.error(
    [
      "This script cannot find session-hub's own files.",
      "",
      "You are running the installer on its own, without a checkout next to it.",
      "Either run it from inside the repository:",
      "",
      "  node install.mjs",
      "",
      "or tell it where the repository is, which is what the published one-liner does:",
      "",
      "  SESSION_HUB_REPO=https://github.com/<owner>/session-hub node install.mjs",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`session-hub installer\n  node ${process.versions.node}\n  source ${hub}\n`);

const cli = path.join(hub, "bin", "sessionhub.mjs");
const result = spawnSync(process.execPath, [cli, "install", ...argv], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
