# session-hub for OpenCode

Find the conversation you left in another coding agent (Claude Code, Codex,
Crush, JCode, Pi), bring it into the one you are in now, or hand back the exact
command that reopens it where it lives.

OpenCode is the only harness with a real TUI plugin API, so this integration
ships two halves:

| File | Loaded by | What it adds |
| --- | --- | --- |
| `plugin.ts` | `opencode.json` -> `plugin` | four tools, the `/hub` command, and delivery of a picked session into your next message |
| `tui.tsx` | `tui.json` -> `plugin` | the full-screen browser: list, preview, confirm |
| `hub.ts` | imported by both | the only place that talks to the hub CLI |
| `scripts/resolve.mjs` | imported by `hub.ts` | the shared resolver (a copy of `integrations/_shared/resolve.mjs`) |

## Install

Nothing is installed for you. Two files to point at, both of which you own.

### 1. The server half

In the project's `opencode.json`, or in `~/.config/opencode/opencode.json` for
every project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/session-hub/integrations/opencode/plugin.ts"]
}
```

### 2. The TUI half

In `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/absolute/path/to/session-hub/integrations/opencode/tui.tsx"
  ]
}
```

A relative path works too, but an absolute one survives being copied around.
Both halves are independent: with only `plugin.ts` you get the tools and `/hub`;
with only `tui.tsx` you get the browser, whose picks still arrive because the
server half is what delivers them.

Or let OpenCode write the config for you:

```bash
opencode plugin /absolute/path/to/session-hub/integrations/opencode -g
```

### Making sure the hub itself is findable

The plugin shells out to the hub CLI. It finds it through the shared resolver, in
this order: `$SESSION_HUB_ROOT`, `<plugin>/vendor`, `~/.session-hub/install.json`,
a checkout above the current directory, then `sessionhub` on `PATH`.

If the plugin cannot find it, every surface says so and tells you to run:

```
sessionhub setup
```

or to set `SESSION_HUB_ROOT=/path/to/session-hub`. The plugin also needs a Node
on `PATH` (the hub's index uses `node:sqlite`, which OpenCode's Bun cannot
provide); if that is missing, set `SESSION_HUB_NODE=/path/to/node`.

### Later, as an npm package

Once the root package is published, the same two entries become:

```json
"plugin": ["session-hub/integrations/opencode/plugin"]
```

```json
"plugin": ["session-hub/integrations/opencode/tui"]
```

That needs the root export map listed at the bottom of this file.

## Using it

### The keybind

| Keys | Where it works |
| --- | --- |
| `ctrl+shift+h` | the default; terminals that report shifted keys (kitty keyboard protocol) |
| `alt+h` | everywhere, including terminals that do not report shifted keys |

Both open the browser. `ctrl+shift+h` is the nicer one when your terminal can
send it; `alt+h` is the one that always works, because a terminal that cannot
report `shift` turns `ctrl+shift+h` into a plain `ctrl+h`, which OpenCode has no
binding for. Neither key is used by OpenCode's own defaults, and both are
registered even when you change the first one:

```bash
export SESSION_HUB_KEYBIND="ctrl+shift+s"   # the key that opens the browser
```

`alt+h` is not configurable on purpose: it is the fallback that cannot be typed
wrong by a terminal.

The browser is also reachable from the command palette (`ctrl+p`) as
**session-hub: browse sessions from your other agents**, and there is a second
palette entry, **session-hub: what is waiting to be imported**.

### The browser

One list of every agent's sessions, a preview of what would be imported, and the
keys in the footer. This is a real capture, 110 columns wide, 50 sessions from 8
projects across all six harnesses:

```
 session-hub  50 of 50 shown · 8 project(s)
 this project, newest first
  1 π Pi   2 ✻ Claude Code   3 ⬡ Codex   4 ⌘ OpenCode   5 ❯ Crush   6 ◆ JCode  0 all (showing)
 ┌─ sessions ─────────────────────────────────────│── preview ──────────────────────────────────────────────┐
 │ ▌◆ 4m ago     55 msg · /home/gateton           │ ◆ JCode · deepseek-v4.1-flash · 55 message(s)           │
 │ ▌ Produce a real screenshot of session-hub's…  │ jcode:session_owl_1790014229626_f5f92397162df328        │
 │  ◆ 24m ago   165 msg · /home/gateton           │ /home/gateton · last activity 4m ago                    │
 │   Improve the OpenCode TUI browser of `sessi…  │ 4/4 msgs · ~1,810 tokens · nothing sent yet             │
 │  ⌘ 41m ago     2 msg · /home/gateton           │ ──────────────────────────────────────────────────────  │
 │   Pruebas de session-hub en Codex y OpenCode   │ # Imported Session Context                              │
 │  ⬡ 1h ago      4 msg · /home/gateton/Projects… │ - Source harness: JCode                                 │
 │   # AGENTS.md instructions for /home/gateton…  │ - Source session ID: session_owl_1790014229626_f5f923…  │
 └────────────────────────────────────────────────│─────────────────────────────────────────────────────────┘
 ↑↓ move · tab preview · enter import · / search · 1-6 harness · 0 all · r reload · esc back
 open again from anywhere: ctrl+shift+h · alt+h · ctrl+p → session-hub, browse sessions from your other agen…
```

