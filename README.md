<div align="center">

# session-hub

**Continue the work you left in another coding agent.**

Find a session from Codex, OpenCode, Claude Code, Crush, JCode or Pi, bring its
conversation into the agent you are using right now, and keep going without
re-explaining anything.

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

Requires **Node 22.5 or newer**. No runtime dependencies, no build step, no
`node_modules`.

```bash
git clone <this repo> ~/session-hub
node ~/session-hub/bin/sessionhub.mjs setup      # record where the hub lives
export PATH="$HOME/session-hub/bin:$PATH"        # optional, for the bare command
```

Then install the integration for the agent you use. In every command below,
`/path/to/session-hub` means the directory you cloned into (on this machine it is
`/home/gateton/Projects/session-hub`); it is a real path, not a placeholder to
paste verbatim.

### Claude Code

```text
/plugin marketplace add /path/to/session-hub
/plugin install session-hub@session-hub
```

Working on the plugin itself? `claude --plugin-dir /path/to/session-hub/integrations/claude`
loads it without installing anything.

### Codex

```bash
codex plugin marketplace add /path/to/session-hub
codex plugin add session-hub@session-hub
```

Codex asks you to trust the plugin's hooks once, in `/hooks`. Until you do, the
tools and the skill work but a picked session is not delivered automatically.

### OpenCode

Add one entry to `opencode.json`:

```json
{ "plugin": ["session-hub"] }
```

Until the package is on npm, point it at this checkout:

```json
{ "plugin": ["file:///path/to/session-hub/integrations/opencode"] }
```

Each plugin is self-contained: Claude Code copies a plugin into its own cache, so
on first run it vendors the hub into itself and then resolves through its own
copy. Nothing else needs to be installed.

### What has actually been verified

Claims here are tied to observed runs, not to what the docs imply:

| Harness | Verified here |
|---|---|
| Core, CLI, MCP | 80 checks green, against the real stores on this machine |
| Claude Code | `claude plugin validate` passes (plugin, `--strict`, marketplace, skills); the hook emits the picked session as `additionalContext` once and nothing afterwards; the plugin's MCP server answers `initialize` and `tools/list`; a copied plugin vendors itself once and resolves through its own copy with no hub elsewhere |
| Codex | `codex plugin marketplace add` + `plugin add` install from this checkout; `codex mcp list` resolves the `hub` server from the plugin cache; the hook delivers the picked session once; a live `codex exec` turn called `hub.search` and quoted the injected block verbatim |
| OpenCode | See `integrations/opencode/README.md` for what was and was not exercised |
| Claude Code, live turn | **Not verified**: this machine's Claude Code cannot authenticate headlessly (`OAuth session expired`), so the interactive flow is the one thing left to a human |

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
