/**
 * session-hub for OpenCode, server side.
 *
 * What this gives an OpenCode user:
 *
 *  1. Tools the model can reach for when the work happened somewhere else.
 *     `sessionhub_find` / `sessionhub_search` look for the conversation,
 *     `sessionhub_load` imports it into this one, `sessionhub_reopen` hands back
 *     the verified command that reopens it in the agent that owns it.
 *  2. `/hub`, `/hub <words>`, `/hub load <uid>`, `/hub pending`, `/hub reopen <uid>`
 *     and `/hub clear`, registered through the `config` hook and filled in by
 *     `command.execute.before`. `/hub load` is the explicit path: it records the
 *     pick with `pick`, so the user sees what is coming and what it costs.
 *  3. Delivery. A pick recorded anywhere (this command, or the full-screen TUI in
 *     `tui.tsx`) is handed to the model exactly once, through `chat.message`.
 *
 * Two runtime facts shape the code:
 *
 *  - OpenCode loads plugins with Bun, and the hub core uses `node:sqlite`, which
 *    only exists in Node. So this plugin never imports `core/*.ts`; `hub.ts`
 *    shells out to the CLI through the resolver the hub ships.
 *  - A plugin loaded by path (not from a node_modules) cannot resolve
 *    `@opencode-ai/plugin` or `zod` at runtime. Everything from that package is
 *    imported as a type only, and the tool definitions are hand-written: the
 *    loader accepts a raw JSON Schema property map in `args` and falls back to
 *    `{type:"object", properties, required}` when the values are not zod types.
 *
 * Nothing here can throw out into the host. A hook that throws would take the
 * user's turn down, and the hub being missing or slow is never worth that.
 */

// Types only: a plugin loaded by path cannot resolve this package at runtime.
import type { Hooks, Plugin as PluginFactory, ToolContext, ToolResult } from "@opencode-ai/plugin"

import {
  clearPending,
  contextFor,
  findSessions,
  formatCost,
  harnessLabel,
  hubFixHint,
  nativeResume,
  oneLine,
  peekPending,
  pendingFileExists,
  pickSession,
  pluginLog,
  relativeTime,
  resolveHubRoot,
  takePending,
} from "./hub"
import type { HarnessId, HubSession } from "./hub"

const DEFAULT_CHARS = 40_000
const MIN_CHARS = 2_000
const MAX_CHARS = 400_000

/** Short name for the trace in the hub home; see `pluginLog` in hub.ts. */
const logLine = pluginLog

/** Args arrive from a model, so nothing is trusted until it is checked. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asChars(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(MAX_CHARS, Math.max(MIN_CHARS, Math.round(n)))
}

function asHarness(value: unknown): HarnessId | undefined {
  const raw = asString(value)
  const known: HarnessId[] = ["claude-code", "codex", "opencode", "crush", "jcode", "pi"]
  return raw && (known as string[]).includes(raw) ? (raw as HarnessId) : undefined
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A session as a line the model can quote back and the user can read. */
function sessionLine(session: HubSession, now = Date.now()): string {
  const when = relativeTime(session.updatedAt ?? session.createdAt, now)
  const where = oneLine(session.repo ?? session.cwd ?? "-", 44)
  const title = oneLine(session.title ?? session.preview ?? "(no title)", 80)
  return `${session.uid}\n    ${harnessLabel(session.harness)} \u00b7 ${when} \u00b7 ${session.messageCount} messages \u00b7 ${where}\n    ${title}`
}

function renderSessions(sessions: HubSession[], heading: string): string {
  if (sessions.length === 0) {
    return [
      `session-hub: ${heading}`,
      "",
      "Nothing matched. Try fewer words, or drop the project filter.",
    ].join("\n")
  }
  const now = Date.now()
  return [
    `session-hub: ${heading}`,
    "",
    sessions.map((session) => sessionLine(session, now)).join("\n\n"),
    "",
    "Load one with `sessionhub_load` (the model does it), or `/hub load <uid>` (you do it).",
  ].join("\n")
}

