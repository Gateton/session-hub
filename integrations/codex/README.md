# session-hub for Codex

Continue work you left in another coding agent. session-hub indexes the sessions
on this machine from Claude Code, Codex, OpenCode, Crush, JCode and Pi. This
plugin gives Codex three tools for finding and importing them, a skill that
teaches Codex when to reach for them, and a hook that delivers the session you
picked on your next message.

The direction that matters most is Codex -> Claude Code (and back): you were
working on something in Claude Code, you open Codex, and you should not have to
explain yourself again.

## Requirements

- Node 22.5 or newer (`node --version`). The hub uses `node:sqlite` with FTS5.
- The session-hub checkout itself. This plugin does not carry a copy of it, so
  tell the hub where it lives once:

  ```bash
  cd /path/to/session-hub
  node bin/sessionhub.mjs setup
  ```

  That writes `~/.session-hub/install.json`, which is what lets the plugin's
  hooks and MCP server find the hub from any directory and from Codex's own
  plugin cache. If you would rather not run it, set `SESSION_HUB_ROOT` instead.

  Check it worked:

  ```bash
  node bin/sessionhub.mjs doctor
  ```

## Install

### From this checkout

```bash
codex plugin marketplace add /path/to/session-hub
codex plugin add session-hub@session-hub
```

The repository root carries `.agents/plugins/marketplace.json`, so `add` takes
the checkout itself, the same way Claude Code takes it with `/plugin marketplace
add`. If you would rather not check out the whole repository, the plugin
directory carries its own marketplace manifest and works on its own:

```bash
codex plugin marketplace add /path/to/session-hub/integrations/codex   # marketplace: session-hub-local
codex plugin add session-hub@session-hub-local
```

### From Git

Once this repository has a Git remote, point Codex at it. For a sparse checkout
of the plugin alone, use the integration directory, because Codex looks for
`.agents/plugins/marketplace.json` inside whatever it fetches, and that
directory has one:

```bash
codex plugin marketplace add <owner>/<repo> --ref main --sparse integrations/codex
codex plugin add session-hub@session-hub-local
```

Only the local-path forms have been exercised end to end here, so if the Git
form misbehaves, add the local path instead.

### Check it

```bash
codex plugin list                       # session-hub@session-hub, installed
codex plugin marketplace list           # where Codex thinks the root is
codex mcp list                          # a server called `hub`
```

## Trust the hooks

Hooks that come from a plugin are not trusted automatically. Codex discovers
them (with `--dangerously-bypass-hook-trust` it tells you twice, once per
handler), but it does not run them until you review them: the first session
after installing shows a warning that points at `/hooks`, and until you trust
the two entries there, the "arrives with your next message" part is inert while
the MCP tools and the skill work normally.

`--dangerously-bypass-hook-trust` is not a substitute for that review. It skips
the review for hooks that are already enabled, which covers hooks you wrote in
`~/.codex/hooks.json`, but a plugin's bundled hooks stay skipped. If you want
the delivery without opening `/hooks`, use the explicit form below instead; it
is the same handler either way.

### Wiring the handler by hand instead

