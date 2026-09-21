<div align="center">

<img src="./assets/opencode-hub.png" alt="session-hub inside OpenCode: 18 sessions from Pi, Claude Code, Codex, OpenCode, Crush and JCode in one list, each with its own colour and marker, next to a preview of the conversation that would be imported. Below the list, the keys: up/down move, tab preview, enter import, / search, 1-6 harness, 0 all, r reload, esc back." width="880">

# session-hub

**One list for every coding agent on your machine. Continue in this one the work you left in that one.**

[![Node](https://img.shields.io/badge/node-%3E%3D22.5-1f8f4d)](package.json)
[![License](https://img.shields.io/badge/license-MIT-f5a623)](LICENSE)

</div>

`session-hub` finds the conversations your other coding agents left behind and puts
them back in reach: one list of every agent's sessions, a preview that costs
nothing, and one key to bring a conversation into the chat you are in.

- **See every agent in one list.** Pi, Claude Code, Codex, OpenCode, Crush and
  JCode sessions, each row labelled with its agent, project, age and size.
- **Continue work that started elsewhere.** Pick a session and its conversation
  arrives in this one, tiered and budgeted, so the next thing you type already has
  the context you would otherwise have to re-explain.
- **Read without spending tokens.** The browser previews any session straight off
  disk, with no model involved.
- **Reopen it where it lives.** `codex resume <id>`, `claude --resume <id>`, the
  command and the evidence for it shown before anything runs.
- **Stay local and read-only.** Nothing outside `~/.session-hub/` is ever written,
  and no external session is ever disguised as one of your own.

## Package facts

| Fact | Value |
| --- | --- |
| Package | `session-hub` |
| Installs into | Claude Code, Codex, OpenCode |
| Reads sessions from | Pi, Claude Code, Codex, OpenCode, Crush, JCode |
| Runtime | Node 22.5 or newer |
| Runtime dependencies | none (uses the built-in `node:sqlite` with FTS5) |
| Installer | `./install.sh`, `./install.ps1`, or `node bin/sessionhub.mjs install` |
| Verified | 108 checks, green (see [what has been verified](#what-has-actually-been-verified)) |

## Why use it?

| You want to... | Use this because... |
| --- | --- |
| Continue what you were doing in another agent | Pick the session and its conversation arrives here, with the objective, the recent turns verbatim and the cost printed |
| Find the session where you solved something | `sessionhub search "words"` covers every agent's titles and a bounded excerpt of the conversation, and `search --deep` reads full transcripts when that is not enough |
| Read an old conversation for free | The browser and `sessionhub show` read from disk, no model involved |
| Go back to where that work lives | `sessionhub native <uid>` prints the verified resume command for the agent that owns the session, or refuses when there is none |
| Keep your history private | The index is local, credential stores are never opened, and no transcript leaves the machine |

## Install

### One command, and it asks where

From a checkout:

```bash
./install.sh              # Linux, macOS
.\install.ps1             # Windows
```

Or call the installer directly:

```bash
node bin/sessionhub.mjs install
```

It finds the agents on your `PATH`, shows their versions, and **asks which ones you
want session-hub in**. Nothing is installed in an agent you did not pick. Then it:

1. stages the hub in `~/.session-hub/src`, so nothing depends on where the code came
   from and a moved checkout cannot break an installed plugin;
2. installs into your choices;
3. links `sessionhub` into `~/.local/bin` (it says the `export PATH` line if that
   directory is not on your `PATH`);
4. writes Codex's delivery hooks and asks before setting `bypass_hook_trust`, the
   one thing Codex cannot do for itself (see [Trust](#trust-in-codex)).

For scripts, where there is nobody to ask:

```bash
node bin/sessionhub.mjs install --only codex --json
node bin/sessionhub.mjs install --all --dry-run
```

`--dry-run` prints every command it would run and changes nothing.

### Per agent, by hand

```text
# Claude Code
/plugin marketplace add /path/to/session-hub
/plugin install session-hub@session-hub

# Codex
codex plugin marketplace add /path/to/session-hub
codex plugin add session-hub@session-hub

# OpenCode
opencode plugin /path/to/session-hub/integrations/opencode -g
```

These are also command line entry points, so nothing here needs a TUI:

```bash
claude plugin marketplace add /path/to/session-hub
claude plugin install session-hub@session-hub
```

### Just the tools, no plugin

If you would rather not install a plugin, register the MCP server yourself. The
tools are named `search`, `context` and `native`, and they are all read-only:

```bash
claude mcp add session-hub -- node /path/to/session-hub/mcp/server.mjs
codex  mcp add session_hub -- node /path/to/session-hub/mcp/server.mjs
```

You get the tools in every session. You lose two things: the automatic delivery of
a session you picked, and the skill that tells the agent when to go looking.

## How it works in each agent

The hub underneath is the same everywhere: one binary reads every agent's session
store read-only, indexes it locally, and turns the session you choose into a
context package. What differs is how you reach for it and how the conversation
arrives.

### OpenCode

OpenCode is the only one of the three with an API for a real terminal UI, so this
is where the browser lives. That is the screenshot at the top of this page.

| | |
| --- | --- |
| What you install | one plugin in two halves: tools and `/hub` in the conversation, plus the browser |
| How you open it | `ctrl+shift+h`, or `alt+h`, or `ctrl+p` then *session-hub: browse sessions from your other agents* |
| The tools | `sessionhub_find`, `sessionhub_search`, `sessionhub_load`, `sessionhub_reopen` |
| In the conversation | `/hub` lists this project, `/hub <words>` searches every transcript, `/hub load <uid>`, `/hub pending`, `/hub reopen <uid>`, `/hub clear` |
| How the conversation arrives | a pick is handed to `chat.message`, so it reaches the model with your next message, once |
| Manual step | none |

### Claude Code

| | |
| --- | --- |
| What you install | a plugin: one skill, two hooks, one MCP server named `hub` |
| How you ask | in plain language. *"continue what I left in Codex"*, *"the session where we fixed the parser"*. The skill teaches the model when to reach for the tools |
| The tools | `mcp__plugin_session-hub_hub__search`, `…__context`, `…__native` |
| How the conversation arrives | `context` brings it in during that turn, or you pick one with `sessionhub pick <uid>` and the `UserPromptSubmit` hook delivers it with your **next** message as `additionalContext` |
| Manual step | none |
| Detail | the injected block is capped at 9,600 characters, because Claude Code cuts a hook's context at 10,000 |

### Codex

| | |
| --- | --- |
| What you install | a plugin: one skill, one MCP server, and two hooks |
| How you ask | the same plain language. The tools appear as `hub.search`, `hub.context`, `hub.native` |
| How the conversation arrives | the same two paths: `context` for this turn, or a pick delivered by the `UserPromptSubmit` hook |
| Manual step | **trust the hooks once**, in `/hooks`. The installer offers to set `bypass_hook_trust` instead, and explains what that means |
| Detail | the tools declare themselves read-only, so Codex's approval policy has what it needs; and Codex runs commands under a sandbox, so the hub reads an index it is not allowed to rewrite |

#### Trust in Codex

Codex refuses to run a hook it has not been told to trust, and trusting happens in
its `/hooks` dialog, which cannot be driven from a script. Two ways out:

1. Run `/hooks` once and trust the two session-hub entries. This is the default,
   and the installer leaves it to you.
2. Let the installer set `bypass_hook_trust = true` in `~/.codex/config.toml`. It
   asks first, because that line applies to **every** hook in that file, not only
   these. `--trust-hooks` and `--no-trust-hooks` answer it in advance, and
   `node integrations/codex/scripts/install-hooks.mjs --no-trust` removes it again.

Until the hooks run, the tools and the skill still work: you can load a session
by asking for it. What you lose is a pick arriving on its own.

## Using it

### The browser (OpenCode)

| Key | What it does |
| --- | --- |
| `↑` `↓`, `k` `j` | move the selection, the preview follows |
| `PageUp` `PageDown` | move five at a time |
| `Home` `End` | first or last session |
| `Tab` | switch between the list and the preview |
| `Enter` | import the selected session |
| `/` | search the loaded list; `Enter` keeps the filter, `Esc` clears it |
| `1`–`6` | filter by agent (`1` Pi, `2` Claude Code, `3` Codex, `4` OpenCode, `5` Crush, `6` JCode) |
| `0` | clear the agent filter |
| `r` | re-read the hub index |
| `Esc` | leave the browser |

Each agent has its own marker and its own colour, `π` Pi, `✻` Claude Code, `⬡`
Codex, `⌘` OpenCode, `❯` Crush, `◆` JCode, so a row says which agent it belongs to
before you read the label. Set `SESSION_HUB_ASCII=1` for plain letters on a
terminal whose font has no symbol coverage, and `SESSION_HUB_KEYBIND` to change
the key that opens the browser.

The list and the preview cost nothing: the hub reads transcripts straight off disk,
no model is involved. The preview shows the head of the exact package that would be
imported, at the budget that will be used, so the number you see is the number you
pay.

### In the chat

Ask in plain language. The skill tells the agent when the hub is worth reaching
for, and the agent decides between loading the context now or arming a pick for
your next message. You can also be direct:

```text
/hub                                  # sessions of this project, every agent
/hub turnero urgencias                # search every transcript
/hub load codex:0191ab…               # import it, delivered with the next message
```

## How much context arrives

Loading a whole conversation would be wasteful, and the cost would grow without
bound as sessions get longer. The package is therefore **tiered, with a hard
budget** (40k characters, about 10k tokens, by default):

| Tier | Contents | Cost |
| --- | --- | --- |
| 1. Header | objective, repo, model, files changed and read, commands run, tool usage | ~1k characters, always included |
| 2. Recent tail | the last turns **verbatim**, because that is what you continue from | up to 26k characters |
| 3. Earlier | one line per older message, so the shape of the conversation survives | remainder |
| 4. Omitted | a count, never silence | 0 |

Two decisions make that affordable: tool output is compressed to a short preview in
every tier (measured on real sessions, it was 90% of the bytes and the least useful
part for resuming work), and when the budget runs out the **oldest** messages
condense or drop, never the tail. The cost is printed every time, and `--chars`
sets the ceiling.

## Commands

```
sessionhub here [--dir D]              sessions of the project you are standing in, every agent
sessionhub list [--harness H]          newest first, across everything
sessionhub search "words"              find sessions
sessionhub search "words" --deep       read full transcripts when the index is not enough
sessionhub context <uid> [--chars N]   the tiered, budgeted package
sessionhub show <uid>                  the transcript, read-only, no model involved
sessionhub handoff <uid>               a deterministic handoff document
sessionhub native <uid>                the verified resume command, or a refusal
sessionhub pick <uid>                  choose a session to arrive with your next message
sessionhub pending [--take|--peek|--clear]   what is armed: print it, peek, or cancel
sessionhub doctor                      which agents were found, how many sessions each
sessionhub index [--force]             rebuild the local index
sessionhub install [--only|--all]      install into the agents you choose
sessionhub setup | vendor | version
```

Every command takes `--json`, prints only payload on stdout and diagnostics on
stderr, so `sessionhub context <uid>` can be piped straight into a prompt. A `uid`
is `<agent>:<nativeId>`, and a unique prefix is enough.

## The two rules

### Nothing outside the hub home is written

The only writable path is `~/.session-hub/` (the index, the armed selection, the
install record). Every agent's store is opened read-only, including the SQLite
databases. The acceptance suite fingerprints every store before and after a full
scan, and fails if anything changed.

### External sessions are never disguised as yours

A Claude, Codex, OpenCode, Crush or Pi conversation is **never** converted into
another agent's session format. There are exactly two paths:

- **Reopen it where it lives**: the hub prints the command that the owning agent
  understands, states how it verified that command, and refuses when it has no
  verified command rather than handing you one that would fail.
- **Import its context here**: the conversation arrives in a new message labelled
  with the source agent, session id and path, generated locally and
  deterministically. No model, no network, nothing uploaded. Fields the source
  format cannot supply are written as `not available` rather than guessed.

## Supported agents

| Agent | Store | Format | Resume |
| --- | --- | --- | --- |
| Pi | `~/.pi/agent/sessions/--<cwd>--/*.jsonl` | JSONL tree v3 | `pi --session <path>` |
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` | JSONL (undocumented) | `claude --resume <uuid>` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL (undocumented) | `codex resume <id>` |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite | `opencode --session <id>` |
| Crush | `~/.crush/crush.db` | SQLite | `crush --session <id>` |
| JCode | `~/.jcode/sessions/*.json` | JSON | `jcode --resume <id>` |

Each agent gets its own adapter. A missing, empty or unreadable store degrades to a
specific message ("no store at ...", "cannot read ...") instead of an empty list,
and one broken adapter never takes down the others. Adding an agent means adding
one file under `core/adapters/` and one directory under `integrations/`.

## Search

`sessionhub search` and the browser's full-transcript path use a local SQLite FTS5
index:

- bare terms use prefix matching, so `pliego` matches `pliego-prod`
- `"exact phrase"` matches a phrase
- `-term` excludes

The index stores each session's title, metadata and a bounded excerpt of the
conversation (20k characters, sampled from both the start and the end).
`search --deep` goes further and reads whole transcripts when the excerpt is not
enough; it reports how many sessions it read, so a partial answer never looks
complete.

## Privacy

- The index lives at `~/.session-hub/index.sqlite`. Delete it and the next scan
  rebuilds it.
- Credential stores are never opened. `auth.json`, `.credentials.json`, `.env`,
  `request_dump_*` and similar are refused by name before any open is attempted.
- Transcript text passes through a redactor (bearer tokens, `sk-` keys, JWTs,
  `api_key=` and `password=` patterns) before it is stored or written into a
  handoff.
- No network access, ever, for indexing or searching.

## Architecture

```
bin/sessionhub.mjs   launcher (Node 22.5+ without a build step)
bin/cli.ts           the command line, the whole product surface
core/adapters/       one read-only adapter per agent
core/index/          local SQLite + FTS5 index, incremental scan
core/context.ts      tiered, budgeted transcript context
core/handoff.ts      deterministic handoff document
core/native.ts       verified resume commands, never guessed
core/pending.ts      the explicit selection
core/install.ts      how an installed plugin finds the hub
core/install-harnesses.ts  one-command install per agent
mcp/                 stdio MCP server: search, context, native
integrations/claude/ Claude Code plugin: skill, hooks, .mcp.json, marketplace
integrations/codex/  Codex plugin: skill, hooks, MCP, plus the hook installer
integrations/opencode/  OpenCode plugin: tools, /hub, and the browser
install.sh, install.ps1, install.mjs   the entry points users run
test/acceptance.mjs  the suite that holds the promises above
tools/make-demo-image.mjs  regenerates the screenshot at the top
```

## What has actually been verified

Claims on this page are tied to observed runs, not to what the docs imply:

| Area | Verified here |
| --- | --- |
| Core, CLI, MCP | 108 checks green against the real stores on this machine, including that a full scan creates no hub artifact outside its home, that a context package stays inside its budget and accounts for every message, that a selection is delivered exactly once, and that a foreign home built from copies is read without changing a byte |
| OpenCode | a real turn found the right session and quoted a distinctive method name from its transcript; a pick arrived in the next message and the model quoted the injected block; the browser loads in a real PTY, which is how the screenshot at the top was made |
| Claude Code | `claude plugin validate` passes, also with `--strict`; the plugin's components register (1 skill, 2 hooks, 1 MCP server); the hook emits the picked session once and nothing afterwards; the plugin's MCP server answers and registers as `Connected` |
| Codex | `codex plugin marketplace add` and `plugin add` install from this checkout; `codex mcp list` resolves the `hub` server from the plugin cache; a real `codex exec` turn called `hub.search` and quoted the injected block |
| Codex, after the latest fixes | the read-only annotations, the sandbox fallback and the hook trust override were each verified in isolation; a live Codex turn has not run again since, because the account hit its usage limit mid-audit |
| Claude Code, live turn | **not verified**: this machine's Claude Code cannot authenticate headlessly (`OAuth session expired`), so the interactive flow is the one thing left to a person |

## Limitations

- **Claude Code and Codex formats are undocumented.** The parsers are defensive and
  degrade to filename-derived metadata rather than throwing, but a format change
  can cost fields until the adapter is updated.
- **Crush does not record a session working directory**, so those sessions show no
  project and cannot be filtered by one.
- **Claude sub-agent transcripts** are indexed but cannot be resumed by id; the hub
  refuses instead of offering a command that would fail.
- **Search covers a bounded excerpt**, not the whole history of a very long
  session. `--deep` is the way past that.
- **In a sandbox that denies writes** (Codex runs commands under one by default) the
  hub cannot rescan, and says so. Searches and context still answer from the last
  scan: the index is read read-only, or from a disposable copy in the temp
  directory when SQLite needs write access to a WAL sidecar.
- **Installed plugins use the staged copy** at `~/.session-hub/src`, not your
  checkout. After changing the code, run the installer again to restage it.
- **The screenshot** is a real capture from a synthetic home: invented projects and
  invented conversations, so it shows off six agents at once without being anybody's
  history.

## Development

```bash
node test/acceptance.mjs        # the full suite against the real stores and a foreign home
node tools/make-demo-image.mjs  # regenerate the screenshot (drives OpenCode in a real PTY)
python3 test/tools/screen.py <capture>   # what was on screen, from a raw ANSI capture
```

The suite runs against the stores on this machine and against a synthetic home this
project has never seen, and asserts among other things that no external store file
is modified, that every resume command is verified or refused, and that reading a
home with no agents says so instead of looking empty.

`docs/demo.md` documents how the image is produced and the pitfalls of driving a
full-screen TUI in a PTY.

## License

MIT
