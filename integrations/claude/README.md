# session-hub for Claude Code

Work you did in another coding agent (Codex, OpenCode, Crush, JCode, Pi) or in
another Claude Code project is already on this machine, in that agent's own
session store. This plugin puts it back in reach: ask for the session, see what it
costs, and it arrives with your next message. Nothing is imported unless you pick it.

## What you need

- Claude Code
- Node 22.5 or newer (`node --version`). The hub runs TypeScript directly; there is
  no build step and no `npm install`.
- The session-hub command line. The plugin looks for it in this order:
  `$SESSION_HUB_ROOT`, its own vendored copy, `~/.session-hub/install.json`
  (written by `sessionhub setup`), a checkout above the directory you started in,
  then `sessionhub` on `PATH`. If none of those exist, the first session start
  vendors a copy into the plugin (see below).

## Install

```
/plugin marketplace add gateton/session-hub
/plugin install session-hub@session-hub
```

From a local checkout instead: `/plugin marketplace add /path/to/session-hub`, then
the same install command. Run `/reload-plugins` if Claude Code asks for it.

To try the plugin without installing it, point Claude Code at the directory:
`claude --plugin-dir /path/to/session-hub/integrations/claude`.

## What you get

Three MCP tools, listed in Claude Code as
`mcp__plugin_session-hub_hub__search`, `mcp__plugin_session-hub_hub__context` and
`mcp__plugin_session-hub_hub__native`:

| Tool | What it does |
| --- | --- |
| `search` | Finds sessions across every harness, by words, project or agent. |
| `context` | Loads one session's conversation into this one, inside a character budget. |
| `native` | The verified command that reopens that session in the agent that owns it. |

Plus a skill, `/session-hub:session-hub`, and two hooks: `SessionStart` and
`UserPromptSubmit`.

## How a session arrives

1. You ask, in your own words: "continue what I did in Codex", "the session where we
   fixed the parser bug", "what was I doing in this repo".
2. Claude searches and shows you the candidates: harness, project, date, size.
3. You pick one. Two ways in:
   - **Now**: the transcript lands in the current turn.
   - **Next message**: recorded as pending, and it arrives with your next message
     instead, so you can keep typing first. `pending --clear` cancels it (through the
     wrapper below, or just ask Claude to cancel it).
4. What arrives is a block that starts with where it came from and what it cost:

```
[session-hub] The user picked a conversation from Codex to bring into this one.
Source: codex:0191ab...
Path: /home/you/.codex/sessions/2026/09/19/rollout-....jsonl
Cost: 42/180 message(s), ~8,400 tokens.

<the conversation, recent turns verbatim, older ones condensed>

[/session-hub] This is real prior work from another agent. Continue from it; do not ask the user to re-explain it.
```

You asked for it, so you know it is coming: there is no way for a session to arrive
that you did not pick.

If the block is longer than Claude Code's 10,000 character limit for hook context,
it is cut in the middle, the cut says so, and the head and the closing line stay
intact. The rest is one `context` call away at the same uid.

## First run: the plugin vendors the hub into itself

Claude Code copies a plugin into its own cache, so the plugin carries the hub with
it. On the first `SessionStart`, if `integrations/claude/vendor` (in the installed
copy: `<plugin>/vendor`) does not exist, the hook runs
`sessionhub vendor --into <plugin root>` once, in the background, and writes a
`.sessionhub-vendor-attempted` marker so it never repeats. That is what makes
`claude plugin install` work with no global setup.

A plugin that already lives inside the hub's own checkout (the `--plugin-dir` case
above) is left alone: there is nothing to copy, and a copy would shadow the live
code. It keeps reading the checkout.

Nothing else is written: no npm packages, no lockfiles, no daemon. A vendored copy
is preferred over every other location, so an installed plugin keeps working even if
the checkout it came from moves.

## The command line, if you want it directly

The plugin bundles a wrapper that finds the hub the same way its hooks do:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs list --json
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs here --json
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs search "parser bug" --harness codex
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs context <uid> --chars 20000
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs pick <uid> --chars 20000 --note "the parser bug"
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs native <uid> --json
```

stdout is the payload, stderr is diagnostics, `--json` on every subcommand.

## When it says the hub cannot be found

```
sessionhub setup                        # records where the hub lives
export SESSION_HUB_ROOT=/path/to/session-hub
```

The path must contain `bin/sessionhub.mjs` and `mcp/server.mjs`. Nothing else in the
session is affected: the hooks exit 0 and stay quiet, and the MCP tools answer with
this same message instead of failing silently.

## Files

```
.claude-plugin/plugin.json        plugin manifest
.mcp.json                         the MCP server, launched through scripts/mcp-shim.mjs
hooks/hooks.json                  SessionStart and UserPromptSubmit
skills/session-hub/SKILL.md       when to use the hub, and how
scripts/sessionhub-hook.mjs       reads the hook JSON, delivers a pending selection, vendors on first run
scripts/mcp-shim.mjs              finds the hub and hands it stdio, or explains that it is missing
scripts/hub-cli.mjs               runs the hub CLI with the same resolution
scripts/resolve.mjs               generated copy of integrations/_shared/resolve.mjs
```