function hubUnavailable(prefix: string, hint: string): string {
  return [`session-hub: ${prefix}`, "", hint].join("\n")
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Shape of a tool definition this plugin can build. The host's own type wants a
 * zod raw shape in `args`; see the file header for why that is not available and
 * what the loader does instead.
 */
interface HubToolDefinition {
  description: string
  args: Record<string, unknown>
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}

const FIND_DESCRIPTION = [
  "List the coding-agent sessions for this project, across every agent on this machine (Claude Code, Codex, OpenCode, Crush, JCode, Pi).",
  "Reach for this when the user assumes context you do not have: \"what was I doing here yesterday\", \"pick up where we left off\", \"where did I leave the migration\".",
  "Returns uid, harness, age, size and title for each session. Import one with sessionhub_load, or go back to the agent that owns it with sessionhub_reopen.",
  "Takes no arguments: it looks at the project directory of this session. Use sessionhub_search when you need to search other projects or match specific words.",
].join(" ")

const SEARCH_DESCRIPTION = [
  "Search the transcripts and titles of sessions from every coding agent on this machine (Claude Code, Codex, OpenCode, Crush, JCode, Pi).",
  "Use this when the user refers to work done elsewhere and you cannot find it in this project: \"the session where we fixed the parser\", \"continue what I did in Codex\", \"that Claude Code session about auth\".",
  "Returns uid, harness, age, size and title. Import a hit with sessionhub_load, or reopen it in its own agent with sessionhub_reopen. Never invent a uid.",
].join(" ")

const LOAD_DESCRIPTION = [
  "Import a conversation that happened in another coding agent into this one, so the user does not have to re-explain it.",
  "Give it a uid from sessionhub_find or sessionhub_search. The result is the real transcript inside a token budget: recent turns verbatim, older ones condensed, tool output compressed, plus the objective, repo, model, files touched and commands run.",
  "This is the tool for \"continue the work I left in another agent\". Say what you imported and what it cost; do not ask the user to repeat any of it.",
].join(" ")

const REOPEN_DESCRIPTION = [
  "Get the exact, verified command that reopens a session in the agent that owns it, and the directory to run it from.",
  "Use this when the user wants to go back to the original agent rather than import the work here: \"open that in Codex\", \"take me back to my Claude Code session\".",
  "Report the command to the user and stop; do not run it yourself, and do not run an unverified one. The hub returns nothing when it has no verified resume command for that harness, and then the honest answer is to open that agent and pick the session there.",
].join(" ")

function buildTools(): Record<string, HubToolDefinition> {
  const find: HubToolDefinition = {
    description: FIND_DESCRIPTION,
    args: {},
    async execute(_args, context) {
      const result = await findSessions({ dir: context.directory, limit: 15 })
      if (!result.ok) return hubUnavailable("could not list sessions", hubFixHint(result))
      if (result.data.scope === "project" && result.data.sessions.length === 0) {
        return renderSessions([], `no sessions recorded for ${context.directory} in any agent yet`)
      }
      const heading =
        result.data.scope === "project"
          ? `${result.data.sessions.length} session(s) for ${context.directory}, newest first`
          : `no sessions recorded for ${context.directory}; showing the newest ${result.data.sessions.length} across every project`
      return renderSessions(result.data.sessions, heading)
    },
  }

  const search: HubToolDefinition = {
    description: SEARCH_DESCRIPTION,
    args: {
      query: {
        type: "string",
        description:
          "Words to match against session titles and conversation text. Bare terms use prefix matching, \"quoted\" matches a phrase, -term excludes.",
      },
      harness: {
        type: "string",
        description:
          "Restrict to one harness: claude-code, codex, opencode, crush, jcode or pi. Pass anything else to search every harness.",
      },
      limit: { type: "number", description: "Maximum hits to return. Pass 15 unless the user asked for more." },
    },
    async execute(args) {
      const query = asString(args.query)
      if (!query) return "session-hub: sessionhub_search needs a query."
      const limit = Number(args.limit)
      const result = await findSessions({
        query,
        harness: asHarness(args.harness),
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.round(limit)) : 15,
      })
      if (!result.ok) return hubUnavailable("search failed", hubFixHint(result))
      return renderSessions(result.data.sessions, `${result.data.sessions.length} match(es) for "${query}"`)
    },
  }

  const load: HubToolDefinition = {
    description: LOAD_DESCRIPTION,
    args: {
      uid: {
        type: "string",
        description: "Session uid from sessionhub_find or sessionhub_search, for example codex:0191ab... A unique prefix is enough.",
      },
      chars: {
        type: "number",
        description:
          "Character budget for the import, about four characters per token. Pass 40000 unless the user asked for a smaller import.",
        default: DEFAULT_CHARS,
      },
    },
    async execute(args, context) {
      const uid = asString(args.uid)
      if (!uid) return "session-hub: sessionhub_load needs a uid from sessionhub_find."
      const budget = asChars(args.chars) ?? DEFAULT_CHARS
      const result = await contextFor(uid, budget)
      if (!result.ok) {
        return hubUnavailable(`could not import ${uid}`, hubFixHint(result))
      }
      const data = result.data
      const title = data.title ?? uid
      context.metadata({ title: `session-hub: ${oneLine(title, 60)}` })
      return {
        title: `Imported ${harnessLabel(data.harness)}: ${oneLine(title, 60)}`,
        output: [
          `Imported from ${harnessLabel(data.harness)}: ${title}`,
          `uid: ${data.uid}`,
          `source: ${data.source}`,
          `cost: ${formatCost(data.chars, data.estimatedTokens)}`,
          `messages: ${data.includedMessages} of ${data.includedMessages + data.omittedMessages} included, ${data.omittedMessages} omitted`,
          "",
          data.markdown,
        ].join("\n"),
      }
    },
  }

  const reopen: HubToolDefinition = {
    description: REOPEN_DESCRIPTION,
    args: {
      uid: { type: "string", description: "Session uid from sessionhub_find or sessionhub_search." },
    },
    async execute(args) {
      const uid = asString(args.uid)
      if (!uid) return "session-hub: sessionhub_reopen needs a uid from sessionhub_find."
      const result = await nativeResume(uid)
      if (!result.ok) return hubUnavailable(`could not resolve a resume command for ${uid}`, hubFixHint(result))
      const { action } = result.data
      if (!action) {
        return [
          `No verified resume command for ${result.data.uid} (${harnessLabel(result.data.harness)}).`,
          `Open ${harnessLabel(result.data.harness)} and pick the session there. session-hub does not guess command lines.`,
        ].join("\n")
      }
      return [
        `${harnessLabel(result.data.harness)}: ${result.data.uid}`,
        "",
        `  ${action.command} ${action.args.join(" ")}${action.cwd ? `   (cwd: ${action.cwd})` : ""}`,
        "",
        `verification: ${action.verificationBasis} - ${action.verificationNote}`,
        action.verified ? "verified: safe to run in a terminal" : "NOT verified: do not run this",
        "This starts a separate process. The current session is not modified.",
      ].join("\n")
    },
  }

  return { sessionhub_find: find, sessionhub_search: search, sessionhub_load: load, sessionhub_reopen: reopen }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

interface Delivered {
  uid: string
  estimatedTokens: number
  text: string
}

/**
 * Claim the pending selection, if there is one.
 *
 * `pending --take` clears the record as it reads it, which is what makes the
 * import arrive exactly once. The cheap file check in front of it keeps the
 * common case (nothing pending) from spawning Node on every message.
 */
async function claimPending(reason: string): Promise<Delivered | null> {
  if (!pendingFileExists()) return null
  const outcome = await takePending()
  if (!outcome.ok) {
    logLine(`${reason}: could not read the pending selection: ${outcome.message}`)
    return null
  }
  if (!outcome.data) return null
  return {
    uid: outcome.data.pending?.uid ?? "unknown",
    estimatedTokens: outcome.data.estimatedTokens,
    text: outcome.data.text,
  }
}

/** True when the prompt already carries this session, so it is not imported twice. */
function alreadyPresent(messages: { parts: { type: string; text?: string }[] }[], uid: string): boolean {
  const marker = `Source: ${uid}`
  return messages.some((message) =>
    message.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes(marker)),
  )
}

