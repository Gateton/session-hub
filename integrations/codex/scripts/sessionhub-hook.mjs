#!/usr/bin/env node
/**
 * Codex hook handler: deliver the session the user picked.
 *
 * This runs on `SessionStart` and `UserPromptSubmit`, the two Codex events whose
 * output Codex adds to the model's context. Both are wired to the same script
 * because the delivery is the same, and because the hub consumes a pending
 * selection exactly once: whichever event fires first after the user picks wins,
 * and the other finds nothing.
 *
 * The contract, in order of importance:
 *
 *   - Nothing pending -> no stdout, exit 0. This is the normal case, so it must
 *     cost the user nothing: one short-lived node process and one small file
 *     read, no model-visible text, no measurable delay.
 *   - Something pending -> exactly one JSON object on stdout, in the shape Codex
 *     documents for that event, carrying the hub's ready-to-inject block in
 *     `hookSpecificOutput.additionalContext`.
 *   - Something pending but undeliverable -> say so. Taking the selection is
 *     destructive, so silently dropping it would lose work the user explicitly
 *     asked for. They get a message that tells them how to pick it again.
 *   - Hub missing or payload unreadable -> no stdout, exit 0. A broken hook must
 *     not break the turn. The sole exception is a missing hub at session start,
 *     where saying so once is more useful than 40 minutes of silence.
 *
 * The peek-then-take order is what makes the second and third cases separable.
 * `pending --peek` only reads a file, so it is cheap enough to run on every
 * prompt, and it tells us whether anything is armed before we ask the hub to do
 * the real work of building the context block.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

import { missingHubMessage, runHubJson } from "./resolve.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Codex sets PLUGIN_ROOT for plugin hooks; the alias is kept for compatibility. */
const PLUGIN_ROOT =
  process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || path.dirname(SCRIPT_DIR);

/**
 * Events whose hook output Codex adds to the model's context. Declared in
 * hooks/hooks.json as SessionStart and UserPromptSubmit; the set is a guard, not
 * a wish list, so a user who copies this handler onto another event gets silence
 * rather than a "this event cannot emit additionalContext" warning every turn.
 */
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

/**
 * Budgets. Peeking is a file read; taking builds a transcript, which on a warm
 * index measures around two seconds. The take budget is generous on purpose:
 * overshooting it loses the user's selection, and delivery only happens at all
 * when they explicitly asked for it.
 */
const PEEK_TIMEOUT_MS = 5_000;
const TAKE_TIMEOUT_MS = 18_000;

/** How long we wait for Codex to finish writing the event JSON. */
const STDIN_TIMEOUT_MS = 2_000;

/** An event payload is a small JSON object; anything larger is not one. */
const STDIN_MAX_BYTES = 1_000_000;

/**
 * Read the hook event JSON. Codex closes stdin after writing it, but a hook that
 * waits forever on a stdin that never closes would freeze the turn, so the read
 * is bounded in both bytes and time.
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };

    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length >= STDIN_MAX_BYTES) finish();
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

/** Write the event-shaped JSON Codex reads, and nothing else. */
function emit(event, additionalContext, systemMessage) {
  const payload = { hookSpecificOutput: { hookEventName: event, additionalContext } };
  if (systemMessage) payload.systemMessage = systemMessage;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** A warning with no additional context attached. */
function warn(message) {
  process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

function describe(selection) {
  const where = selection.harness ?? "another agent";
  const title = typeof selection.title === "string" ? selection.title.trim() : "";
  return `${title || selection.uid} (${where})`;
}

async function main() {
  const raw = await readStdin();

  let event = "";
  try {
    event = JSON.parse(raw)?.hook_event_name ?? "";
  } catch {
    // Codex always sends JSON. If this is not JSON, this is not our event.
    return;
  }
  if (!CONTEXT_EVENTS.has(event)) return;

  const options = { pluginRoot: PLUGIN_ROOT };

  const peek = await runHubJson(["pending", "--peek"], { ...options, timeoutMs: PEEK_TIMEOUT_MS });
  if (!peek.ok) {
    // The hub cannot be found or cannot answer. Staying silent forever would
    // hide a broken install, and speaking on every prompt would be noise, so the
    // install hint is delivered once per session, at session start.
    if (event === "SessionStart" && peek.result?.missing) {
      warn(`session-hub hooks are installed but the hub itself is missing. ${oneLine(missingHubMessage())}`);
    }
    return;
  }

  const armed = peek.data?.selection;
  if (!armed) return; // nothing pending, which is the usual case
  if (peek.data?.expired) return; // a stale pick; the hub ignores it too

  const take = await runHubJson(["pending"], { ...options, timeoutMs: TAKE_TIMEOUT_MS });

  if (!take.ok) {
    // The selection has already been consumed by now, so silence here would lose
    // it without a trace.
    warn(
      `session-hub could not load the conversation you picked, ${describe(armed)}. Nothing was imported. ` +
        `Pick it again, or run \`sessionhub pending --peek\` to see what the hub thinks is armed.`,
    );
    return;
  }

  const text = typeof take.data?.text === "string" ? take.data.text : "";
  if (!text) return; // the hub read the selection but had no context to give

  emit(
    event,
    text,
    `session-hub: the conversation you picked, ${describe(take.data.pending ?? armed)}, is in context now. ` +
      `Nothing else was read from the other agent.`,
  );
}

const oneLine = (text) => text.replace(/\n+/g, " ").trim();

// A hook is the last place that should ever raise: any escape here becomes an
// error in the user's turn. Report on stderr (diagnostics, never the payload)
// and leave stdout empty.
main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`session-hub hook failed: ${err?.message ?? err}\n`);
    process.exit(0);
  },
);
