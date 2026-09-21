#!/usr/bin/env node
/**
 * The plugin's hook.
 *
 * Two events arrive here, both from Claude Code, both as JSON on stdin:
 *
 *   SessionStart      first-run self-vendoring, then deliver anything pending
 *   UserPromptSubmit   deliver anything pending
 *
 * Delivering means: the user ran `sessionhub pick <uid>` (or asked for the same
 * thing through the skill), so the hub holds one pending selection. Taking it
 * prints the ready-to-inject block, and this script hands that block back to
 * Claude Code as `hookSpecificOutput.additionalContext`. Nothing else ever
 * arrives this way: no pending selection, no injection.
 *
 * Three rules shape the rest of the file:
 *
 *   Fast. A prompt must not wait on the hub. The common case (nothing pending)
 *   is one cheap read of one small file, because `pending --peek` is asked
 *   first: only a live selection is worth the index work of taking it.
 *
 *   Silent on success-with-nothing-to-say. No pending selection prints nothing
 *   and exits 0. That is what "nothing to inject" looks like to Claude Code.
 *
 *   Never in the way. Every failure is swallowed, logged to stderr only when
 *   SESSIONHUB_DEBUG is set, and exits 0. The one thing this hook says out loud
 *   is that the hub is missing, because only the user can fix that.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hubRoot, runHubJson } from "./resolve.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(SCRIPT_DIR);

/** Claude Code caps a hook's additionalContext at 10,000 characters. */
const MAX_CONTEXT_CHARS = 9_600;
const PEEK_TIMEOUT_MS = 5_000;
const TAKE_TIMEOUT_MS = 15_000;
const VENDOR_MARKER = ".sessionhub-vendor-attempted";

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 300);
}

function debug(message) {
  if (process.env.SESSIONHUB_DEBUG) process.stderr.write(`[session-hub] ${message}\n`);
}