/** The last text part of a message, which is where an import is attached. */
function lastTextPart(parts: { type: string; text?: string }[]): { type: string; text?: string } | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === "text" && typeof parts[i].text === "string") return parts[i]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The /hub command
// ---------------------------------------------------------------------------

/**
 * What the command falls back to if the hook below ever fails to run: the model
 * still gets told what the user wanted and which tool answers it.
 */
const HUB_COMMAND_TEMPLATE = [
  "The user ran the session-hub /hub command.",
  "Look for work done in another coding agent with the sessionhub_find tool, then act on: $ARGUMENTS",
].join("\n")

const HUB_COMMAND_HELP = [
  "session-hub",
  "",
  "  /hub                 sessions for this project, across every agent",
  "  /hub <words>         search every transcript",
  "  /hub load <uid>      bring one in with this message (shows the cost first)",
  "  /hub pending         what is waiting to be imported",
  "  /hub clear           cancel a pending selection",
  "  /hub reopen <uid>    the verified command that reopens it in its own agent",
  "",
  "Or press the session-hub keybind (ctrl+shift+h) for the full-screen browser.",
].join("\n")

/**
 * Build the replacement message for `/hub ...`.
 *
 * The parts of the command message are replaced in place, because the host
 * captures the array before it fires `command.execute.before` and reads the same
 * array afterwards: reassigning `output.parts` would be silently dropped.
 */