Two panes above 90 columns, one pane below it: under 90 the preview moves
underneath the list, because a row needs about 46 columns and so does the
preview. 80x24 is a supported size, not an accident.

#### Keys

| Key | Pane | What it does |
| --- | --- | --- |
| `1` … `6` | list | show only that harness (the table below says which is which); the same key again clears it |
| `0` | list | show every harness |
| `up` / `down`, `k` / `j` | list | move the selection; the preview follows |
| `up` / `down`, `k` / `j` | preview | scroll the package the preview is showing |
| `pageup` / `pagedown` | either | five sessions, or a page of the preview |
| `home` / `end` | list | first / last session |
| `tab` | either | move the focus between the list and the preview |
| `/` | list | put the keyboard in the filter box |
| `←` `→` `backspace` `delete` `home` `end` `ctrl+u` | filter box | edit the words |
| `enter` | filter box | keep the words and hand the keyboard back to the list |
| `esc` | filter box | clear the words; a second `esc` closes the browser |
| `esc` | list | clear the filter, or close the browser when there are no words |
| `enter` | either | ask to import the selected session, then confirm |
| `r` | list | re-read the hub index |

#### Harness markers and colours

| Key | Marker | ASCII | Harness | Theme token | Why that colour |
| --- | --- | --- | --- | --- | --- |
| `1` | `π` | `P` | Pi | `success` | the harness this hub ships with; green for "yours" |
| `2` | `✻` | `C` | Claude Code | `warning` | Anthropic's own amber, the colour Claude Code wears |
| `3` | `⬡` | `X` | Codex | `info` | cool blue: Codex's own chrome, and its calm register |
| `4` | `⌘` | `O` | OpenCode | `accent` | you are inside OpenCode; `accent` is the host's "the thing you are looking at" token |
| `5` | `❯` | `R` | Crush | `secondary` | the contrasting hue in this theme, Crush's family |
| `6` | `◆` | `J` | JCode | `primary` | the theme's headline colour, for the other terminal-first agent |

Six harnesses, six different hues, on purpose: a two-line row has room for one
colour and it has to say *which agent* before the label is read. `error`,
`text`, `textMuted` and the three border tokens are deliberately not used for
harness identity, so a red line in this browser always means a failure and never
"that one is Crush". The rest of the palette:

| What | Token |
| --- | --- |
| the selected row | a `backgroundElement` block plus an `accent` bar on both of its lines |
| the focused pane's border, the caret in the filter box, `0 all` when no filter is on | `borderActive` / `accent` |
| the other pane's border, the rules and the "lines x-y of n" footer | `borderSubtle` |
| metadata: age, message count, project, uid, model | `textMuted` |
| a title, and the cost line | `text` |
| a hub call that failed, and a read-only index | `warning` |

A selected row keeps the foregrounds it has when it is not selected: the
selection is the background and the bar. `selectedListItemText` is the host's own
token for text on *its* selection background, and on this row's `backgroundElement`
it reads washed out next to the other rows.

