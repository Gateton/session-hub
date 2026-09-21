/** @jsxImportSource @opentui/solid */
/**
 * session-hub for OpenCode, TUI side: the full-screen browser for the sessions
 * sitting in your other coding agents.
 *
 * What it registers:
 *  - a route named `hub`, reachable with the keybind below (default
 *    `ctrl+shift+h`, override with `SESSION_HUB_KEYBIND`) and from the command
 *    palette as "session-hub: browse sessions from your other agents",
 *  - a global keymap layer for opening the browser and for "what is pending",
 *  - a route-scoped keymap layer, so up/down/enter/1-6 keep their normal meaning
 *    everywhere outside the browser.
 *
 * Shape of the screen (the layout follows the terminal it is given):
 *
 *    session-hub                     12 of 50 shown · 6 projects
 *    this project, newest first
 *    filter: migr▏  3 match(es) · enter keeps it, esc clears
 *    1 π  2 ✻  3 ⬡  4 ⌘  5 ❯  6 ◆  0 all (showing)
 *    ┌ sessions ──────────────────────┬──────────────── preview ───────────────┐
 *    │ ▸✻ Claude Code  2m ago  449 msg │ ✻ Claude Code · claude-sonnet-4 · 449 m │
 *    │   the parser fix                │ claude-code:7f2c… · /home/gateton · 2m a │
 *    │  ⌘ OpenCode …                   │ importing 19/77 · ~1,560 tokens …       │
 *    └─────────────────────────────────┴────────────────────────────────────────┘
 *    ↑↓ move · tab preview · enter import · / search · 1-6 harness · r reload
 *    open again: ctrl+shift+h · alt+h · ctrl+p → session-hub
 *
 * Two panes above 90 columns, one pane below it (see `WIDE_MIN_COLUMNS`), and
 * every line is measured before it is drawn, so 80x24 is a supported size and
 * not an accident. The keys and the colour table are documented in README.md.
 *
 * Loading rules this file obeys, because getting them wrong breaks the TUI:
 *  - no runtime import from `@opencode-ai/plugin` (type-only). OpenCode rewrites
 *    `solid-js` and `@opentui/solid` for TUI plugins, and nothing else; node
 *    builtins and relative files are the only other things imported here.
 *  - the list loads lazily, the first time the browser is opened. The hub's first
 *    index pass over 400+ sessions is seconds of work and must not happen at
 *    startup for someone who never opens the browser.
 *  - every hub call can fail. A failure renders as an error state with the fix,
 *    never as a thrown error: the TUI must not take the session down. The view
 *    also sits inside an ErrorBoundary for the same reason.
 *  - the preview costs nothing. It is the head of the package the hub would
 *    import, read off disk by the CLI; no model is involved on that path.
 */