function emit(eventName, additionalContext) {
  if (typeof eventName !== "string" || !eventName) return;
  if (typeof additionalContext !== "string" || additionalContext.trim() === "") return;
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } })}\n`,
  );
}

/** Read the hook's JSON input. Gives up after a moment so a silent stdin cannot stall the hook. */
async function readHookInput(deadlineMs = 2_000) {
  const chunks = [];
  let settled = false;
  await new Promise((resolve) => {
    const timer = setTimeout(finish, deadlineMs);
    timer.unref?.();
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
  const raw = chunks.join("").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    debug("hook input was not JSON; continuing with what is on disk");
    return {};
  }
}

/**
 * First run in a fresh plugin copy: make the plugin self-contained.
 *
 * `claude plugin install` knows nothing about this checkout, so a plugin that
 * only points at the hub's command line would need global setup to work. Vendoring
 * copies core/bin/mcp into the plugin, which the resolver prefers over every other
 * location. It is best-effort and backgrounded: if it fails, the resolver still
 * finds a hub that was set up some other way, and if there is no hub at all the
 * session is told how to install one.
 */
function vendorInBackground() {
  const vendorDir = path.join(PLUGIN_ROOT, "vendor");
  if (fs.existsSync(vendorDir)) return;
  const marker = path.join(PLUGIN_ROOT, VENDOR_MARKER);
  if (fs.existsSync(marker)) return;

  const root = hubRoot(PLUGIN_ROOT);
  if (!root) return; // no checkout to copy from; `sessionhub` on PATH needs no copy

  // The plugin is inside the hub's own checkout: someone is running it in place
  // from the repository. There is nothing to copy, and a copy would shadow the
  // live code, so a plugin installed this way stays pointed at the checkout.
  const inside = path.relative(root, PLUGIN_ROOT);
  if (inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside))) {
    debug("the plugin lives inside the hub checkout; nothing to vendor");
    return;
  }

  try {
    // Written before the spawn, so two sessions starting at once vendor once.
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
  } catch {
    return; // plugin directory is read-only; not our problem to solve
  }

  try {
    const child = spawn(
      process.execPath,
      [path.join(root, "bin", "sessionhub.mjs"), "vendor", "--into", PLUGIN_ROOT],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, SESSION_HUB_ROOT: root },
      },
    );
    child.unref();
    debug(`vendoring the hub from ${root} into ${PLUGIN_ROOT}`);
  } catch (err) {
    debug(`could not start vendoring: ${err.message}`);
  }
}

/**
 * Keep the block inside the hook's 10,000 character limit without losing either
 * end of it: the header names the source and the cost, the last line tells the
 * model what to do with the text. The middle is what gets cut, and the notice
 * says how to read the rest.
 */
function fitToHookLimit(text, uid) {
  if (text.length <= MAX_CONTEXT_CHARS) return text;

  const headEnd = text.indexOf("\n\n");
  const tailStart = text.lastIndexOf("\n\n");
  if (headEnd === -1 || tailStart <= headEnd) return text.slice(0, MAX_CONTEXT_CHARS - 1) + "…";

  const head = text.slice(0, headEnd);
  const body = text.slice(headEnd + 2, tailStart).trim();
  const tail = text.slice(tailStart + 2);
  const notice = [
    "[session-hub] Truncated here to fit Claude Code's hook limit.",
    `The full conversation is ${text.length.toLocaleString()} characters and this context carries ${MAX_CONTEXT_CHARS.toLocaleString()}.`,
    `Read the rest with the session-hub MCP tool "context" (uid: ${uid}) or: sessionhub context ${uid} --chars ${text.length}`,
  ].join("\n");

  const overhead = head.length + notice.length + tail.length + 8; // 4 separator newlines
  const room = MAX_CONTEXT_CHARS - overhead;
  const slice = [...body].slice(0, Math.max(room, 0)).join("");
  // Stop at a line boundary: half a line reads like a bug, a clean stop reads like a budget.
  const cut = slice.slice(0, Math.max(slice.lastIndexOf("\n"), 0)).trimEnd();
  const assembled = [head, cut, notice, tail, ""].join("\n\n");
  return assembled.length <= MAX_CONTEXT_CHARS ? assembled : assembled.slice(0, MAX_CONTEXT_CHARS);
}

/** The one thing worth saying when the hub cannot be found at all. */
function missingHubContext() {
  return [
    "[session-hub] This plugin is enabled, but the session-hub command line was not found,",
    "so it cannot answer anything about sessions in other coding agents.",
    "Tell the user, before you try any session-hub tool or skill:",
    "  sessionhub setup                      # records where the hub lives",
    "  export SESSION_HUB_ROOT=/path/to/session-hub",
    "The path must contain bin/sessionhub.mjs and mcp/server.mjs. Nothing else in this session is affected.",
  ].join("\n");
}

function flushStdout() {
  return new Promise((resolve) => {
    if (process.stdout.writableLength === 0) resolve();
    else process.stdout.once("drain", resolve);
  });
}

async function main() {
  const input = await readHookInput();
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";

  if (event === "SessionStart") vendorInBackground();

  // A hub that cannot be found must not stop the session, but at session start it
  // is worth one sentence, because only the user can install it.
  const peek = await runHubJson(["pending", "--peek"], {
    pluginRoot: PLUGIN_ROOT,
    timeoutMs: PEEK_TIMEOUT_MS,
  });
  if (!peek.ok) {
    debug(`peek failed: ${peek.error}`);
    if (peek.result?.missing && event === "SessionStart") emit(event, missingHubContext());
    return;
  }

  const selection = peek.data?.selection;
  if (!selection || peek.data?.expired) return; // nothing the user is still waiting for

  // Taking it costs one index refresh plus the conversation itself. This is the
  // only path where the hook does real work, and the user asked for exactly this.
  const taken = await runHubJson(["pending"], {
    pluginRoot: PLUGIN_ROOT,
    timeoutMs: TAKE_TIMEOUT_MS,
  });
  // A pick that does not arrive is the one thing worth breaking silence for: the
  // user asked for it, and silence looks like the feature is broken. The notice
  // goes into additionalContext so the model can tell them what to do next.
  if (!taken.ok) {
    debug(`take failed: ${taken.error}`);
    emit(
      event,
      `[session-hub] The conversation you picked could not be loaded, so nothing was imported. ` +
        `${oneLine(taken.error ?? "no reason reported")} ` +
        `Nothing else was read.`,
    );
    return;
  }

  const text = taken.data?.text;
  if (typeof text !== "string" || text.trim() === "") {
    emit(
      event,
      `[session-hub] A session was marked for import (${selection.uid ?? "unknown"}) but the hub had nothing to hand over, ` +
        `most likely because it had already been delivered. Nothing was imported twice.`,
    );
    return;
  }
  emit(event, fitToHookLimit(text, selection.uid ?? ""));
}

try {
  await main();
} catch (err) {
  // Nothing this hook does is worth interrupting a session for.
  debug(`hook failed: ${err?.message ?? err}`);
}
await flushStdout();

try {
  process.stdin.pause();
  process.stdin.unref?.();
} catch {
  /* stdin already gone */
}
process.exit(0);
