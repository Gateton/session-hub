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
| `alt+h` | everywhere, including terminals that do not report shifted keys |
| `ctrl+shift+h` | terminals that do (kitty keyboard protocol) |

Both open the browser. `ctrl+shift+h` is the nicer one when your terminal can
send it; `alt+h` is the one that always works, because a terminal that cannot
report `shift` turns `ctrl+shift+h` into a plain `ctrl+h`, which OpenCode has no
binding for. Neither key is used by OpenCode's own defaults.

The browser is also reachable from the command palette (`ctrl+p`) as
**session-hub: browse sessions from your other agents**, and there is a second
palette entry, **session-hub: what is waiting to be imported**.

### The browser

```
 session-hub
 12 session(s) for this project, newest first

 ▸ jcode:session_turkey_1790003705265_57c611274d4b11e1
     JCode · 2m ago · 449 messages · /home/gateton
     que tan factible es hacer esta misma extension pero para claude code?
   codex:01a0c4cd-79e2-7123-8c68-f1b2e447ba98
     Codex · 8m ago · 5 messages · /home/gateton
     que fue lo ultimo que hable con jcode?

 ─────────────────────────────────────────────────────────
 importing 19/77 message(s) · ~1,560 tokens (6,241 characters) · nothing sent yet
 # Imported Session Context
 - Source harness: JCode
 ...

 up/down move · enter import · / filter · r reload · esc back
```

| Key | What it does |
| --- | --- |
| `up` / `down`, `k` / `j` | move the selection; the preview follows |
| `pageup` / `pagedown` | move five at a time |
| `enter` | ask to import the selected session, then confirm |
| `/` | filter: words to search every transcript, empty for this project |
| `r` | re-read the hub index |
| `escape` | back to your session |

The list and the preview cost nothing: the hub reads transcripts straight off
disk, no model is involved. The preview shows the head of the exact package that
would be imported, at the budget that will be used, so the number you see is the
number you pay.

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
- **The browser renders and works.** Driven through a real pty with a terminal
  emulator: the keybind opened the route, which listed 25 real sessions from all
  six harnesses with harness, age, message count and repo; moving the selection
  updated the preview (the cost line and the head of the package that would be
  imported); `enter` raised the confirmation dialog with the measured cost; the
  second `enter` recorded the pick (trace: `browser picked … (40000 chars)`) and
  wrote `~/.session-hub/pending.json`.
- **The CLI bridge works through the same module both halves use.** `hub.ts` was
  imported directly and `findSessions`, `contextFor`, `nativeResume`,
  `pickSession`, `peekPending`, `takePending` and `clearPending` all returned real
  data; a second `takePending` returned nothing, which is the exactly-once
  guarantee.
- **Type checking is clean** under `tsc --strict --noUnusedLocals
  --noUnusedParameters` against the real OpenCode and OpenTUI definitions, with a
  negative control confirming that JSX props and API calls are genuinely checked.

**Not verified**, and not claimed: how the browser looks in a real terminal
(colours, exact widths, and `scrollbox` behaviour on a very short terminal); the
`/` filter prompt, `r`, and `escape`, which the harness did not drive; and the
`ctrl+shift+h` binding, which a terminal without kitty keyboard reporting cannot
send at all. To see the browser yourself:

```
opencode
# then press alt+h, or ctrl+shift+h, or ctrl+p and pick
# "session-hub: browse sessions from your other agents"
```

If the list is empty or the key does nothing, `~/.session-hub/opencode-plugin-loaded.log`
and `sessionhub doctor` are the two places that say why.