import { ErrorBoundary, For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid"

import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

import fs from "node:fs"
import path from "node:path"

import {
  contextFor,
  findSessions,
  formatCost,
  harnessLabel,
  hubFixHint,
  hubHomeDir,
  oneLine,
  peekPending,
  pickSession,
  pluginLog,
  relativeTime,
} from "./hub"
import type { HarnessId, HubSession } from "./hub"

const id = "session-hub"
const HUB_ROUTE = "hub"

/** Character budget for the import. The same value the tools in plugin.ts use. */
const BUDGET = 40_000

/** How many sessions the browser asks for, and how many a transcript search returns. */
const LIST_LIMIT = 50
const SEARCH_LIMIT = 40

/**
 * The filter box matches the rows already loaded, which makes it instant and free
 * but shallow: the hub's own search reads every transcript on disk. When the local
 * filter finds nothing and the words are long enough to be worth a Node process,
 * the browser asks the hub as well, hence the debounce and the minimum length.
 */
const SEARCH_DEBOUNCE_MS = 450
const MIN_SERVER_QUERY = 3

/**
 * Below this, two panes cannot both stay readable: a row needs about 46 columns to
 * show marker, harness, age, size and project, and the preview wants about the
 * same. Under 90 columns the preview moves underneath the list instead.
 */
const WIDE_MIN_COLUMNS = 90

const DEFAULT_KEYBIND = "ctrl+shift+h"

/** Column widths the rows align on. */
const LABEL_WIDTH = 11
const TIME_WIDTH = 9
const COUNT_WIDTH = 8

/** How many transcript lines one pageup/pagedown moves the preview. */
const PREVIEW_PAGE = 8

/** Theme tokens a harness may wear. Every one of them is an RGBA in the theme. */
type ColorToken = "primary" | "secondary" | "accent" | "success" | "warning" | "info"

interface HarnessStyle {
  id: HarnessId
  label: string
  /** One glyph per harness, so a row is identifiable before its label is read. */
  glyph: string
  /** Stand-in for terminals without the glyph; see `asciiOnly`. */
  ascii: string
  token: ColorToken
  /** Harness filter key. Fixed order, so `1` is always Pi. */
  key: string
}

/**
 * The whole per-harness identity in one table: glyph, ASCII stand-in, colour and
 * filter key. Nothing about harness identity lives anywhere else, so the rows, the
 * legend, the preview header and the keymap all agree by construction.
 *
 * Why these six tokens, and why six different ones: a two-line row has room for
 * one colour, and the colour has to say *which agent* before the label is read.
 * Six harnesses in six shades of one hue would not say that, so each takes a
 * different hue from the theme's fixed set:
 *
 *   π  pi          success    the harness this hub ships with; green for "yours"
 *   ✻  claude-code warning    Anthropic's own amber, the colour Claude Code wears
 *   ⬡  codex       info       cool blue: Codex's own chrome, and its calm register
 *   ⌘  opencode    accent     you are *inside* OpenCode; accent is the host's "the
 *                             thing you are looking at right now" token
 *   ❯  crush       secondary  the contrasting hue in this theme, Crush's family
 *   ◆  jcode       primary    the theme's headline colour, for the other
 *                             terminal-first agent in the list
 *
 * The state tokens are deliberately *not* used here: `error`, `text`, `textMuted`
 * and the three border tokens stay reserved for state and chrome, so a red line in
 * this browser always means a failure and never "that one is Crush".
 */
const HARNESS: HarnessStyle[] = [
  { id: "pi", label: "Pi", glyph: "\u03c0", ascii: "P", token: "success", key: "1" },
  { id: "claude-code", label: "Claude Code", glyph: "\u273b", ascii: "C", token: "warning", key: "2" },
  { id: "codex", label: "Codex", glyph: "\u2b21", ascii: "X", token: "info", key: "3" },
  { id: "opencode", label: "OpenCode", glyph: "\u2318", ascii: "O", token: "accent", key: "4" },
  { id: "crush", label: "Crush", glyph: "\u276f", ascii: "R", token: "secondary", key: "5" },
  { id: "jcode", label: "JCode", glyph: "\u25c6", ascii: "J", token: "primary", key: "6" },
]

function styleFor(harness: string | null | undefined): HarnessStyle | undefined {
  return HARNESS.find((entry) => entry.id === harness)
}

/** Marker for one harness: its glyph, or its letter when the terminal cannot draw it. */
function marker(style: HarnessStyle | undefined, ascii = asciiOnly()): string {
  if (!style) return "\u00b7"
  return ascii ? style.ascii : style.glyph
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}

/**
 * `SESSION_HUB_ASCII=1` (or the older `PI_SESSION_HUB_ASCII=1`) swaps every glyph
 * for a plain letter, for terminals without symbol coverage. Read per call: it
 * costs nothing, and a long-lived TUI process cannot end up with a stale answer.
 */
function asciiOnly(): boolean {
  return envFlag("SESSION_HUB_ASCII") || envFlag("PI_SESSION_HUB_ASCII")
}

/**
 * The key that opens the browser. `alt+h` is registered next to it unconditionally,
 * because a terminal that cannot report `shift` delivers `ctrl+shift+h` as a plain
 * `ctrl+h`, which OpenCode does not bind.
 */
function openKeybind(): string {
  const fromEnv = process.env.SESSION_HUB_KEYBIND?.trim()
  return fromEnv || DEFAULT_KEYBIND
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

interface Preview {
  chars: number
  estimatedTokens: number
  included: number
  omitted: number
  markdown: string
}

/** Split a multi-line text into lines, because a `text` element holds one line. */
function lines(text: string, max: number): string[] {
  const all = text.split("\n")
  if (all.length <= max) return all
  return [...all.slice(0, Math.max(1, max - 1)), `\u2026 ${all.length - max + 1} more line(s)`]
}

type SegColor = "harness" | "text" | "muted" | "off" | "accent" | "warning"

/** One coloured piece of a line. `harness` resolves through the table above. */
interface Seg {
  text: string
  color: SegColor
  harness?: HarnessId
}

/**
 * Clamp a line to the space it has. Wrapping would break the "two lines per
 * session" arithmetic the viewport depends on, so the last piece is truncated
 * instead of allowed to overflow.
 */
function fit(segments: Seg[], max: number): Seg[] {
  const out: Seg[] = []
  let left = max
  for (const segment of segments) {
    if (left <= 0) break
    if (segment.text.length <= left) {
      out.push(segment)
      left -= segment.text.length
      continue
    }
    out.push({ ...segment, text: `${segment.text.slice(0, Math.max(0, left - 1))}\u2026` })
    left = 0
  }
  return out
}

function segWidth(segments: Seg[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0)
}

/** Resolve a piece to a colour for the current theme and row state. */
function colorFor(theme: TuiThemeCurrent, segment: Seg, selected: boolean) {
  if (segment.color === "harness") {
    const style = styleFor(segment.harness)
    return style ? theme[style.token] : theme.textMuted
  }
  if (segment.color === "accent") return theme.accent
  if (segment.color === "warning") return theme.warning
  if (segment.color === "text") return selected ? theme.selectedListItemText : theme.text
  return selected ? theme.selectedListItemText : theme.textMuted
}

/**
 * Does this session match the typed words? Local, and only over the loaded rows: a
 * transcript is not read to answer a keystroke. `/hub <words>` is the path that
 * searches full transcript text, server-side.
 */
function matchesText(session: HubSession, needle: string): boolean {
  const haystack = [
    session.title,
    session.preview,
    session.repo,
    session.cwd,
    session.model,
    harnessLabel(session.harness),
    session.uid,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase()
  return haystack.includes(needle)
}

/**
 * Line one of a row: marker, harness, age, message count, project. The pieces
 * carry their own colour, so the harness keeps its hue and the metadata stays
 * muted; `fit` is the only thing that decides how much project survives.
 */
function mainSegments(session: HubSession, width: number, now: number): Seg[] {
  const style = styleFor(session.harness)
  const parts: Seg[] = []
  if (style) {
    parts.push({ text: `${marker(style)} `, color: "harness", harness: style.id })
    // The long label is the first thing to go when the pane narrows: the glyph and
    // the colour already say which harness it is.
    if (width >= 58) {
      parts.push({ text: `${style.label.padEnd(LABEL_WIDTH)} `, color: "harness", harness: style.id })
    }
  } else {
    // A hub that learned a new harness still lists its sessions, uncoloured.
    parts.push({ text: `${oneLine(session.harness, 12)} `, color: "muted" })
  }
  const when = relativeTime(session.updatedAt ?? session.createdAt, now)
  parts.push({ text: when.padEnd(TIME_WIDTH), color: "muted" })
  parts.push({ text: `${`${session.messageCount} msg`.padStart(COUNT_WIDTH)}`, color: "muted" })
  parts.push({ text: " \u00b7 ", color: "muted" })
  parts.push({ text: oneLine(session.repo ?? session.cwd ?? "-", 64), color: "muted" })
  return fit(parts, width)
}

/** The legend: every marker, its key, and which one is active. */
function legendSegments(active: HarnessId | null, width: number): Seg[] {
  const build = (labels: boolean): Seg[] => {
    const parts: Seg[] = []
    for (const entry of HARNESS) {
      const on = active === entry.id
      parts.push({
        text: on ? "\u25cf" : " ",
        color: on ? "harness" : "off",
        harness: entry.id,
      })
      parts.push({ text: `${entry.key} ${marker(entry)}`, color: on ? "harness" : "off", harness: entry.id })
      if (labels) parts.push({ text: ` ${entry.label}`, color: on ? "harness" : "off", harness: entry.id })
      parts.push({ text: "  ", color: "off" })
    }
    parts.push({
      text: `0 all${active === null ? " (showing)" : ""}`,
      color: active === null ? "accent" : "off",
    })
    return parts
  }
  const full = build(true)
  if (segWidth(full) <= width) return full
  const compact = build(false)
  return fit(compact, width)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** True for a single printable character, which is what the filter box appends. */
function printable(sequence: string): boolean {
  if (!sequence) return false
  // Escape and every arrow key arrive as their raw control sequence; those are
  // handled by name and must never be typed into the box.
  return !/[\u0000-\u001f\u007f\u0080-\u009f]/.test(sequence)
}

const READ_ONLY_RE = /read[\s-]?only/i

const READ_ONLY_NOTE =
  "the hub index is read-only here: what you see is the last scan (real results, just not fresh)"

/**
 * Whether the hub's index can be written by this process.
 *
 * `core/hub.ts` decides this by trying a read-write open and falling back to a
 * read-only handle, and the CLI prints the reason on stderr *only* in human mode;
 * the `--json` path this integration uses drops stderr on success, so that note
 * would otherwise never reach a front end. Checking the index file and its
 * directory for write access is the closest honest equivalent, and the browser
 * also watches the hub's own error text for the same words. Anything else
 * (a directory that does not exist yet, an index that was never built) returns
 * null: the browser does not cry read-only about things it cannot see.
 */
function indexWriteNote(): string | null {
  try {
    const file = path.join(hubHomeDir(), "index.sqlite")
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) return null
    // SQLite writes a journal beside the index, or the -wal/-shm pair in WAL mode,
    // so a writable file inside an unwritable directory is still read-only here.
    fs.accessSync(fs.existsSync(file) ? file : dir, fs.constants.W_OK)
    fs.accessSync(dir, fs.constants.W_OK)
    return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === "EACCES" || code === "EPERM" || code === "EROFS" ? READ_ONLY_NOTE : null
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HubStore {
  // The list
  rows: () => HubSession[]
  visible: () => HubSession[]
  loaded: () => number
  projects: () => number
  loading: () => boolean
  busy: () => boolean
  error: () => string | null
  note: () => string | null
  origin: () => string
  searchNote: () => string | null
  selected: () => number
  setSelected: (index: number) => void
  selectedSession: () => HubSession | undefined
  move: (delta: number) => void
  jump: (where: "first" | "last") => void
  reload: () => Promise<void>
  // The filter box
  text: () => string
  cursor: () => number
  searching: () => boolean
  focusSearch: () => void
  blurSearch: () => void
  insert: (chunk: string) => void
  backspace: () => void
  deleteForward: () => void
  moveCursor: (delta: number) => void
  cursorEnd: (which: "start" | "end") => void
  clearText: () => void
  // Harness filter
  harness: () => HarnessId | null
  setHarness: (value: HarnessId | null) => void
  // Panes and preview
  pane: () => "list" | "preview"
  togglePane: () => void
  preview: () => Preview | null
  previewError: () => string | null
  previewOffset: () => number
  scrollPreview: (delta: number) => void
  resetPreviewScroll: () => void
  loadPreview: (uid: string | undefined) => Promise<void>
  dispose: () => void
}

/**
 * All of the browser's state, built once per TUI session. Plain signals only: the
 * list is small, the caches are bounded by `LIST_LIMIT`, and the only thing that
 * needs an owner to let go of is the search debounce, which `dispose` clears.
 */
function createStore(api: TuiPluginApi): HubStore {
  const [rows, setRows] = createSignal<HubSession[]>([])
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [note, setNote] = createSignal<string | null>(null)
  const [text, setText] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const [searching, setSearching] = createSignal(false)
  const [harness, setHarnessRaw] = createSignal<HarnessId | null>(null)
  const [pane, setPane] = createSignal<"list" | "preview">("list")
  const [preview, setPreview] = createSignal<Preview | null>(null)
  const [previewError, setPreviewError] = createSignal<string | null>(null)
  const [previewOffset, setPreviewOffset] = createSignal(0)
  /** Transcript-search hits, or null when the loaded list is the answer. */
  const [hits, setHits] = createSignal<HubSession[] | null>(null)
  const [searchNote, setSearchNote] = createSignal<string | null>(null)
  const [searchBusy, setSearchBusy] = createSignal(false)

  /** Previews are free but not instant: the CLI reads a transcript off disk. */
  const previews = new Map<string, Preview>()
  /** Guards against a slow answer landing after the user has moved on. */
  let previewToken = 0
  let searchToken = 0
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  const projectDirectory = (): string | undefined => {
    const directory = api.state?.path?.directory
    return typeof directory === "string" && directory ? directory : undefined
  }

  /**
   * What the list is showing. A transcript search replaces the loaded list
   * wholesale and is *not* filtered again by the typed words: those hits matched
   * deeper in a transcript than a title or preview shows, and re-filtering them
   * here would throw away half the answer.
   */
  const visible = createMemo(() => {
    const filter = harness()
    const server = hits()
    if (server) return server.filter((session) => !filter || session.harness === filter)
    const needle = text().trim().toLowerCase()
    return rows().filter(
      (session) =>
        (!filter || session.harness === filter) && (!needle || matchesText(session, needle)),
    )
  })

  const origin = (): string => {
    if (hits()) return `transcript search for "${oneLine(text().trim(), 40)}" over every project`
    if (text().trim()) return `${harness() ? harnessLabel(harness()!) + " matches" : "matches"} in the loaded list (local filter)`
    if (harness()) return `${harnessLabel(harness()!)} sessions, every project, newest first`
    return "this project, newest first"
  }

  const loaded = (): number => {
    const server = hits()
    return server ? server.length : rows().length
  }

  /** How many distinct projects the loaded rows come from. */
  const projects = (): number => {
    const seen = new Set<string>()
    for (const session of rows()) {
      const where = session.repo ?? session.cwd
      if (where) seen.add(where)
    }
    return seen.size
  }

  const selectedSession = (): HubSession | undefined => {
    const list = visible()
    if (list.length === 0) return undefined
    return list[clamp(selected(), 0, list.length - 1)]
  }

  const loadPreview = async (uid: string | undefined): Promise<void> => {
    if (!uid) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    const cached = previews.get(uid)
    if (cached) {
      setPreview(cached)
      setPreviewError(null)
      return
    }
    const token = ++previewToken
    setPreview(null)
    setPreviewError(null)
    const result = await contextFor(uid, BUDGET)
    if (token !== previewToken) return
    if (!result.ok) {
      const hint = oneLine(hubFixHint(result), 300)
      setPreviewError(hint)
      pluginLog(`preview failed for ${uid}: ${hint}`)
      return
    }
    const value: Preview = {
      chars: result.data.chars,
      estimatedTokens: result.data.estimatedTokens,
      included: result.data.includedMessages,
      omitted: result.data.omittedMessages,
      markdown: result.data.markdown,
    }
    previews.set(uid, value)
    setPreview(value)
  }

  const move = (delta: number): void => {
    const total = visible().length
    if (total === 0) return
    setSelected(clamp(selected() + delta, 0, total - 1))
  }

  const jump = (where: "first" | "last"): void => {
    const total = visible().length
    if (total === 0) return
    setSelected(where === "first" ? 0 : total - 1)
  }

  // -- the filter box ------------------------------------------------------

  /**
   * Ask the hub to search every transcript, but only when the local filter came up
   * empty and the words are long enough to be worth a Node process. The answer is
   * used only if it is still the current question (the token guard), and a failed
   * search leaves the local answer standing.
   */
  const runServerSearch = async (query: string, wanted: HarnessId | null): Promise<void> => {
    const token = ++searchToken
    const result = await findSessions({ query, harness: wanted ?? undefined, limit: SEARCH_LIMIT })
    if (token !== searchToken) return
    setSearchBusy(false)
    if (!result.ok) {
      const hint = oneLine(hubFixHint(result), 300)
      pluginLog(`transcript search failed for "${query}": ${hint}`)
      if (READ_ONLY_RE.test(hint)) setNote(oneLine(hint, 200))
      setHits([])
      setSearchNote(`searching every transcript failed: ${oneLine(hint, 140)}`)
      return
    }
    setHits(result.data.sessions ?? [])
    setSearchNote(`transcript search: ${result.data.sessions.length} hit(s) over every project`)
  }

  const scheduleSearch = (): void => {
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
    const query = text().trim()
    if (query.length < MIN_SERVER_QUERY || visible().length > 0) {
      // Enough local matches, or too little to go on: stay local, stay instant.
      searchToken += 1
      setHits(null)
      setSearchNote(null)
      setSearchBusy(false)
      return
    }
    setSearchBusy(true)
    const wanted = harness()
    searchTimer = setTimeout(() => {
      searchTimer = null
      void runServerSearch(query, wanted)
    }, SEARCH_DEBOUNCE_MS)
  }

  const afterTextChange = (): void => {
    setSelected(0)
    setPreviewOffset(0)
    scheduleSearch()
  }

  const insert = (chunk: string): void => {
    if (!chunk) return
    const at = cursor()
    setText(`${text().slice(0, at)}${chunk}${text().slice(at)}`)
    setCursor(at + chunk.length)
    afterTextChange()
  }

  const backspace = (): void => {
    const at = cursor()
    if (at === 0) return
    setText(`${text().slice(0, at - 1)}${text().slice(at)}`)
    setCursor(at - 1)
    afterTextChange()
  }

  const deleteForward = (): void => {
    const at = cursor()
    if (at >= text().length) return
    setText(`${text().slice(0, at)}${text().slice(at + 1)}`)
    afterTextChange()
  }

  const moveCursor = (delta: number): void => {
    setCursor(clamp(cursor() + delta, 0, text().length))
  }

  const cursorEnd = (which: "start" | "end"): void => {
    setCursor(which === "start" ? 0 : text().length)
  }

  const clearText = (): void => {
    if (text() === "") return
    setText("")
    setCursor(0)
    afterTextChange()
  }

  const focusSearch = (): void => {
    setSearching(true)
    setPane("list")
    setCursor(text().length)
  }

  const blurSearch = (): void => {
    setSearching(false)
    setPane("list")
  }

  const setHarness = (value: HarnessId | null): void => {
    setHarnessRaw(value)
    setSelected(0)
    setPreviewOffset(0)
    scheduleSearch()
  }

  // -- the list ------------------------------------------------------------

  const reload = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    setSearchBusy(false)
    // A reload asks the list question again, so a transcript search no longer
    // applies. The typed words stay, and now filter the freshly loaded rows.
    searchToken += 1
    setHits(null)
    setSearchNote(null)
    const result = await findSessions({ dir: projectDirectory(), limit: LIST_LIMIT })
    setLoading(false)
    if (!result.ok) {
      const hint = hubFixHint(result)
      setRows([])
      setSelected(0)
      setError(hint)
      if (READ_ONLY_RE.test(hint)) setNote(READ_ONLY_NOTE)
      pluginLog(`browser could not read the hub index: ${oneLine(hint, 300)}`)
      return
    }
    setRows(result.data.sessions ?? [])
    setSelected(0)
    setPreviewOffset(0)
    const writable = indexWriteNote()
    if (writable) setNote(writable)
    pluginLog(
      `browser loaded ${result.data.sessions.length} session(s), scope ${result.data.scope}, keybind ${openKeybind()}`,
    )
  }

  const togglePane = (): void => {
    setPane(pane() === "list" ? "preview" : "list")
  }

  const scrollPreview = (delta: number): void => {
    setPreviewOffset((value) => Math.max(0, value + delta))
  }

  const dispose = (): void => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = null
  }

  return {
    rows,
    visible,
    loaded,
    projects,
    loading,
    busy: () => loading() || searchBusy(),
    error,
    note,
    origin,
    searchNote,
    selected,
    setSelected,
    selectedSession,
    move,
    jump,
    reload,
    text,
    cursor,
    searching,
    focusSearch,
    blurSearch,
    insert,
    backspace,
    deleteForward,
    moveCursor,
    cursorEnd,
    clearText,
    harness,
    setHarness,
    pane,
    togglePane,
    preview,
    previewError,
    previewOffset,
    scrollPreview,
    resetPreviewScroll: () => setPreviewOffset(0),
    loadPreview,
    dispose,
  }
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

const Line = (props: { segments: Seg[]; theme: TuiThemeCurrent; selected?: boolean }) => (
  <box flexDirection="row">
    <For each={props.segments}>
      {(segment) => <text fg={colorFor(props.theme, segment, props.selected === true)}>{segment.text}</text>}
    </For>
  </box>
)

const Row = (props: {
  session: HubSession
  selected: boolean
  width: number
  theme: TuiThemeCurrent
  now: number
}) => {
  const main = createMemo(() => mainSegments(props.session, props.width, props.now))
  const title = () =>
    oneLine(props.session.title ?? props.session.preview ?? "(no title)", Math.max(8, props.width - 2))

  return (
    <box
      flexDirection="column"
      // The selection is a background plus the accent bar at the left edge, never a
      // bare foreground change: a colour-only cue disappears in themes where `text`
      // and `accent` sit close together, and it does not read as a block of one row
      // at 80 columns.
      backgroundColor={props.selected ? props.theme.backgroundElement : undefined}
    >
      <box flexDirection="row">
        <text fg={props.selected ? props.theme.accent : props.theme.textMuted}>
          {props.selected ? "\u258c" : " "}
        </text>
        <For each={main()}>
          {(segment) => <text fg={colorFor(props.theme, segment, props.selected)}>{segment.text}</text>}
        </For>
      </box>
      <text fg={props.selected ? props.theme.selectedListItemText : props.theme.textMuted}>
        {`  ${title()}`}
      </text>
    </box>
  )
}

interface Frame {
  wide: boolean
  width: number
  usable: number
  body: number
  listRows: number
  previewLines: number
  listWidth: number
  previewWidth: number
  listInner: number
  previewInner: number
}

const HubView = (props: { api: TuiPluginApi; store: HubStore }) => {
  const dim = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const store = props.store

  /**
   * One place that decides how much room everybody gets. Everything below reads
   * from here, so 80x24 and 200x60 are the same code path with different numbers.
   */
  const frame = createMemo((): Frame => {
    const term = dim()
    const width = Math.max(40, term.width)
    // One row is left to the host: the route can be rendered inside the frame that
    // still carries OpenCode's own status line.
    const height = Math.max(14, term.height - 1)
    const usable = width - 2 // the root box pads one column on each side
    const wide = width >= WIDE_MIN_COLUMNS
    const showsFilter = store.searching() || store.text().trim().length > 0
    // title, origin, [filter], [read-only note], legend
    const chrome = 3 + (showsFilter ? 1 : 0) + (store.note() ? 1 : 0)
    const footer = 2
    const body = Math.max(8, height - chrome - footer)
    if (wide) {
      const listWidth = Math.max(34, Math.floor(usable * 0.46))
      const previewWidth = Math.max(24, usable - listWidth - 1)
      const paneInner = Math.max(4, body - 2) // top and bottom border
      return {
        wide,
        width,
        usable,
        body,
        listRows: Math.max(2, Math.floor(paneInner / 2)),
        // three metadata lines, the cost line, a rule, then the range line
        previewLines: Math.max(1, paneInner - 6),
        listWidth,
        previewWidth,
        listInner: Math.max(16, listWidth - 4),
        previewInner: Math.max(16, previewWidth - 4),
      }
    }
    const listRows = Math.max(2, Math.floor((Math.floor(body * 0.55) - 1) / 2))
    const listHeight = listRows * 2 + 1 // the box draws a top border
    const previewInner = Math.max(4, body - listHeight - 1)
    return {
      wide,
      width,
      usable,
      body,
      listRows,
      previewLines: Math.max(1, previewInner - 6),
      listWidth: usable,
      previewWidth: usable,
      listInner: Math.max(16, usable - 2),
      previewInner: Math.max(16, usable - 2),
    }
  })

  /** The slice of rows on screen, kept around the selection. */
  const viewport = createMemo(() => {
    const all = store.visible()
    const max = frame().listRows
    const selection = store.selected()
    const start = clamp(selection - Math.floor(max / 2), 0, Math.max(0, all.length - max))
    return { rows: all.slice(start, start + max), start, total: all.length, selection }
  })

  /** The head of the package, windowed by the preview scroll offset. */
  const previewWindow = createMemo(() => {
    const markdown = store.preview()?.markdown ?? ""
    const all = markdown ? markdown.split("\n") : []
    const max = frame().previewLines
    const offset = clamp(store.previewOffset(), 0, Math.max(0, all.length - max))
    return { rows: all.slice(offset, offset + max), offset, total: all.length, max }
  })

  createEffect(() => {
    // Keep the selection inside the list when a filter or a search shrinks it.
    const total = store.visible().length
    if (total > 0 && store.selected() >= total) store.setSelected(total - 1)
  })

  createEffect(() => {
    // The preview follows the selection, and a new session starts at its top.
    const uid = store.selectedSession()?.uid
    store.resetPreviewScroll()
    void store.loadPreview(uid)
  })

  const close = (): void => {
    props.api.route.navigate("home")
  }

  /**
   * The route's own key handler. It only owns the keyboard while the filter box is
   * focused: with the box closed, every key belongs to the keymap layer registered
   * in `tui` below, and one key never has two owners.
   */
  useKeyboard((key) => {
    if (props.api.route.current.name !== HUB_ROUTE) return
    // A dialog owns the keyboard while it is up: without this, typing "j" into the
    // palette would also move this list.
    if (props.api.ui?.dialog?.open) return
    if (!store.searching()) return
    const name = key.name.toLowerCase()
    if (name === "escape" || name === "esc") {
      // First escape clears the words, the second leaves: the filter is the only
      // thing on screen a stray escape should be able to throw away.
      if (store.text()) store.clearText()
      else close()
    } else if (name === "return" || name === "enter") {
      store.blurSearch() // keep the words, hand the keyboard back to the list
    } else if (name === "tab") {
      store.togglePane()
    } else if (name === "backspace") {
      store.backspace()
    } else if (name === "delete" || name === "del") {
      store.deleteForward()
    } else if (name === "left" || name === "arrowleft") {
      store.moveCursor(-1)
    } else if (name === "right" || name === "arrowright") {
      store.moveCursor(1)
    } else if (name === "home") {
      store.cursorEnd("start")
    } else if (name === "end") {
      store.cursorEnd("end")
    } else if (name === "up" || name === "arrowup" || name === "k") {
      // The list still moves while the words are being typed: the row you are
      // describing should not be out of reach because the keyboard is in the box.
      store.move(-1)
    } else if (name === "down" || name === "arrowdown" || name === "j") {
      store.move(1)
    } else if (key.ctrl && (name === "u" || name === "w")) {
      store.clearText()
    } else if (!key.ctrl && !key.meta && !key.option && printable(key.sequence)) {
      // Digits type here rather than switching the harness filter, which is what
      // makes the text filter and the harness filter compose instead of compete.
      store.insert(key.sequence)
    } else {
      return
    }
    key.preventDefault()
    key.stopPropagation()
  })

  // A paste is text, not a sequence of keys: insert it whole when the box has focus.
  usePaste((event) => {
    if (props.api.route.current.name !== HUB_ROUTE) return
    if (!store.searching()) return
    try {
      store.insert(new TextDecoder().decode(event.bytes))
    } catch {
      /* a paste that cannot be decoded is not worth an error state */
    }
  })

  /** Rows, or the honest reason there are none. */
  const listBody = () => (
    <Show
      when={store.visible().length > 0}
      fallback={
        <box flexDirection="column">
          <Line
            theme={theme()}
            segments={fit(
              [
                {
                  text: store.loading()
                    ? "reading the hub index\u2026"
                    : store.text().trim()
                      ? `nothing matches "${oneLine(store.text().trim(), 60)}"`
                      : store.harness()
                        ? `no ${harnessLabel(store.harness()!)} sessions in ${store.origin()}`
                        : "no sessions are recorded for this project yet",
                  color: "muted",
                },
              ],
              frame().listInner,
            )}
          />
          <Show when={store.text().trim() && !store.loading()}>
            <Line
              theme={theme()}
              segments={fit(
                [
                  {
                    text: store.harness() ? "press 0 to drop the harness filter, or " : "",
                    color: "muted",
                  },
                  {
                    text: `/hub ${oneLine(store.text().trim(), 40)} searches full transcripts server-side`,
                    color: "accent",
                  },
                ],
                frame().listInner,
              )}
            />
          </Show>
          <Show when={!store.text().trim() && !store.loading()}>
            <Line
              theme={theme()}
              segments={fit([{ text: "press r to re-read the hub index", color: "muted" }], frame().listInner)}
            />
          </Show>
        </box>
      }
    >
      <box flexDirection="column">
        <For each={viewport().rows}>
          {(session, index) => (
            <Row
              session={session}
              selected={viewport().start + index() === viewport().selection}
              width={frame().listInner}
              theme={theme()}
              now={Date.now()}
            />
          )}
        </For>
      </box>
    </Show>
  )

  /** The metadata block, the cost line, and the head of the package. Free, always. */
  const previewBody = () => {
    const session = store.selectedSession()
    if (!session) {
      return (
        <Line
          theme={theme()}
          segments={fit(
            [{ text: "select a session to see what would be imported", color: "muted" }],
            frame().previewInner,
          )}
        />
      )
    }
    const style = styleFor(session.harness)
    const window = previewWindow()
    const cost = store.preview()
    return (
      <box flexDirection="column">
        <Line
          theme={theme()}
          segments={fit(
            [
              { text: `${marker(style)} `, color: "harness", harness: style?.id },
              { text: harnessLabel(session.harness), color: "harness", harness: style?.id },
              {
                text: ` \u00b7 ${oneLine(session.model ?? "model unknown", 40)} \u00b7 ${session.messageCount} message(s)`,
                color: "muted",
              },
            ],
            frame().previewInner,
          )}
        />
        <Line
          theme={theme()}
          segments={fit([{ text: session.uid, color: "muted" }], frame().previewInner)}
        />
        <Line
          theme={theme()}
          segments={fit(
            [
              { text: oneLine(session.repo ?? session.cwd ?? "-", 60), color: "muted" },
              {
                text: ` \u00b7 last activity ${relativeTime(session.updatedAt ?? session.createdAt)}`,
                color: "muted",
              },
            ],
            frame().previewInner,
          )}
        />
        <Line
          theme={theme()}
          segments={fit(
            [
              {
                text: cost
                  ? `importing ${cost.included}/${cost.included + cost.omitted} message(s) \u00b7 ${formatCost(cost.chars, cost.estimatedTokens)} \u00b7 nothing sent yet`
                  : store.previewError()
                    ? `cost unavailable: ${oneLine(store.previewError()!, 80)}`
                    : "measuring the import\u2026",
                color: store.previewError() ? "warning" : "text",
              },
            ],
            frame().previewInner,
          )}
        />
        <Line
          theme={theme()}
          segments={[
            {
              text: "\u2500".repeat(Math.max(8, Math.min(frame().previewInner, 60))),
              color: "off",
            },
          ]}
        />
        <For each={window.rows}>
          {(line) => (
            <Line
              theme={theme()}
              segments={fit([{ text: line || " ", color: "muted" }], frame().previewInner)}
            />
          )}
        </For>
        <Show when={window.total > window.max}>
          <Line
            theme={theme()}
            segments={fit(
              [
                {
                  text: `lines ${window.offset + 1}-${window.offset + window.rows.length} of ${window.total} \u00b7 tab, then \u2191\u2193, to scroll`,
                  color: "off",
                },
              ],
              frame().previewInner,
            )}
          />
        </Show>
      </box>
    )
  }

  /** Only the keys that apply to the focused pane, and only those. */
  const footerSegments = (): Seg[] => {
    if (store.searching()) {
      return [
        { text: "typing filters this list \u00b7 ", color: "muted" },
        { text: "enter", color: "text" },
        { text: " keeps it \u00b7 ", color: "muted" },
        { text: "esc", color: "text" },
        { text: " clears \u00b7 \u2190\u2192 move the caret", color: "muted" },
      ]
    }
    if (store.pane() === "preview") {
      return [
        { text: "\u2191\u2193 scroll \u00b7 pgup/pgdn page \u00b7 ", color: "muted" },
        { text: "tab", color: "text" },
        { text: " list \u00b7 ", color: "muted" },
        { text: "enter", color: "text" },
        { text: " import \u00b7 ", color: "muted" },
        { text: "esc", color: "text" },
        { text: " back", color: "muted" },
      ]
    }
    return [
      { text: "\u2191\u2193 move \u00b7 ", color: "muted" },
      { text: "tab", color: "text" },
      { text: " preview \u00b7 ", color: "muted" },
      { text: "enter", color: "text" },
      { text: " import \u00b7 ", color: "muted" },
      { text: "/", color: "text" },
      { text: " search \u00b7 ", color: "muted" },
      { text: "1-6", color: "text" },
      { text: " harness \u00b7 ", color: "muted" },
      { text: "0", color: "text" },
      { text: " all \u00b7 ", color: "muted" },
      { text: "r", color: "text" },
      { text: " reload \u00b7 ", color: "muted" },
      { text: "esc", color: "text" },
      { text: " back", color: "muted" },
    ]
  }

  const paneBorder = (which: "list" | "preview") =>
    store.pane() === which ? theme().borderActive : theme().borderSubtle

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Line
        theme={theme()}
        segments={fit(
          [
            { text: "session-hub", color: "accent" },
            {
              text: `  ${store.visible().length} of ${store.loaded()} shown \u00b7 ${store.projects()} project(s)`,
              color: "muted",
            },
            { text: store.harness() ? ` \u00b7 ${harnessLabel(store.harness()!)} only` : "", color: "harness", harness: store.harness() ?? undefined },
          ],
          frame().usable,
        )}
      />
      <Line
        theme={theme()}
        segments={fit(
          [
            {
              text: store.busy()
                ? store.loading()
                  ? "reading the hub index\u2026"
                  : "asking the hub to search every transcript\u2026"
                : (store.searchNote() ?? store.origin()),
              color: "muted",
            },
          ],
          frame().usable,
        )}
      />
      <Show when={store.searching() || store.text().trim().length > 0}>
        <Line
          theme={theme()}
          segments={fit(
            [
              { text: "filter: ", color: "muted" },
              {
                text: store.searching()
                  ? `${store.text().slice(0, store.cursor())}\u258f${store.text().slice(store.cursor())}`
                  : store.text(),
                color: store.searching() ? "accent" : "text",
              },
              {
                text: `  ${store.visible().length} match(es)`,
                color: "muted",
              },
            ],
            frame().usable,
          )}
        />
      </Show>
      <Show when={store.note()}>
        <Line
          theme={theme()}
          // `?? ""`: Solid evaluates a `Show` body's JSX eagerly, hidden or not, so
          // this line is built before the note exists and must not assume it does.
          segments={fit([{ text: store.note() ?? "", color: "warning" }], frame().usable)}
        />
      </Show>
      <Line theme={theme()} segments={legendSegments(store.harness(), frame().usable)} />

      <Show when={store.error()}>
        <box flexDirection="column">
          <For each={lines(store.error() ?? "", 5)}>
            {(line) => (
              <Line
                theme={theme()}
                segments={fit([{ text: line, color: "warning" }], frame().usable)}
              />
            )}
          </For>
        </box>
      </Show>

      <Show
        when={frame().wide}
        fallback={
          <box flexDirection="column" height={frame().body}>
            <box
              flexDirection="column"
              height={frame().listRows * 2 + 1}
              border={["top"]}
              borderColor={paneBorder("list")}
              title=" sessions "
              titleColor={paneBorder("list")}
              paddingLeft={1}
            >
              {listBody()}
            </box>
            <box
              flexDirection="column"
              border={["top"]}
              borderColor={paneBorder("preview")}
              title=" preview "
              titleColor={paneBorder("preview")}
              paddingLeft={1}
            >
              {previewBody()}
            </box>
          </box>
        }
      >
        <box flexDirection="row" height={frame().body}>
          <box
            flexDirection="column"
            width={frame().listWidth}
            height={frame().body}
            border={["top", "bottom", "left"]}
            borderColor={paneBorder("list")}
            title=" sessions "
            titleColor={paneBorder("list")}
            paddingLeft={1}
          >
            {listBody()}
          </box>
          {/* The divider is its own one-column box: two neighbouring bordered boxes
              would draw a double line, and this one carries the focus colour. */}
          <box
            width={1}
            height={frame().body}
            border={["left"]}
            borderColor={store.pane() === "preview" ? theme().borderActive : theme().borderSubtle}
          />
          <box
            flexDirection="column"
            width={frame().previewWidth}
            height={frame().body}
            border={["top", "bottom", "right"]}
            borderColor={paneBorder("preview")}
            title=" preview "
            titleColor={paneBorder("preview")}
            paddingLeft={1}
          >
            {previewBody()}
          </box>
        </box>
      </Show>

      <Line theme={theme()} segments={fit(footerSegments(), frame().usable)} />
      <Line
        theme={theme()}
        segments={fit(
          [
            { text: "open again from anywhere: ", color: "off" },
            { text: openKeybind(), color: "muted" },
            { text: " \u00b7 alt+h \u00b7 ctrl+p \u2192 session-hub, browse sessions from your other agents", color: "off" },
          ],
          frame().usable,
        )}
      />
    </box>
  )
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  const store = createStore(api)
  const keybind = openKeybind()
  pluginLog(
    `tui plugin loaded \u00b7 project: ${api.state?.path?.directory ?? "unknown"} \u00b7 keybind: ${keybind} \u00b7 ascii: ${asciiOnly() ? "on" : "off"}`,
  )

  /** True only while the browser is on screen and no dialog is over it. */
  const onHubRoute = (): boolean =>
    api.route?.current?.name === HUB_ROUTE && api.ui?.dialog?.open !== true

  /**
   * Open the browser, loading the list the first time. `route.navigate` with a
   * plugin name is what the host resolves against registered routes.
   */
  const open = async (): Promise<void> => {
    api.route.navigate(HUB_ROUTE)
    if (store.rows().length > 0 || store.loading()) return
    await store.reload()
  }

  const close = (): void => {
    api.route.navigate("home")
  }

  const toast = (variant: "info" | "success" | "warning" | "error", message: string): void => {
    api.ui.toast({ variant, title: "session-hub", message, duration: 8000 })
  }

  /** Confirm, then record the pick. This is the only path that spends anything. */
  const confirmImport = (): void => {
    const session = store.selectedSession()
    if (!session) {
      toast("info", "Nothing selected. Press r to re-read the hub index.")
      return
    }
    const measured = store.preview()
    const DialogConfirm = api.ui.DialogConfirm
    api.ui.dialog.replace(() => (
      <DialogConfirm
        title="Import this session?"
        message={[
          oneLine(session.title ?? session.uid, 80),
          `from ${harnessLabel(session.harness)}`,
          "",
          measured
            ? `Cost: ${formatCost(measured.chars, measured.estimatedTokens)}.`
            : "The cost could not be measured yet; the hub will still budget the import.",
          "It arrives with your next message. Nothing is sent now.",
        ].join("\n")}
        onConfirm={() => {
          api.ui.dialog.clear()
          void pick(session)
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }

  const pick = async (session: HubSession): Promise<void> => {
    const result = await pickSession(session.uid, {
      chars: BUDGET,
      note: "picked in the session-hub browser",
    })
    if (!result.ok) {
      const hint = oneLine(hubFixHint(result), 300)
      pluginLog(`browser pick failed for ${session.uid}: ${hint}`)
      toast("error", hubFixHint(result))
      return
    }
    pluginLog(`browser picked ${result.data.uid} (${result.data.chars} chars)`)
    toast(
      "success",
      `Selected ${oneLine(session.title ?? session.uid, 60)} from ${harnessLabel(session.harness)}. ` +
        `It arrives with your next message. Cancel with /hub clear.`,
    )
    close()
  }

  /** Show what is already waiting, from any surface. */
  const showPending = async (): Promise<void> => {
    const result = await peekPending()
    if (!result.ok) {
      pluginLog(`pending peek failed: ${oneLine(hubFixHint(result), 200)}`)
      toast("error", hubFixHint(result))
      return
    }
    if (!result.data) {
      toast("info", "Nothing is pending. Open the browser with the session-hub keybind.")
      return
    }
    const { selection, expired } = result.data
    toast(
      expired ? "warning" : "info",
      expired
        ? `${selection.uid} went stale (picks expire after two hours). Pick it again.`
        : `${oneLine(selection.title ?? selection.uid, 60)} from ${harnessLabel(selection.harness)} arrives with your next message.`,
    )
  }

  /** `esc` from the list: drop the words first, leave on the second press. */
  const leaveOrClear = (): void => {
    if (store.text()) {
      store.clearText()
      return
    }
    close()
  }

  api.lifecycle.onDispose(
    api.route.register([
      {
        name: HUB_ROUTE,
        // Any throw inside the view would otherwise be the end of the session, so
        // the browser gets a boundary of its own that says what to do next.
        render: () => (
          <ErrorBoundary
            fallback={(err: unknown) => (
              <box flexDirection="column" paddingLeft={1} paddingRight={1}>
                <text fg={api.theme.current.warning}>session-hub: the browser crashed</text>
                <text fg={api.theme.current.textMuted}>
                  {oneLine(err instanceof Error ? err.message : String(err), 200)}
                </text>
                <text fg={api.theme.current.textMuted}>
                  esc closes it. ~/.session-hub/opencode-plugin-loaded.log records the load lines.
                </text>
              </box>
            )}
          >
            <HubView api={api} store={store} />
          </ErrorBoundary>
        ),
      },
    ]),
  )

  api.lifecycle.onDispose(() => store.dispose())

  // Global: opening the browser and looking at what is pending. Both keys were
  // checked against opencode's own default keybinds, which bind neither.
  api.lifecycle.onDispose(
    api.keymap.registerLayer({
      commands: [
        {
          name: "sessionhub.open",
          title: "session-hub: browse sessions from your other agents",
          desc: "Find work you left in Claude Code, Codex, Crush, JCode or Pi and import it here",
          category: "session-hub",
          run: () => {
            void open()
            return true
          },
        },
        {
          name: "sessionhub.pending",
          title: "session-hub: what is waiting to be imported",
          desc: "Show the session that will arrive with your next message",
          category: "session-hub",
          run: () => {
            void showPending()
            return true
          },
        },
      ],
      bindings: [
        { key: keybind, cmd: "sessionhub.open" },
        // Always, and not configurable: a terminal that cannot report `shift` turns
        // `ctrl+shift+h` into `ctrl+h`, which OpenCode does not bind, so this is
        // the key that always works.
        { key: "alt+h", cmd: "sessionhub.open" },
      ],
    }),
  )

  // Route-local commands, both of them driven by the harness table so the legend,
  // the keys and the commands cannot drift apart.
  const harnessCommands = HARNESS.map((entry) => ({
    name: `sessionhub.harness.${entry.id}`,
    title: `session-hub: show only ${entry.label}`,
    desc: `Key ${entry.key} in the browser: only ${entry.label} sessions`,
    category: "session-hub",
    run: () => {
      store.setHarness(store.harness() === entry.id ? null : entry.id)
      return true
    },
  }))

  const harnessBindings = HARNESS.map((entry) => ({
    key: entry.key,
    cmd: `sessionhub.harness.${entry.id}`,
  }))

  // Scoped to the browser route and only while no dialog is up. Layer-level
  // `enabled` is what keeps up/down/enter/1-6 untouched everywhere else, and the
  // filter box owning the keyboard is what keeps a typed "3" from switching the
  // harness filter while the user is typing words.
  api.lifecycle.onDispose(
    api.keymap.registerLayer({
      enabled: () => onHubRoute() && !store.searching(),
      commands: [
        {
          name: "sessionhub.prev",
          title: "session-hub: previous session",
          category: "session-hub",
          run: () => {
            store.move(-1)
            return true
          },
        },
        {
          name: "sessionhub.next",
          title: "session-hub: next session",
          category: "session-hub",
          run: () => {
            store.move(1)
            return true
          },
        },
        {
          name: "sessionhub.pageUp",
          title: "session-hub: page up",
          category: "session-hub",
          run: () => {
            if (store.pane() === "preview") store.scrollPreview(-PREVIEW_PAGE)
            else store.move(-5)
            return true
          },
        },
        {
          name: "sessionhub.pageDown",
          title: "session-hub: page down",
          category: "session-hub",
          run: () => {
            if (store.pane() === "preview") store.scrollPreview(PREVIEW_PAGE)
            else store.move(5)
            return true
          },
        },
        {
          name: "sessionhub.first",
          title: "session-hub: first session",
          category: "session-hub",
          run: () => {
            store.jump("first")
            return true
          },
        },
        {
          name: "sessionhub.last",
          title: "session-hub: last session",
          category: "session-hub",
          run: () => {
            store.jump("last")
            return true
          },
        },
        {
          name: "sessionhub.pane",
          title: "session-hub: switch pane",
          desc: "Move the focus between the list and the preview",
          category: "session-hub",
          run: () => {
            store.togglePane()
            return true
          },
        },
        {
          name: "sessionhub.search",
          title: "session-hub: search the sessions on screen",
          desc: "The words match the loaded list; /hub <words> searches full transcripts",
          category: "session-hub",
          run: () => {
            store.focusSearch()
            return true
          },
        },
        {
          name: "sessionhub.import",
          title: "session-hub: import the selected session",
          category: "session-hub",
          run: () => {
            confirmImport()
            return true
          },
        },
        {
          name: "sessionhub.reload",
          title: "session-hub: reload the list",
          category: "session-hub",
          run: () => {
            void store.reload()
            return true
          },
        },
        {
          name: "sessionhub.clearHarness",
          title: "session-hub: show every harness",
          category: "session-hub",
          run: () => {
            store.setHarness(null)
            return true
          },
        },
        {
          name: "sessionhub.close",
          title: "session-hub: back to the session",
          category: "session-hub",
          run: () => {
            leaveOrClear()
            return true
          },
        },
        ...harnessCommands,
      ],
      bindings: [
        { key: "up", cmd: "sessionhub.prev" },
        { key: "k", cmd: "sessionhub.prev" },
        { key: "down", cmd: "sessionhub.next" },
        { key: "j", cmd: "sessionhub.next" },
        { key: "pageup", cmd: "sessionhub.pageUp" },
        { key: "pagedown", cmd: "sessionhub.pageDown" },
        { key: "home", cmd: "sessionhub.first" },
        { key: "end", cmd: "sessionhub.last" },
        { key: "tab", cmd: "sessionhub.pane" },
        { key: "return", cmd: "sessionhub.import" },
        { key: "/", cmd: "sessionhub.search" },
        { key: "r", cmd: "sessionhub.reload" },
        { key: "escape", cmd: "sessionhub.close" },
        { key: "0", cmd: "sessionhub.clearHarness" },
        ...harnessBindings,
      ],
    }),
  )

  pluginLog(
    `tui plugin registered the hub route and both keymap layers \u00b7 harness keys ${HARNESS.map((entry) => entry.key).join("")}, 0 clears`,
  )
}

const plugin = { id, tui }
export default plugin
