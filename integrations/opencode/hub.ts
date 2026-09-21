/**
 * The one place that talks to the session-hub command line.
 *
 * OpenCode loads plugins with Bun. The hub core opens its index with
 * `node:sqlite`, which only exists in Node. So this integration never imports
 * `core/*.ts`: it shells out to `bin/sessionhub.mjs` through the resolver the
 * hub already ships (`scripts/resolve.mjs`), which knows where the hub lives on
 * this machine and reports honestly when it cannot find it.
 *
 * Every call returns a discriminated `HubOutcome` instead of throwing. The TUI
 * must never take the session down because the hub is missing, and a hook that
 * throws would do exactly that.
 *
 * stdout of the CLI is pure payload and stderr is diagnostics, so `runHubJson`
 * gives us parsed data or the hub's own error text, never a mix.
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { hubRoot, missingHubMessage } from "./scripts/resolve.mjs"

/** Name of the trace both halves of this integration append to. */
export const PLUGIN_LOG_FILE = "opencode-plugin-loaded.log"

const MAX_LOG_BYTES = 64 * 1024

/**
 * Directory this integration was loaded from. Passed to the resolver so a
 * self-contained copy (`sessionhub vendor --into integrations/opencode`) wins
 * over the install record.
 */
export const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))

/** Harness ids the hub understands. Kept in sync with `core/types.ts`. */
export type HarnessId = "claude-code" | "codex" | "opencode" | "crush" | "jcode" | "pi"

export const HARNESS_LABEL: Record<HarnessId, string> = {
  pi: "Pi",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  crush: "Crush",
  jcode: "JCode",
}

export function harnessLabel(harness: string): string {
  return HARNESS_LABEL[harness as HarnessId] ?? harness
}

/** One session as the hub reports it. Extra fields exist; these are the contract. */
export interface HubSession {
  uid: string
  harness: HarnessId
  nativeId: string
  path: string
  title: string | null
  createdAt: string | null
  updatedAt: string | null
  cwd: string | null
  repo: string | null
  model: string | null
  messageCount: number
  toolCount: number
  preview: string | null
}

export interface HubMessage {
  role: string
  text: string
}

export interface HubTranscript extends HubSession {
  messages: HubMessage[]
}

/** `context --json`, minus the markdown-heavy fields callers usually ignore. */
export interface HubContext {
  uid: string
  harness: HarnessId
  title: string | null
  source: string
  chars: number
  estimatedTokens: number
  includedMessages: number
  omittedMessages: number
  markdown: string
}

/** What `pick` recorded. */
export interface HubPick {
  uid: string
  harness: HarnessId
  title: string | null
  chars: number
  createdAt: string
  note?: string
}

/** What `pending --peek` reports. */
export interface HubPeek {
  selection: HubPick
  expired: boolean
}

/** What `pending --take` hands to a hook: the block that goes into the prompt. */
export interface HubPendingBlock {
  uid: string
  harness: HarnessId
  title: string | null
  chars: number
  estimatedTokens: number
  text: string
}

export interface HubNativeAction {
  command: string
  args: string[]
  description: string
  cwd?: string
  verified: boolean
  verificationBasis: string
  verificationNote: string
  requiresConfirmation?: boolean
}

export interface HubNative {
  uid: string
  harness: HarnessId
  action: HubNativeAction | null
}

export interface HubDetection {
  harness: HarnessId
  status: string
  root: string
  sessionCount: number
  detail?: string
}

export interface HubDoctor {
  home: string
  detections: HubDetection[]
  indexed?: Record<string, number>
}

/**
 * Every hub call lands on one of these. `missing` is not an error: it means the
 * CLI itself could not be located, and the fix is a setup step rather than a
 * retry.
 */
export type HubOutcome<Data> =
  | { ok: true; data: Data }
  | { ok: false; missing: boolean; message: string }

function failure(message: string, missing: boolean): { ok: false; missing: boolean; message: string } {
  return { ok: false, missing, message }
}

/** Where the hub CLI lives, or null. Cheap enough to call before every command. */
export function resolveHubRoot(): string | null {
  try {
    return hubRoot(PLUGIN_ROOT)
  } catch {
    return null
  }
}

/**
 * What the user should do about a failure. A missing CLI gets the setup steps;
 * anything else is the hub's own message, which is already actionable.
 */
export function hubFixHint(outcome: { missing: boolean; message: string }): string {
  if (!outcome.missing) return outcome.message
  return [
    "session-hub could not be found on this machine.",
    "",
    "Install it, then run:",
    "  sessionhub setup                       # records where the hub lives",
    "or point this plugin straight at a checkout:",
    "  export SESSION_HUB_ROOT=/path/to/session-hub",
    "",
    missingHubMessage(),
  ].join("\n")
}

const DEFAULT_TIMEOUT_MS = 60_000

interface RunResult {
  code: number
  stdout: string
  stderr: string
  missing?: boolean
}

