#!/usr/bin/env node
/**
 * Install session-hub's delivery hooks into Codex's own hooks file.
 *
 * Why this exists: Codex loads a plugin's skills and MCP servers, but a plugin's
 * `hooks/hooks.json` does not show up in `/hooks` on 0.154.0, so the plugin can
 * find and load a session but cannot deliver it automatically. Registering the
 * same, already-verified handler in `$CODEX_HOME/hooks.json` does work.
 *
 * It is deliberately conservative: it only touches its own two entries, backs up
 * the file first, is idempotent (re-running updates the path instead of adding a
 * second copy), and can undo itself with --remove.
 *
 * Usage:
 *   node scripts/install-hooks.mjs            # install
 *   node scripts/install-hooks.mjs --dry-run  # show what would change
 *   node scripts/install-hooks.mjs --remove   # uninstall
 *   node scripts/install-hooks.mjs --target /path/to/plugin-dir
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
const hooksFile = path.join(codexHome, "hooks.json");

// A fresh CODEX_HOME (a scratch home, or Codex's first run on a machine) has no
// directory yet, and writing hooks.json into a missing directory used to end in a
// raw node:fs stack trace.
try {
  fs.mkdirSync(codexHome, { recursive: true });
} catch (err) {
  console.error(`session-hub: cannot create ${codexHome}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
const pluginDir = valueOf("--target") ? path.resolve(valueOf("--target")) : path.resolve(scriptDir, "..");
const hookScript = path.join(pluginDir, "scripts", "sessionhub-hook.mjs");
const cliScript = path.join(pluginDir, "scripts", "hub-cli.mjs");

/** The marker that identifies our entries, whatever path they point at. */
const MARKER = "sessionhub-hook.mjs";

if (!fs.existsSync(hookScript)) {
  console.error(`session-hub: no hook script at ${hookScript}`);
  process.exit(2);
}

let config = {};
let existed = false;
if (fs.existsSync(hooksFile)) {
  existed = true;
  try {
    config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch (err) {
    console.error(`session-hub: ${hooksFile} is not valid JSON, refusing to touch it (${err.message})`);
    process.exit(2);
  }
}
if (typeof config !== "object" || config === null || Array.isArray(config)) {
  console.error(`session-hub: ${hooksFile} is not a JSON object, refusing to touch it`);
  process.exit(2);
}
config.hooks ??= {};

function handler() {
  return {
    type: "command",
    command: `node "${hookScript}"`,
    commandWindows: `node "${hookScript}"`,
    timeout: 25,
    statusMessage: "session-hub: checking for a session you picked",
    additionalContextLimit: 12000,
  };
}

function entriesFor(event) {
  const groups = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
  return groups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) =>
      Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === "string" && h.command.includes(MARKER)),
    );
}

const events = ["SessionStart", "UserPromptSubmit"];
const before = JSON.stringify(config);
const report = [];

if (has("--remove")) {
  for (const event of events) {
    const found = entriesFor(event);
    for (const { group, index } of found.reverse()) {
      // Our handler may share a group with someone else's; only drop ours.
      const kept = group.hooks.filter((h) => !(typeof h?.command === "string" && h.command.includes(MARKER)));
      if (kept.length > 0) group.hooks = kept;
      else config.hooks[event].splice(index, 1);
      report.push(`removed one session-hub entry from ${event}`);
    }
    if (Array.isArray(config.hooks[event]) && config.hooks[event].length === 0) delete config.hooks[event];
  }
} else {
  for (const event of events) {
    config.hooks[event] = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const found = entriesFor(event);
    if (found.length > 0) {
      for (const { group } of found) {
        const ours = group.hooks.filter((h) => typeof h?.command === "string" && h.command.includes(MARKER));
        for (const entry of ours) {
          if (entry.command !== handler().command) {
            entry.command = handler().command;
            entry.commandWindows = handler().commandWindows;
            report.push(`updated the session-hub entry in ${event} to ${hookScript}`);
          } else {
            report.push(`the session-hub entry in ${event} is already current`);
          }
        }
      }
      continue;
    }
    config.hooks[event].push({ hooks: [handler()] });
    report.push(`added a session-hub entry to ${event}`);
  }
}

const after = JSON.stringify(config);
const changed = before !== after;

if (!changed) {
  console.log(`nothing to do: ${hooksFile} already reflects this plugin (${hookScript})`);
  process.exit(0);
}

if (has("--dry-run")) {
  console.log(`dry run, would write ${hooksFile}:`);
  for (const line of report) console.log(`  - ${line}`);
  process.exit(0);
}

if (existed) {
  const backup = `${hooksFile}.session-hub-${Date.now()}.bak`;
  fs.copyFileSync(hooksFile, backup);
  console.log(`backup: ${backup}`);
}
try {
  fs.writeFileSync(hooksFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
} catch (err) {
  console.error(`session-hub: could not write ${hooksFile}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

console.log(`wrote ${hooksFile}`);
for (const line of report) console.log(`  - ${line}`);
console.log(
  [
    "",
    "Next: run /hooks in Codex and trust the session-hub entries once.",
    "Until you do, the tools and the skill work but a picked session is not delivered",
    "automatically. Undo at any time with:",
    "",
    `  node "${path.join(pluginDir, "scripts", "install-hooks.mjs")}" --remove`,
    "",
    `The handler runs: node "${hookScript}"`,
    `It calls:        node "${cliScript}" pending --take`,
    "which prints nothing when nothing is pending, so the cost is one short-lived",
    "process on most turns.",
  ].join("\n"),
);