Terminals without symbol coverage (no `π`, `✻`, `⬡`, `⌘`, `❯`, `◆`) get plain
letters instead, with the same colours and the same keys:

```bash
export SESSION_HUB_ASCII=1        # or PI_SESSION_HUB_ASCII=1, the older name
```

#### What the filter box searches

The box filters the rows already loaded, which makes it instant and free: title,
preview, project, model, uid and harness name, case-insensitively. If nothing
matches locally and you have typed three characters or more, the browser also
asks the hub to search every transcript on disk (after a 450 ms pause) and says
so in the header: `transcript search: 3 hit(s) over every project`. That path
reads the index; it never touches a model.

When there is nothing to show, the list says so and names the way out:
`nothing matches "foo"`, plus the reminder that `/hub foo` searches full
transcripts server-side. With a harness filter on it also says `press 0 to drop
the harness filter`.

#### The header

`50 of 50 shown · 8 project(s)` is what is on screen out of what is loaded, and
how many distinct projects those sessions come from. If the hub index cannot be
written in this environment, one more line appears: the results are real but they
are the last scan, not a fresh one. `r` re-reads the index; if that fails, the
failure is shown with the fix, and recorded in the log below.

The list and the preview cost nothing: the hub reads transcripts straight off
disk, no model is involved. The preview shows the metadata (harness, model, uid,
project, last activity), the cost of the import in messages and tokens, the head
of the exact package that would be imported, and the words `nothing sent yet`.

Confirming calls `sessionhub pick`. The record is written to
`~/.session-hub/pending.json` and a toast says it will arrive with your next
message. It does not arrive until then, and it never arrives twice.

### `/hub`

| Command | What it does |
| --- | --- |
| `/hub` | sessions for this project, across every agent |
| `/hub <words>` | search every transcript |
| `/hub load <uid>` | record the pick; the transcript is attached to that same message |
| `/hub pending` | what is waiting to be imported, and what it will cost |
| `/hub clear` | cancel a pending selection |
| `/hub reopen <uid>` | the verified command that reopens it in its own agent |

`/hub` is a real OpenCode command, registered through the plugin's `config`
hook, and it is filled in by `command.execute.before`. If your config already
defines a command called `hub`, yours wins.

### The tools

| Tool | When the model reaches for it |
| --- | --- |
| `sessionhub_find` | "what was I doing here yesterday", "pick up where we left off". No arguments: it looks at this project. Falls back to the newest sessions everywhere when the project has none, and says so. |
| `sessionhub_search` | "the session where we fixed the parser", "continue what I did in Codex". |
| `sessionhub_load` | "continue the work I left in another agent". Returns the real transcript inside a token budget. |
| `sessionhub_reopen` | "open that in Codex", "take me back to my Claude Code session". Returns the command; the model is told not to run it. |

`sessionhub_load` is the model's own path and returns the transcript in the tool
result. `/hub load` and the browser are the human paths: they record a pick, and
the transcript arrives with the next message. Both are explicit, and both show
the cost.

## What you will see

- **Browser opened by the keybind**: a full-screen list with a live preview of the
  import and its cost, then a confirmation dialog, then a toast.
- **`/hub`**: the list lands in the conversation as a message you can read and the
  model can act on.
- **`/hub load <uid>`**: a short confirmation, and the transcript in the same
  message.
- **Nothing found**: the error state names the fix. If the hub CLI is missing you
  get the setup steps, not a stack trace.

## How delivery works

The pending record is consumed by the `chat.message` hook, which appends the
imported block to the parts of the new user message. Those parts are what gets
written to the session store, so the block is still in front of the model on
every later step of the turn and is visible in the transcript.

`experimental.chat.messages.transform` is a backstop for the same delivery. It
only runs if `chat.message` never fired, and it refuses to inject a session whose
uid is already somewhere in the prompt, so the import cannot arrive twice.

Picks expire after two hours (`core/pending.ts`); an expired one is ignored
rather than injected.

## Diagnostics

Both halves append one line per notable event to:

