/** @jsxImportSource @opentui/solid */
/**
 * session-hub for OpenCode, TUI side.
 *
 * A full-screen browser for the sessions sitting in your other coding agents.
 * The list is free, the preview is free (the hub reads the transcript straight
 * off disk, no model is involved), and nothing is imported until you press
 * enter on a session and confirm. Confirming calls `pick`; the server-side
 * plugin delivers that transcript with your next message.
 *
 * What it registers:
 *  - a route named `hub`, reachable with the keybind below or from the command
 *    palette ("session-hub: browse sessions from your other agents"),
 *  - two keymap layers: one global layer that opens the browser, one layer that
 *    is only active while the `hub` route is on screen, so up/down/enter keep
 *    their normal meaning everywhere else,
 *  - the host's dialog primitives for the filter prompt and the confirmation.
 *
 * Loading rules this file obeys, because getting them wrong breaks the TUI:
 *  - no runtime import from `@opencode-ai/plugin` (type-only). OpenCode rewrites
 *    `solid-js` and `@opentui/solid` for TUI plugins, and nothing else.
 *  - the list loads lazily, the first time the browser is opened. The hub's first
 *    index pass over 400+ sessions is seconds of work and must not happen at
 *    startup for someone who never opens the browser.
 *  - every hub call can fail. A failure renders as an error state with the fix,
 *    never as a thrown error: the TUI must not take the session down.
 */

import { For, Show, createSignal } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

import {
  contextFor,
  findSessions,
  formatCost,
  harnessLabel,
  hubFixHint,
  oneLine,
  peekPending,
  pickSession,
  pluginLog,
  relativeTime,
} from "./hub"
import type { HubSession } from "./hub"

const id = "session-hub"
const HUB_ROUTE = "hub"
const BUDGET = 40_000
const OPEN_KEYBIND = "ctrl+shift+h"

interface Cost {
  chars: number
  estimatedTokens: number
  included: number
  omitted: number
  markdown: string
}

interface HubStore {
  sessions: () => HubSession[]
  selected: () => number
  error: () => string | null
  loading: () => boolean
  filter: () => string
  scope: () => "project" | "all"
  cost: () => Cost | null
  costError: () => string | null
  selectedSession: () => HubSession | undefined
  move: (delta: number) => void
  reload: (query?: string) => Promise<void>
}

/**
 * All of the browser's state, built once per TUI session. Plain signals only:
 * the list is small, so nothing here needs a memo or an effect that would need
 * an owner to dispose.
 */
function createStore(api: TuiPluginApi): HubStore {
  const [sessions, setSessions] = createSignal<HubSession[]>([])
  const [selected, setSelected] = createSignal(0)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [filter, setFilter] = createSignal("")
  const [scope, setScope] = createSignal<"project" | "all">("project")
  const [cost, setCost] = createSignal<Cost | null>(null)
  const [costError, setCostError] = createSignal<string | null>(null)

  const costs = new Map<string, Cost>()
  /** Guards against a slow preview landing after the user moved on. */
  let previewToken = 0

  const projectDirectory = (): string | undefined => {
    const directory = api.state?.path?.directory
    return typeof directory === "string" && directory ? directory : undefined
  }

  const selectedSession = (): HubSession | undefined => sessions()[selected()]

  const reload = async (query?: string): Promise<void> => {
    const next = query === undefined ? filter() : query
    setFilter(next)
    setLoading(true)
    setError(null)
    const result = await findSessions({
      query: next.trim() || undefined,
      dir: next.trim() ? undefined : projectDirectory(),
      limit: 25,
    })
    setLoading(false)
    if (!result.ok) {
      setSessions([])
      setSelected(0)
      setError(hubFixHint(result))
      return
    }
    setSessions(result.data.sessions)
    setScope(result.data.scope)
    setSelected(0)
    if (result.data.sessions.length === 0) {
      setError(
        next.trim()
          ? `No session matched "${next}". Try fewer words.`
          : "No sessions are recorded for this project yet. Press r to re-read the hub index.",
      )
    }
    void previewSelected()
  }

  const previewSelected = async (): Promise<void> => {
    const session = selectedSession()
    if (!session) {
      setCost(null)
      setCostError(null)
      return
    }
    const cached = costs.get(session.uid)
    if (cached) {
      setCost(cached)
      setCostError(null)
      return
    }
    const token = ++previewToken
    setCost(null)
    setCostError(null)
    const result = await contextFor(session.uid, BUDGET)
    if (token !== previewToken) return
    if (!result.ok) {
      setCostError(hubFixHint(result))
      return
    }
    const value: Cost = {
      chars: result.data.chars,
      estimatedTokens: result.data.estimatedTokens,
      included: result.data.includedMessages,
      omitted: result.data.omittedMessages,
      markdown: result.data.markdown,
    }
    costs.set(session.uid, value)
    setCost(value)
  }

  const move = (delta: number): void => {
    const total = sessions().length
    if (total === 0) return
    const next = Math.min(total - 1, Math.max(0, selected() + delta))
    if (next === selected()) return
    setSelected(next)
    void previewSelected()
  }

  return {
    sessions,
    selected,
    error,
    loading,
    filter,
    scope,
    cost,
    costError,
    selectedSession,
    move,
    reload,
  }
}