async function runHubCommand(raw: string, directory: string): Promise<string> {
  const args = raw.trim()
  if (!args || args === "list" || args === "help" || args === "?") {
    const result = await findSessions({ dir: directory, limit: 20 })
    if (!result.ok) return hubUnavailable("could not list sessions", hubFixHint(result))
    if (result.data.sessions.length === 0) {
      return [
        `session-hub: no sessions recorded for ${directory} in any agent yet.`,
        "",
        "Indexing happens on first use; if you expected something here, run `sessionhub doctor`.",
        "",
        HUB_COMMAND_HELP,
      ].join("\n")
    }
    return [
      renderSessions(
        result.data.sessions,
        `${result.data.sessions.length} session(s) for ${directory}, newest first`,
      ),
      "",
      HUB_COMMAND_HELP,
    ].join("\n")
  }

  const [head, ...rest] = args.split(/\s+/)
  const tail = rest.join(" ").trim()

  switch (head) {
    case "load":
    case "pick": {
      if (!tail) return "session-hub: usage: /hub load <uid>"
      return await hubLoad(tail)
    }
    case "reopen":
    case "native": {
      if (!tail) return "session-hub: usage: /hub reopen <uid>"
      const result = await nativeResume(tail)
      if (!result.ok) return hubUnavailable(`could not resolve a resume command for ${tail}`, hubFixHint(result))
      const { action } = result.data
      if (!action) {
        return [
          `No verified resume command for ${result.data.uid} (${harnessLabel(result.data.harness)}).`,
          `Open ${harnessLabel(result.data.harness)} and pick the session there.`,
        ].join("\n")
      }
      return [
        `session-hub: ${harnessLabel(result.data.harness)} - ${result.data.uid}`,
        "",
        `  ${action.command} ${action.args.join(" ")}${action.cwd ? `   (cwd: ${action.cwd})` : ""}`,
        "",
        `verification: ${action.verificationBasis} - ${action.verificationNote}`,
        action.verified ? "verified: safe to run in a terminal" : "NOT verified: do not run this",
      ].join("\n")
    }
    case "pending": {
      const result = await peekPending()
      if (!result.ok) return hubUnavailable("could not read the pending selection", hubFixHint(result))
      if (!result.data) {
        return ["session-hub: nothing is pending.", "", "Pick one with /hub load <uid>."].join("\n")
      }
      const { selection, expired } = result.data
      return [
        `session-hub: waiting to be imported${expired ? " (expired, it will not be sent)" : ""}`,
        "",
        `  ${selection.uid}`,
        `  ${harnessLabel(selection.harness)} \u00b7 ${formatCost(selection.chars, Math.round(selection.chars / 4))} \u00b7 ${oneLine(selection.title ?? "(no title)", 70)}`,
        selection.note ? `  why: ${selection.note}` : "",
        "",
        expired
          ? "Selections go stale after two hours. Pick it again with /hub load <uid>."
          : "It arrives with your next message. Cancel with /hub clear.",
      ]
        .filter((line) => line !== "")
        .join("\n")
    }
    case "clear": {
      const result = await clearPending()
      if (!result.ok) return hubUnavailable("could not clear the pending selection", hubFixHint(result))
      return result.data.cleared ? "session-hub: pending selection cleared." : "session-hub: nothing was pending."
    }
    default: {
      const result = await findSessions({ query: args, limit: 20 })
      if (!result.ok) return hubUnavailable("search failed", hubFixHint(result))
      return [
        renderSessions(result.data.sessions, `${result.data.sessions.length} match(es) for "${args}"`),
        "",
        HUB_COMMAND_HELP,
      ].join("\n")
    }
  }
}