`~/.codex/hooks.json` hooks do run without a plugin trust step. Point them at
the installed copy of the handler, which is the file Codex put in its cache:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/home/gateton/.codex/plugins/cache/session-hub-local/session-hub/0.1.0/scripts/sessionhub-hook.mjs\"",
            "timeout": 25,
            "statusMessage": "Checking for a session-hub selection",
            "additionalContextLimit": 12000
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/home/gateton/.codex/plugins/cache/session-hub-local/session-hub/0.1.0/scripts/sessionhub-hook.mjs\"",
            "timeout": 25,
            "statusMessage": "Loading the session you picked",
            "additionalContextLimit": 12000
          }
        ]
      }
    ]
  }
}
```

Keep only one copy in play: if you also trust the plugin's hooks, both fire, the
first one consumes the pick, and the second finds nothing, so you get the import
once and no damage, but the status message appears twice. Confirm the cache path
first, because it carries the plugin version and changes when the plugin is
updated:

```bash
ls ~/.codex/plugins/cache/*/session-hub/*/scripts/sessionhub-hook.mjs
```

Because this form does not go through the plugin, `PLUGIN_ROOT` is not set for
it. The handler copes: with no `PLUGIN_ROOT` it uses its own directory, which is
the plugin root, and the hub is still found the usual way.


## What you will see

Ask for something you did elsewhere:

> continue what I was doing in Claude Code on the parser

Codex calls the `hub` MCP server's `search` tool and answers with the sessions
that matched, each with a uid, the agent it came from, when it ran and its
title. Pick one and Codex calls `context`, which prints the budgeted transcript
of that session into the conversation. Codex sees the prior work and carries on
without you re-explaining anything.

For the "arrive with my next message" flow, be explicit from a normal terminal:

```bash
sessionhub here                                   # sessions for this directory
sessionhub pick claude-code:520b1e52 --chars 40000 --note "the parser refactor"
```

`pick` shows the cost and records the choice. Nothing is imported yet. Your next
message in Codex arrives with the conversation attached, wrapped like this:

```
[session-hub] The user picked a conversation from Claude Code to bring into this one.
Source: claude-code:520b1e52-...
Cost: 18/24 message(s), ~9,900 tokens.
...
[/session-hub] This is real prior work from another agent. Continue from it; ...
```

Codex also shows a one-line notice that the import landed. A pick expires after
two hours and is delivered at most once; `sessionhub pending --clear` cancels it
before it arrives and `sessionhub pending --peek` shows what is armed.

To go back to the other agent instead of importing the work, `sessionhub native
<uid>` prints the exact resume command, its working directory and the evidence
that the command is right. It never guesses one.

## How the delivery works

`hooks/hooks.json` wires one handler to two Codex events:

- `UserPromptSubmit` is the important one. It fires with the prompt you are
  about to send, and Codex adds its output as extra developer context, so a
  pick made a moment ago lands on the very next message.
- `SessionStart` covers the case where you picked a session and then closed and
  reopened Codex: it fires on startup, resume, clear and compaction.

Both events can emit `additionalContext`; that is not true of every Codex event,
which is why `PreCompact`, `PostCompact`, `Stop`, `SessionEnd` and `Interrupt`
are not used here. A hook can only be wired to the delivery it actually
performs, so when nothing is armed the handler prints nothing at all and exits
0. It never blocks the turn: every failure path ends in exit 0 with no stdout,
except one, where a session you asked for could not be loaded and a short
message tells you to pick it again.

`additionalContextLimit` is set to `12000` tokens on both handlers. Codex's
default is `2500`, which would spill a full import to a temp file and show Codex
a preview instead of the work. The default `pick` budget of 40000 characters is
about 10000 tokens, so it arrives whole. Pick less if you want less.

## MCP wiring

The plugin declares its MCP server in `mcp.json`, and Codex resolves it against
the installed plugin root. There is nothing to add to `~/.codex/config.toml`:

```bash
codex mcp list
# Name  Command  Args                                       ...  Status   Auth
# hub   node     .../session-hub/0.1.0/scripts/mcp-shim.mjs  ...  enabled  Unsupported
```

The shim resolves the hub the same way the hook does; it exists because the
installed plugin is a copy, so `.mcp.json`-style absolute paths cannot be
written in advance.

It also has to be `mcp.json` at the plugin root rather than `.mcp.json` next to
the compatibility manifest. Codex accepts both, but only the portable form
substitutes `${PLUGIN_ROOT}` for a plugin MCP server: with a compatibility
`.mcp.json`, the server is registered and then fails to start, because the path
stays literal and `PLUGIN_ROOT` is not in the MCP server's environment. If you
move the server back to `.mcp.json`, `codex mcp list` will still look right and
`hub` will never answer.

Tool calls prompt for approval by default. To let the hub's tools run without a
prompt, add the plugin-scoped policy to `~/.codex/config.toml`:

```toml
[plugins."session-hub@session-hub-local".mcp_servers.hub]
enabled = true
default_tools_approval_mode = "approve"
```

### If you would rather not install the plugin

Add the server by hand instead. This is the hub's own MCP server, not the shim,
so the path is absolute and there is no plugin involved:

```toml
[mcp_servers.session_hub]
command = "node"
args = ["/home/gateton/Projects/session-hub/mcp/server.mjs"]
```

You then lose the skill and the hook, so nothing arrives on your next message;
you would use `context` from the conversation instead.

## A note on Codex's sandbox

MCP servers run outside the sandbox, so the three tools work with the default
sandbox settings. A `sessionhub` command that Codex runs *through the shell*
does not: the hub rewrites its index under `~/.session-hub`, and under the
default restricted filesystem the write fails with

```
index write failed: attempt to write a readonly database
```

That is expected, and it is why the MCP tools are the first choice in the skill.
If you want the shell fallback to work inside Codex, run it with access to that
directory:

```bash
codex --add-dir ~/.session-hub
```

Running `sessionhub pick` from a normal terminal is unaffected.

## Troubleshooting

**"session-hub hooks are installed but the hub itself is missing."** Codex found
the plugin but the hub is not where the resolver looked. Run `sessionhub setup`
in your session-hub checkout, or `export SESSION_HUB_ROOT=/path/to/session-hub`.
The path must contain `bin/sessionhub.mjs` and `mcp/server.mjs`.

**No `hub` server in `codex mcp list`.** The plugin is not enabled. Check
`codex plugin list --json` for `"enabled": true`, and see what the plugin's own
config says in `~/.codex/config.toml` under
`[plugins."session-hub@session-hub-local"]`.

**The tools answer but every call says "Unavailable".** That is the shim working
as designed: it could not find the hub, and it is telling you so in the answer
instead of hanging. Same fix as above.

**Nothing arrives after `pick`.** The hook is untrusted (`/hooks`), or you picked
more than two hours ago, or the pending selection was already consumed by an
earlier message. `sessionhub pending --peek` shows the state.

**Codex cannot see the plugin at all.** Check `codex plugin marketplace list`
shows `session-hub-local` with root
`/home/gateton/Projects/session-hub/integrations/codex`. If the root moved,
remove and re-add the marketplace.

## Uninstall

```bash
codex plugin remove session-hub@session-hub-local
codex plugin marketplace remove session-hub-local
```

If you added the `[mcp_servers.session_hub]` block or the plugin-scoped
`[plugins...]` policy by hand, delete those lines from
`~/.codex/config.toml`. Nothing session-hub wrote lives outside
`~/.session-hub`.

## Layout

```
.codex-plugin/plugin.json   Codex compatibility manifest: skills, hooks, interface
plugin.json                 portable Agent Plugins manifest: identity
mcp.json                    portable MCP declaration for the `hub` server
hooks/hooks.json            SessionStart and UserPromptSubmit delivery
skills/session-hub/SKILL.md when to look for another agent's work, and how
scripts/resolve.mjs         finds the hub (shared, generated - do not edit)
scripts/sessionhub-hook.mjs turns a pending pick into hook output
scripts/mcp-shim.mjs        starts the hub's MCP server from the installed plugin
.agents/plugins/marketplace.json  the local marketplace entry
```