/** Split a multi-line message into lines, because a `text` element holds one line. */
function lines(text: string, max: number): string[] {
  const all = text.split("\n")
  if (all.length <= max) return all
  return [...all.slice(0, Math.max(1, max - 1)), `\u2026 ${all.length - max + 1} more line(s)`]
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

const HubView = (props: { api: TuiPluginApi; store: HubStore }) => {
  const dim = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const state = props.store

  /** The slice of rows that fits on screen, kept around the selection. */
  const viewport = () => {
    const all = state.sessions()
    const height = Math.max(6, dim().height)
    const max = Math.max(3, Math.min(14, Math.floor(height / 3) - 2))
    const selection = state.selected()
    const start = Math.max(0, Math.min(selection - Math.floor(max / 2), all.length - max))
    return { rows: all.slice(start, start + max), start, total: all.length, selection }
  }

  /** How much room the preview gets, and how many transcript lines fit. */
  const previewLines = () => Math.max(4, Math.min(18, Math.floor(Math.max(6, dim().height) / 3)))

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} rowGap={1}>
      <box flexDirection="column">
        <text fg={theme().accent}>session-hub</text>
        <text fg={theme().textMuted}>
          {state.loading()
            ? "reading the hub index\u2026"
            : state.filter()
              ? `${state.sessions().length} match(es) for "${state.filter()}"`
              : state.scope() === "project"
                ? `${state.sessions().length} session(s) for this project, newest first`
                : `${state.sessions().length} session(s) across every project, newest first`}
        </text>
      </box>

      <Show when={state.error()}>
        <box flexDirection="column">
          {lines(state.error() ?? "", 8).map((line) => (
            <text fg={theme().warning}>{line}</text>
          ))}
        </box>
      </Show>

      <scrollbox scrollY height={viewport().total === 0 ? 2 : Math.max(3, previewLines() - 1) * 3}>
        <box flexDirection="column">
          <For each={viewport().rows}>
            {(session, index) => {
              const isSelected = () => viewport().start + index() === viewport().selection
              return (
                <box flexDirection="column">
                  <text fg={isSelected() ? theme().accent : theme().text}>
                    {`${isSelected() ? "\u25b8" : " "} ${session.uid}`}
                  </text>
                  <text fg={theme().textMuted}>
                    {`    ${harnessLabel(session.harness)} \u00b7 ${relativeTime(session.updatedAt ?? session.createdAt)} \u00b7 ${session.messageCount} messages \u00b7 ${oneLine(session.repo ?? session.cwd ?? "-", 48)}`}
                  </text>
                  <text fg={isSelected() ? theme().text : theme().textMuted}>
                    {`    ${oneLine(session.title ?? session.preview ?? "(no title)", 96)}`}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </scrollbox>

      <Show when={state.selectedSession()}>
        <box flexDirection="column">
          <text fg={theme().border}>
            {"\u2500".repeat(Math.max(10, Math.min(80, dim().width - 4)))}
          </text>
          <text fg={theme().text}>
            {state.cost()
              ? `importing ${state.cost()!.included}/${state.cost()!.included + state.cost()!.omitted} message(s) \u00b7 ${formatCost(state.cost()!.chars, state.cost()!.estimatedTokens)} \u00b7 nothing sent yet`
              : state.costError()
                ? `cost unavailable: ${oneLine(state.costError(), 90)}`
                : "measuring the import\u2026"}
          </text>
          {lines(state.cost()?.markdown ?? "", previewLines()).map((line) => (
            <text fg={theme().textMuted}>{oneLine(line, Math.max(20, dim().width - 6))}</text>
          ))}
        </box>
      </Show>

      <text fg={theme().textMuted}>up/down move · enter import · / filter · r reload · esc back</text>
    </box>
  )
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  const store = createStore(api)
  pluginLog(`tui plugin loaded \u00b7 project: ${api.state?.path?.directory ?? "unknown"}`)

  /**
   * Open the browser, loading the list the first time. `route.navigate` with a
   * plugin name is what the host resolves against registered routes.
   */
  const open = async (): Promise<void> => {
    api.route.navigate(HUB_ROUTE)
    if (store.sessions().length === 0 && !store.loading()) await store.reload()
  }

  const close = (): void => {
    api.route.navigate("home")
  }

  const toast = (variant: "info" | "success" | "warning" | "error", message: string): void => {
    api.ui.toast({ variant, title: "session-hub", message, duration: 8000 })
  }

  /** The filter prompt, using the host's own dialog so its keys keep working. */
  const askFilter = (): void => {
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title="session-hub: filter"
        placeholder="words to match, or empty for this project"
        value={store.filter()}
        onConfirm={(value) => {
          api.ui.dialog.clear()
          void store.reload(value ?? "")
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }

  /** Confirm, then record the pick. This is the only path that spends anything. */
  const confirmImport = (): void => {
    const session = store.selectedSession()
    if (!session) {
      toast("info", "Nothing selected. Press r to re-read the hub index.")
      return
    }
    const measured = store.cost()
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

  api.lifecycle.onDispose(
    api.route.register([
      {
        name: HUB_ROUTE,
        render: () => <HubView api={api} store={store} />,
      },
    ]),
  )

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
        { key: OPEN_KEYBIND, cmd: "sessionhub.open" },
        { key: "alt+h", cmd: "sessionhub.open" },
      ],
    }),
  )

  // Scoped to the browser route. Layer-level `enabled` keeps every one of these
  // keys untouched while the user is anywhere else, including inside a dialog.
  api.lifecycle.onDispose(
    api.keymap.registerLayer({
      enabled: () => api.route.current.name === HUB_ROUTE,
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
            store.move(-5)
            return true
          },
        },
        {
          name: "sessionhub.pageDown",
          title: "session-hub: page down",
          category: "session-hub",
          run: () => {
            store.move(5)
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
          name: "sessionhub.filter",
          title: "session-hub: filter sessions",
          category: "session-hub",
          run: () => {
            askFilter()
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
          name: "sessionhub.close",
          title: "session-hub: back to the session",
          category: "session-hub",
          run: () => {
            close()
            return true
          },
        },
      ],
      bindings: [
        { key: "up", cmd: "sessionhub.prev" },
        { key: "k", cmd: "sessionhub.prev" },
        { key: "down", cmd: "sessionhub.next" },
        { key: "j", cmd: "sessionhub.next" },
        { key: "pageup", cmd: "sessionhub.pageUp" },
        { key: "pagedown", cmd: "sessionhub.pageDown" },
        { key: "return", cmd: "sessionhub.import" },
        { key: "/", cmd: "sessionhub.filter" },
        { key: "r", cmd: "sessionhub.reload" },
        { key: "escape", cmd: "sessionhub.close" },
      ],
    }),
  )

  pluginLog("tui plugin registered the hub route and both keymap layers")
}

const plugin = { id, tui }
export default plugin