/** `/hub load <uid>`: record the pick, then say exactly what is about to arrive. */
async function hubLoad(uid: string): Promise<string> {
  const result = await pickSession(uid, { note: "picked from the /hub command" })
  if (!result.ok) return hubUnavailable(`could not select "${uid}"`, hubFixHint(result))
  const pick = result.data
  logLine(`/hub load picked ${pick.uid} (${pick.chars} chars)`)
  return [
    `session-hub: selected ${pick.title ?? pick.uid}`,
    "",
    `  from: ${harnessLabel(pick.harness)}`,
    `  budget: ${formatCost(pick.chars, Math.round(pick.chars / 4))}`,
    "",
    "The transcript is attached to this message, straight off disk. session-hub sent nothing to any model.",
    "Cancel a pending selection with /hub clear.",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export const Plugin: PluginFactory = async (input) => {
  const directory = input.directory
  const tools = buildTools()

  logLine(
    [
      "plugin loaded",
      `runtime: ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`}`,
      `execPath: ${process.execPath}`,
      `hub: ${resolveHubRoot() ?? "NOT FOUND"}`,
      `project: ${directory}`,
    ].join(" \u00b7 "),
  )

  const hooks: Hooks = {
    /**
     * `/hub` is a real command in the palette, with a template that stands on its
     * own if the hook below never runs. An existing `hub` command wins: the user's
     * config is not ours to overwrite.
     */
    config: async (config) => {
      config.command = config.command ?? {}
      if (!config.command.hub) {
        config.command.hub = {
          description: "session-hub: find work in your other coding agents and import it",
          template: HUB_COMMAND_TEMPLATE,
        }
        logLine("registered the /hub command")
      }
    },

    /** Fill in what `/hub ...` actually prints. */
    "command.execute.before": async (command, output) => {
      if (command.command !== "hub") return
      let replacement: string
      try {
        replacement = await runHubCommand(command.arguments, directory)
      } catch (err) {
        logLine(`/hub failed: ${err instanceof Error ? err.message : String(err)}`)
        replacement = hubUnavailable(
          "the /hub command failed",
          "Run `sessionhub doctor` in a terminal to see what the hub can see.",
        )
      }
      // Mutate in place: the host keeps its own reference to this array.
      output.parts.length = 0
      output.parts.push({
        type: "text",
        text: replacement,
        synthetic: true,
      } as unknown as (typeof output.parts)[number])
    },

    /**
     * Delivery, and the reason it lives here rather than in a transform hook: the
     * parts of a new user message are what gets written to the session store, so
     * an import attached here is still in front of the model on every later step
     * of the turn, and it is visible in the transcript.
     */
    "chat.message": async (message, output) => {
      const parts = output.parts as { type: string; text?: string }[] | undefined
      if (!Array.isArray(parts) || parts.length === 0) {
        // Nothing to attach to. Leave the selection pending rather than losing it.
        logLine("chat.message: message had no parts, pending selection left alone")
        return
      }
      const delivered = await claimPending("chat.message")
      if (!delivered) return
      const target = lastTextPart(parts)
      if (!target) {
        logLine("chat.message: no text part to attach the import to")
        return
      }
      target.text = `${target.text ?? ""}\n\n${delivered.text}`
      logLine(
        `delivered ${delivered.uid} into ${message.sessionID} (~${delivered.estimatedTokens} tokens)`,
      )
    },

    /**
     * Backstop for the same delivery.
     *
     * `chat.message` is the path that persists; this one only fires if that hook
     * was never called, and it refuses to inject a session that is already in the
     * prompt, so the import can never arrive twice.
     */
    "experimental.chat.messages.transform": async (_transformInput, output) => {
      if (!pendingFileExists()) return
      const messages = output.messages as
        | { info: { role?: string }; parts: { type: string; text?: string }[] }[]
        | undefined
      if (!Array.isArray(messages) || messages.length === 0) return

      let lastUser: (typeof messages)[number] | undefined
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.info?.role === "user") {
          lastUser = messages[i]
          break
        }
      }
      if (!lastUser) return

      const peek = await peekPending()
      if (!peek.ok || !peek.data || peek.data.expired) return
      const uid = peek.data.selection.uid
      if (alreadyPresent(messages, uid)) {
        logLine(`transform: ${uid} is already in the prompt, not injecting again`)
        return
      }
      const target = lastTextPart(lastUser.parts)
      if (!target) return

      const delivered = await claimPending("transform")
      if (!delivered) return
      target.text = `${target.text ?? ""}\n\n${delivered.text}`
      logLine(`transform: injected ${delivered.uid} (~${delivered.estimatedTokens} tokens)`)
    },

    /** A breadcrumb next to our own log if the session itself goes wrong. */
    event: async ({ event }) => {
      if (event.type === "session.error" || event.type === "session.compacted") {
        logLine(`event: ${event.type}`)
      }
    },

    // The host types `args` as a zod raw shape; see HubToolDefinition above.
    tool: tools as unknown as Hooks["tool"],
  }

  return hooks
}

export default { id: "session-hub", server: Plugin }