/**
 * Which interpreter runs the hub CLI.
 *
 * The hub needs Node: its index is opened with `node:sqlite`, and Bun's shim for
 * that module is not complete, so running the CLI on Bun fails with "cannot open
 * the hub index" (verified against Bun 1.3).
 *
 * Under Node, `process.execPath` is already the right answer. Under Bun it is
 * the OpenCode binary, which is why `runHub` from `scripts/resolve.mjs` cannot
 * be used as-is here: it would run `opencode bin/sessionhub.mjs ...` and get
 * OpenCode's own usage text back as the "hub error". The bare name `node` is
 * used instead and left to the OS to find on PATH.
 */
function nodeCommand(): string {
  const fromEnv = process.env.SESSION_HUB_NODE?.trim()
  if (fromEnv) return fromEnv
  if (!process.versions.bun) return process.execPath
  return "node"
}

const NO_NODE_HINT = [
  "session-hub found its command line but no Node to run it with.",
  "",
  "The hub's index needs Node 22.5 or newer. Fix it with either:",
  "  put node on PATH",
  "  export SESSION_HUB_NODE=/path/to/node",
].join("\n")

/**
 * Spawn the hub CLI and collect stdout/stderr. Never throws on a non-zero exit:
 * the hub's own error text is what the user needs to see.
 *
 * Where the hub lives is decided by `hubRoot` in `scripts/resolve.mjs`, the
 * shared resolver, exactly as the other harness integrations do it.
 */
async function spawnHub(args: string[], timeoutMs: number): Promise<RunResult> {
  let root: string | null = null
  try {
    root = hubRoot(PLUGIN_ROOT)
  } catch {
    root = null
  }

  const command = root ? nodeCommand() : "sessionhub"
  const argv = root ? [path.join(root, "bin", "sessionhub.mjs"), ...args] : args

  return await new Promise<RunResult>((resolve) => {
    let child
    try {
      child = spawn(command, argv, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SESSION_HUB_ROOT: root ?? process.env.SESSION_HUB_ROOT ?? "" },
      })
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err), missing: !root })
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      finish({ code: 124, stdout, stderr: `${stderr}sessionhub timed out after ${timeoutMs}ms\n` })
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()))
    child.stderr?.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()))
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" && root) {
        finish({ code: 127, stdout, stderr: NO_NODE_HINT, missing: false })
        return
      }
      finish({ code: 127, stdout, stderr: `${stderr}${err.message}\n`, missing: !root })
    })
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }))
  })
}

/** Run the hub CLI with `--json` and parse the payload. */
async function call<Data>(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HubOutcome<Data>> {
  let result: RunResult
  try {
    result = await spawnHub([...args, "--json"], timeoutMs)
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err), false)
  }
  if (result.code !== 0) {
    return failure(result.stderr.trim() || result.stdout.trim() || "session-hub exited without a message", Boolean(result.missing))
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as Data }
  } catch (err) {
    return failure(`could not parse hub output: ${err instanceof Error ? err.message : String(err)}`, false)
  }
}

/**
 * The hub's own state directory: `$SESSION_HUB_HOME`, or `~/.session-hub`.
 * Mirrors `hubHome()` in `core/hub.ts`, which is where the index and the pending
 * record live.
 */
export function hubHomeDir(): string {
  const fromEnv = process.env.SESSION_HUB_HOME?.trim()
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".session-hub")
}

/**
 * Fast path for the delivery hook.
 *
 * The hook runs on every message, and spawning Node on every message just to
 * learn that nothing is pending is a tax on the user's typing. If the pending
 * file is not there, nothing can be pending; when it is there the CLI stays the
 * source of truth, including the staleness rule.
 */
export function pendingFilePath(): string {
  return path.join(hubHomeDir(), "pending.json")
}

export function pendingFileExists(): boolean {
  try {
    return fs.existsSync(pendingFilePath())
  } catch {
    return false
  }
}

/**
 * Append one line to the integration's trace in the hub home.
 *
 * Both halves of the OpenCode integration do their real work in a child
 * process, so without this file "did my pick arrive?" has no answer. The hub
 * writes nothing outside its home and neither does this; the file is capped so
 * it cannot grow without bound, and a failure to write it is ignored, because a
 * diagnostic must never break a turn.
 */
