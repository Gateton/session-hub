<div align="center">

<img src="https://raw.githubusercontent.com/Gateton/session-hub/main/assets/opencode-hub.png" alt="session-hub inside OpenCode: sessions from Pi, Claude Code, Codex, OpenCode, Crush and JCode in one list, each with its own colour, next to a preview of the conversation that would be imported" width="880">

# session-hub

**Continue the work you left in another coding agent.**

Find a session from Codex, OpenCode, Claude Code, Crush, JCode or Pi, bring its
conversation into the agent you are using right now, and keep going without
re-explaining anything.

[![npm](https://img.shields.io/npm/v/session-hub?label=npm)](https://www.npmjs.com/package/session-hub)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-1f8f4d)](package.json)
[![License](https://img.shields.io/badge/license-MIT-f5a623)](LICENSE)

</div>

You were debugging the payment retry logic in Codex yesterday. Today you are in
Claude Code, and the fastest way to explain what happened is to stop explaining
it:

```
sessionhub here                 # every session of this project, in any agent
sessionhub context codex:0191ab…  # load that conversation into this one
```

Or, inside the agent, just ask: *"continue what I left in Codex"*. The agent has
the tools to find it and load it.

## What it actually does

| You want to | Use |
|---|---|
| See what you were doing in this project, in any agent | `sessionhub here` |
| Find the session where you solved something | `sessionhub search "retry logic"` |
| Continue that work here, without re-explaining it | `sessionhub context <uid>` or the `context` tool |
| Read an old conversation for free, no model involved | `sessionhub show <uid>` |
| Go back to where that work lives | `sessionhub native <uid>` |
| Have the agent do all of this itself | the `search`, `context` and `native` MCP tools |

## How the context arrives

Loading a whole conversation would be wasteful and would grow without bound, so
the context is **tiered with a hard budget** (40k characters, about 10k tokens,
by default):

| Tier | Contents |
|---|---|
| Header | objective, repo, model, files changed and read, commands run |
| Recent tail | the last turns **verbatim**, because that is what you continue from |
| Earlier | one line per older message, so the shape of the conversation survives |
| Omitted | a count, never silence |

Tool output is compressed to a preview in every tier: measured on real sessions,
it was 90% of the bytes and the least useful part for resuming work. When the
budget runs out, the **oldest** messages condense or drop, never the tail. The
cost is printed every time, and `--chars` sets the ceiling.

## Install

### One command, and it asks you where

```bash
curl -fsSL https://raw.githubusercontent.com/Gateton/session-hub/main/install.sh | bash
irm https://raw.githubusercontent.com/Gateton/session-hub/main/install.ps1 | iex   # Windows
```

From a checkout, the same thing with no downloading:

```bash
./install.sh              # Linux, macOS
.\install.ps1             # Windows
```

The installer finds the agents you have on `PATH` (Claude Code, Codex, OpenCode),
shows their versions, and **asks which ones you want session-hub in**. Nothing is
installed in an agent you did not pick. It then stages the hub in
`~/.session-hub/src`, so nothing depends on where the code came from, installs
your choices, wires Codex's delivery hooks, and prints the one step it cannot do
for you: Codex asks you to trust those hooks once, in `/hooks`.

For scripts and CI, where there is nobody to ask:

```bash
./install.sh --only codex --json
./install.sh --all --dry-run
```

With no `--only` and no `--all` in a non-interactive shell, it prints what to pass
instead of guessing.

### Optional: from npm

Once the package is published, the installer is one line with no clone, and the
tools can be registered without any plugin at all:

```bash
npx -y session-hub install                                    # the whole thing
claude mcp add session-hub -- npx -y session-hub mcp           # tools only
codex  mcp add session-hub -- npx -y session-hub mcp           # tools only
```

### Just the tools, no plugin

If you would rather not install a plugin, register the MCP server yourself:

```bash
claude mcp add session-hub -- npx -y session-hub mcp
codex  mcp add session-hub -- npx -y session-hub mcp
```

You get `search`, `context` and `native` in every session. You lose two things:
the automatic delivery of a session you picked, and the skill that tells the agent
when to go looking. OpenCode takes the same server through the `mcp` block of its
config, or the plugin below.

### Through each harness's own plugin manager

```text
# Claude Code
/plugin marketplace add Gateton/session-hub
/plugin install session-hub@session-hub

# Codex
codex plugin marketplace add Gateton/session-hub
codex plugin add session-hub@session-hub

# OpenCode
opencode plugin /path/to/session-hub/integrations/opencode -g   # or the npm name, once published
```

`/path/to/session-hub` is the directory you cloned into, a real path rather than a
placeholder to paste verbatim.

Each plugin is self-contained: Claude Code copies a plugin into its own cache, so
on first run it vendors the hub into itself and then resolves through its own
copy. Nothing else needs to be installed.

## How it works in each agent

The hub is the same everywhere: one binary reads every agent's session store
read-only, indexes it locally, and turns the session you choose into a context
package. What differs is how you reach for it and how the conversation arrives.

### Claude Code

| | |
|---|---|
| What you install | a plugin: one skill, two hooks, one MCP server named `hub` |
| How you ask | in plain language. *"continue what I left in Codex"*, *"the session where we fixed the parser"*. The skill teaches the model when to reach for the tools |
| The tools | `mcp__plugin_session-hub_hub__search`, `…__context`, `…__native` |
| How the conversation arrives | `context` brings it in during that turn, or you pick a session with `sessionhub pick <uid>` and the `UserPromptSubmit` hook delivers it with your **next** message as `additionalContext` |
| Manual step | none |
| Detail | the injected block is capped at 9,600 characters, because Claude Code cuts a hook's context at 10,000 |

### Codex

| | |
|---|---|
| What you install | a plugin: one skill, one MCP server, and two hooks |
| How you ask | the same plain language; the tools appear as `hub.search`, `hub.context`, `hub.native` |
| How the conversation arrives | the same two paths: `context` for this turn, or a pick delivered by the `UserPromptSubmit` hook |
| Manual step | **trust the hooks once**, in `/hooks`. The installer asks whether to do that for you by writing `bypass_hook_trust = true` instead, and explains what that means |
| Detail | the tools declare themselves read-only, which is the annotation Codex's approval policy reads before deciding whether to ask; and Codex runs commands under a sandbox, which is why the hub can answer from an index it is not allowed to rewrite |

### OpenCode

| | |
|---|---|
| What you install | a plugin in two halves: tools and `/hub` in the conversation, plus a browser in the terminal |
| How you ask | `ctrl+shift+h` or `alt+h` opens the browser; `/hub` lists or searches in the conversation; `/hub load <uid>`, `/hub pending`, `/hub reopen <uid>`, `/hub clear` |
| The tools | `sessionhub_find`, `sessionhub_search`, `sessionhub_load`, `sessionhub_reopen` |
| How the conversation arrives | a pick is handed to `chat.message`, so it reaches the model with your next message and never twice |
| Manual step | none |
| Detail | OpenCode is the only agent with an API for a real terminal UI, so this is where the browser lives: per-harness colours, a live filter, a preview that costs no tokens |

In all three, the same rule holds: **you choose the session and you see the cost**.
Nothing is imported behind your back, and a session that belongs to another agent
is never converted into this one's format.

### What has actually been verified

Claims here are tied to observed runs, not to what the docs imply:

| Harness | Verified here |
|---|---|
| Core, CLI, MCP | 80 checks green, against the real stores on this machine |
| Claude Code | `claude plugin validate` passes (plugin, `--strict`, marketplace, skills); the hook emits the picked session as `additionalContext` once and nothing afterwards; the plugin's MCP server answers `initialize` and `tools/list`; a copied plugin vendors itself once and resolves through its own copy with no hub elsewhere |
| Codex | `codex plugin marketplace add` + `plugin add` install from this checkout; `codex mcp list` resolves the `hub` server from the plugin cache; the hook delivers the picked session once; a live `codex exec` turn called `hub.search` and quoted the injected block verbatim |
| OpenCode | See `integrations/opencode/README.md` for what was and was not exercised |
| Claude Code, live turn | **Not verified**: this machine's Claude Code cannot authenticate headlessly (`OAuth session expired`), so the interactive flow is the one thing left to a human |
| Codex, after the latest fixes | the read-only annotations, the sandbox fallback and the hook trust override were verified in isolation, but a live Codex turn has not run again since (the account hit its usage limit mid-audit). OpenCode was verified in a real turn, delivery included |

## Commands

```
sessionhub here [--dir D]              sessions of this project, every harness
sessionhub list [--harness H]          newest first, across everything
sessionhub search "words" [--harness H]
sessionhub context <uid> [--chars N]   the budgeted context package
sessionhub show <uid>                  the transcript, read-only, no model
sessionhub handoff <uid>               a deterministic handoff document
sessionhub native <uid>                the verified resume command, or a refusal
sessionhub pick <uid>                  choose a session to arrive next message
sessionhub pending [--take|--peek|--clear]
sessionhub doctor                      which harnesses were found, how many
sessionhub index [--force]             rebuild the local index
sessionhub setup | vendor --into <dir>
```

Every command takes `--json`, prints only payload on stdout and diagnostics on
stderr, so `sessionhub context <uid>` can be piped straight into a prompt. A
`uid` is `<harness>:<nativeId>`, and a unique prefix is enough.

## Explicit, not magic

Nothing is imported behind your back. You pick a session, the hub records that
choice, and the harness delivers it with your next message: one selection at a
time, consumed exactly once, ignored if it is more than two hours old.

## Privacy and safety

- **The only writable path is `~/.session-hub/`** (index, pending selection,
  install record). Override with `SESSION_HUB_HOME`.
- Every external store is opened **read-only**, including the SQLite databases.
- Credential stores are refused by name before any open is attempted.
- Transcript text is redacted for tokens, keys and JWTs before it is stored or
  written into a handoff.
- No network access, ever. Nothing is uploaded.
- Sessions are **never** converted into another harness's format. Either you load
  the conversation here, or you are given the command that reopens it there.

## Architecture

```
bin/sessionhub.mjs   launcher (works on Node 22.5+ without a build step)
bin/cli.ts           the command line, the whole product surface
core/adapters/       one read-only adapter per harness
core/index/          local SQLite + FTS5 index, incremental scan
core/context.ts      tiered, budgeted transcript context
core/handoff.ts      deterministic handoff document
core/native.ts       verified resume commands, never guessed
core/pending.ts      the explicit selection
core/install.ts      how an installed plugin finds the hub
mcp/                 stdio MCP server: search, context, native
integrations/        one thin shell per harness
test/acceptance.mjs  the suite that holds the promises above
```

Adding a harness is one file under `core/adapters/` plus a registration, and then
one directory under `integrations/`.

## Limitations

- **Claude Code and Codex session formats are undocumented.** Parsers are
  defensive and degrade to filename-derived metadata rather than throwing, but a
  format change can cost fields until the adapter is updated.
- **Crush does not record a session working directory**, so those sessions show
  no project.
- **Claude sub-agent transcripts** are indexed but cannot be resumed by id; the
  hub refuses instead of handing you a command that would fail.
- **Search covers a bounded excerpt** (20k characters sampled from the start and
  the end of each conversation), not the entire history of a very long session.
- Reading a WAL-mode SQLite database can update its `-shm` sidecar. That file
  holds no session data; the database itself is never modified.
- **In a sandbox that denies writes** (Codex runs commands under one by default),
  the hub cannot rescan and says so. Searches and context still work from the last
  scan: the index is read read-only, or from a copy in the temp directory when
  SQLite needs write access to a WAL sidecar.
- **Installed plugins use the staged copy**, not your checkout. After changing the
  code, run the installer again to restage it.

## Development

```bash
node test/acceptance.mjs    # the full suite, against real stores plus a foreign home
node tools/sync-shared.mjs  # after editing integrations/_shared/
```

The suite asserts, among other things: a full scan creates, removes and modifies
nothing outside the hub home; reading a foreign home built from copies changes
none of its files; the context stays inside its budget and accounts for every
message; a selection is delivered exactly once; every resume command is verified
or refused; and a machine with no harnesses says so instead of looking empty.

## License

MIT