```
~/.session-hub/opencode-plugin-loaded.log
```

It records the runtime, where the hub was found, when the `/hub` command was
registered, and every pick and delivery. It is capped at 64 KB and a failure to
write it is ignored. This file is the only thing this integration adds to the
hub's home.

## Type checking

`plugin.ts`, `tui.tsx` and `hub.ts` are checked with `tsc --strict`,
`--noUnusedLocals`, `--noUnusedParameters`, and the real OpenCode and OpenTUI
type definitions. The `tsconfig.json` needs absolute paths into a local OpenCode
install, so it is not committed; recreate it with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/solid",
    "strict": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "typeRoots": ["<path-to>/@types"],
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "@opencode-ai/plugin": ["<config>/node_modules/@opencode-ai/plugin/dist/index.d.ts"],
      "@opencode-ai/plugin/tui": ["<config>/node_modules/@opencode-ai/plugin/dist/tui.d.ts"],
      "@opencode-ai/sdk": ["<config>/node_modules/@opencode-ai/sdk/dist/index.d.ts"],
      "@opencode-ai/sdk/v2": ["<config>/node_modules/@opencode-ai/sdk/dist/v2/index.d.ts"],
      "solid-js": ["<config>/node_modules/solid-js/types/index.d.ts"],
      "solid-js/*": ["<config>/node_modules/solid-js/types/*"],
      "@opentui/solid": ["<config>/node_modules/@opentui/solid/index.d.ts"],
      "@opentui/solid/jsx-runtime": ["<config>/node_modules/@opentui/solid/jsx-runtime.d.ts"],
      "@opentui/solid/jsx-dev-runtime": ["<config>/node_modules/@opentui/solid/jsx-dev-runtime.d.ts"],
      "@opentui/solid/components": ["<config>/node_modules/@opentui/solid/components.d.ts"],
      "@opentui/core": ["<config>/node_modules/@opentui/core/index.d.ts"],
      "@opentui/keymap": ["<config>/node_modules/@opentui/keymap/src/index.d.ts"],
      "@opentui/keymap/extras": ["<config>/node_modules/@opentui/keymap/src/extras/index.d.ts"]
    }
  },
  "include": ["plugin.ts", "tui.tsx", "hub.ts", "scripts/resolve.d.mts"]
}
```

## What the root package.json must expose

OpenCode resolves an npm plugin spec with a plain `import()`, so the published
package has to name these two entry points. This is the only change the root
`package.json` needs, and it was left to the repo owner on purpose:

```json
{
  "exports": {
    ".": "./bin/sessionhub.mjs",
    "./integrations/opencode/plugin": "./integrations/opencode/plugin.ts",
    "./integrations/opencode/tui": "./integrations/opencode/tui.tsx",
    "./integrations/opencode/hub": "./integrations/opencode/hub.ts",
    "./package.json": "./package.json"
  }
}
```

Notes on that map:

- The three integration entries are needed so `session-hub/integrations/opencode/plugin`
  and `.../tui` resolve. Without an `exports` map at all, OpenCode would fall
  back to plain file resolution, which works too, but an explicit map is safer
  once the package is published.
- `"."` and `"./package.json"` are there so adding `exports` does not break
  anything that already resolves the root or reads its metadata. An `exports` map
  is exclusive: any subpath not listed becomes unreachable from outside the
  package, including `bin/sessionhub.mjs`.
- Keep `"files"` including `integrations` (it already does).
- The root `package.json` is currently `"private": true`, so the npm route needs
  that removed as well. Until then the file-path install above is the only one
  that works, and it is what this integration was verified against.

## Notes on the runtime

- OpenCode loads plugins with Bun. The hub core opens its index with
  `node:sqlite`, which Bun's shim does not provide, so `hub.ts` shells out to the
  CLI with a real Node. Under Bun, `process.execPath` is the OpenCode binary
  itself, which is why `hub.ts` picks the interpreter itself instead of using
  `runHub` from `scripts/resolve.mjs`. Resolution still comes from that file.
- A plugin loaded by path cannot resolve `@opencode-ai/plugin` or `zod`, so the
  tool definitions in `plugin.ts` are hand-written with a plain JSON Schema
  property map in `args`. OpenCode accepts that shape and marks every declared
  property as required, so each description says what to pass and the code clamps
  and defaults anything missing.
- The TUI half imports `solid-js` and `@opentui/solid`; OpenCode rewrites those
  two specifiers for TUI plugins, and nothing else.

## What was verified on this machine

Observed, not assumed. OpenCode 1.18.30, plugin running on Bun 1.3.14.

- **The server half loads and registers, with no model turn involved.** A scratch
  project whose `opencode.json` points at this directory:
  `opencode debug config` resolves it and reports the registered command
  (`name: hub`, the description and the template), and the trace file records
  `plugin loaded · runtime: bun 1.3.14 · execPath: …/bin/opencode · hub: …` and
  `registered the /hub command`. Against `opencode serve`,
  `/experimental/tool/ids` lists `sessionhub_find`, `sessionhub_search`,
  `sessionhub_load`, `sessionhub_reopen`, and `/experimental/tool` shows the
  derived JSON Schema for each.
- **The `/hub` command runs.** `POST /session/{id}/command` with
  `{"command":"hub"}` produced a user message containing the real session list for
  the project plus the command help. `{"command":"hub","arguments":"load <uid>"}`
  produced the pick confirmation *and* the imported transcript in that same
  message, and the trace records `delivered claude-code:… (~322 tokens)`.
- **Delivery is exactly once.** With a pick recorded, the next message carried the
  block (`Source: <uid>` present in the persisted part); the message after it was
  clean.
- **The browser renders and works.** Driven through a real pty: the keybind
  opened the route, which listed 50 real sessions from every harness with marker,
  harness, age, message count and project, and the preview of the selected one
  with its metadata, its cost in messages and tokens, the words `nothing sent yet`
  and the head of the package; the selection moved, `tab` moved the focus to the
  preview, `esc` cleared the filter and a second `esc` left. `enter` raised the
  confirmation dialog with the measured cost; the second `enter` recorded the pick
  (trace: `browser picked … (40000 chars)`) and wrote `~/.session-hub/pending.json`.
- **The browser was driven headlessly, key by key, on the runtime OpenCode uses.**
  `@opentui/solid`'s test renderer, on the embedded Bun
  (`BUN_BE_BUN=1 opencode --conditions=browser`), against a build of this file made
  with the same babel transform OpenCode applies, checking the captured frames and
  colour spans: the lazy load (no hub call before the route is opened), the header
  counts, the selection and its accent bar, `1`-`6` and `0` filtering the list, the
  filter box typing and its honest empty state, the debounced transcript search,
  both `esc` presses, `tab`, the two-pane layout at 110x32 and the one-pane
  fallback at 80x24 and 60x20 with nothing drawn past the last row, and each
  harness marker wearing the token the table above promises (`π` `success`, `✻`
  `warning`, `⬡` `info`, `⌘` `accent`, `❯` `secondary`, `◆` `primary`). Every check
  passed.
- **The CLI bridge works through the same module both halves use.** `hub.ts` was
  imported directly and `findSessions`, `contextFor`, `nativeResume`,
  `pickSession`, `peekPending`, `takePending` and `clearPending` all returned real
  data; a second `takePending` returned nothing, which is the exactly-once
  guarantee.
- **Type checking is clean** under `tsc --strict --noUnusedLocals
  --noUnusedParameters` against the real OpenCode and OpenTUI definitions, with a
  negative control confirming that JSX props and API calls are genuinely checked.

**Not verified**, and not claimed: `ctrl+shift+h` itself, which a terminal without
kitty keyboard reporting cannot send at all (`alt+h` is the key that was driven);
the mouse, which this view does not bind; and how the palette entry behaves when
another plugin has already taken the `sessionhub.*` command names. To see the
browser yourself:

```
opencode
# then press alt+h, or ctrl+shift+h, or ctrl+p and pick
# "session-hub: browse sessions from your other agents"
```

If the list is empty or the key does nothing, `~/.session-hub/opencode-plugin-loaded.log`
and `sessionhub doctor` are the two places that say why.