export function pluginLog(message: string): void {
  try {
    const file = path.join(hubHomeDir(), PLUGIN_LOG_FILE)
    let existing = ""
    try {
      existing = fs.readFileSync(file, "utf8")
    } catch {
      /* first write */
    }
    if (existing.length > MAX_LOG_BYTES) existing = ""
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${existing}${new Date().toISOString()} ${message}\n`, "utf8")
  } catch {
    /* never break a turn over a log line */
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface FindOptions {
  /** Words to match against titles and transcripts. */
  query?: string
  /** Project directory: only sessions from that project. */
  dir?: string
  harness?: HarnessId
  limit?: number
  /**
   * Where to look. `auto` (the default) searches everywhere when a query is
   * given, this project when a directory is given, and everywhere otherwise.
   */
  scope?: "auto" | "project" | "all"
}

export interface FindResult {
  sessions: HubSession[]
  /** Which question was actually answered, so callers can say so honestly. */
  scope: "project" | "all"
}

/** `search`, `here` or `list` depending on what was asked for. */
export async function findSessions(options: FindOptions = {}): Promise<HubOutcome<FindResult>> {
  const limit = options.limit ?? 15
  const harness = options.harness ? ["--harness", options.harness] : []

  const query = options.query?.trim()
  if (query) {
    const hits = await call<HubSession[]>(["search", query, ...harness, "--limit", String(limit)])
    if (!hits.ok) return hits
    return { ok: true, data: { sessions: hits.data ?? [], scope: "all" } }
  }

  if (options.dir && options.scope !== "all") {
    const here = await call<{ dir: string; sessions: HubSession[] }>([
      "here",
      "--dir",
      options.dir,
      ...harness,
      "--limit",
      String(limit),
    ])
    if (!here.ok) return here
    const sessions = here.data.sessions ?? []
    // An empty project answer is not a useful answer: fall back to the newest
    // sessions everywhere, and let the caller label it as the fallback it is.
    if (sessions.length > 0 || options.scope === "project") {
      return { ok: true, data: { sessions, scope: "project" } }
    }
    const all = await call<HubSession[]>(["list", ...harness, "--limit", String(limit)])
    if (!all.ok) return all
    return { ok: true, data: { sessions: all.data ?? [], scope: "all" } }
  }

  const all = await call<HubSession[]>(["list", ...harness, "--limit", String(limit)])
  if (!all.ok) return all
  return { ok: true, data: { sessions: all.data ?? [], scope: "all" } }
}

/** The free preview: the transcript, read straight off disk, no model involved. */
export async function previewSession(uid: string, limit = 60): Promise<HubOutcome<HubTranscript>> {
  return call<HubTranscript>(["show", uid, "--limit", String(limit)])
}

/** The budgeted context package, and what it costs. */
export async function contextFor(uid: string, chars?: number): Promise<HubOutcome<HubContext>> {
  const budget = chars ? ["--chars", String(chars)] : []
  return call<HubContext>(["context", uid, ...budget])
}

/** The verified resume command for the harness that owns the session. */
export async function nativeResume(uid: string): Promise<HubOutcome<HubNative>> {
  return call<HubNative>(["native", uid])
}

export async function doctor(): Promise<HubOutcome<HubDoctor>> {
  return call<HubDoctor>(["doctor"])
}

export async function reindex(): Promise<HubOutcome<{ total: number }>> {
  return call<{ total: number }>(["index"], 180_000)
}

// ---------------------------------------------------------------------------
// The pending selection
// ---------------------------------------------------------------------------

/** Record the user's explicit choice. Nothing is sent; it arrives with the next message. */
export async function pickSession(
  uid: string,
  options: { chars?: number; note?: string } = {},
): Promise<HubOutcome<HubPick>> {
  const chars = options.chars ? ["--chars", String(options.chars)] : []
  const note = options.note ? ["--note", options.note] : []
  return call<HubPick>(["pick", uid, ...chars, ...note])
}

/** Read the pending selection without consuming it. */
export async function peekPending(): Promise<HubOutcome<HubPeek | null>> {
  const result = await call<HubPeek | { pending: null }>(["pending", "--peek"])
  if (!result.ok) return result
  const data = result.data as HubPeek | { pending: null }
  return { ok: true, data: "selection" in data ? data : null }
}

/**
 * Consume the pending selection and get the block a hook should inject.
 * The CLI clears the record, so this can only succeed once per pick.
 */
export async function takePending(): Promise<HubOutcome<HubPendingBlock | null>> {
  const result = await call<HubPendingBlock | { pending: null }>(["pending", "--take"])
  if (!result.ok) return result
  const data = result.data as HubPendingBlock | { pending: null }
  return { ok: true, data: "text" in data ? data : null }
}

export async function clearPending(): Promise<HubOutcome<{ cleared: boolean }>> {
  return call<{ cleared: boolean }>(["pending", "--clear"])
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function oneLine(text: string | null | undefined, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  if (!flat) return ""
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}\u2026`
}

/** "3m ago", "5h ago", "2d ago", or the date when it is older than a month. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "unknown"
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return "unknown"
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 31) return `${days}d ago`
  return iso.slice(0, 10)
}

/** One session, one line, uid first so it can be copied into another command. */
export function formatSessionRow(session: HubSession, now = Date.now()): string {
  const when = relativeTime(session.updatedAt ?? session.createdAt, now)
  const where = oneLine(session.repo ?? session.cwd ?? "-", 38)
  const title = oneLine(session.title ?? session.preview ?? "(no title)", 72)
  return `${session.uid}  [${harnessLabel(session.harness)}]  ${when}  ${where}  ${title}`
}

export function formatSessionList(sessions: HubSession[], now = Date.now()): string {
  if (sessions.length === 0) return "No sessions matched."
  return sessions.map((session) => formatSessionRow(session, now)).join("\n")
}

/** The cost line the user sees before anything is imported. */
export function formatCost(chars: number, estimatedTokens: number): string {
  return `~${estimatedTokens.toLocaleString()} tokens (${chars.toLocaleString()} characters)`
}
