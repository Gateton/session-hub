---
name: session-hub
description: Continue work the user did in another coding agent. Use when they refer to a conversation that is not in this transcript ("continue what I did in Codex", "the session where we fixed X", "what was I doing in this repo") or when they assume context you do not have. Finds sessions across Claude Code, Codex, OpenCode, Crush, JCode and Pi, brings one into this conversation, or gives the command that reopens it where it lives.
when_to_use: The user mentions work done elsewhere, another agent by name, a session or conversation they cannot see here, or asks what they were doing in a project. Also useful when they ask you to resume something you have no context for.
allowed-tools:
  - mcp__plugin_session-hub_hub__search
  - mcp__plugin_session-hub_hub__context
  - mcp__plugin_session-hub_hub__native
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs *)
---

# session-hub

Other coding agents have been used on this machine, and so has Claude Code in other
projects. session-hub indexes all of those sessions (Claude Code, Codex, OpenCode,
Crush, JCode, Pi) so the user can bring one here instead of re-explaining it.

Injection is explicit and always the user's call. Find the session, show them the
cost, and let them decide. Nothing is imported behind their back.

## When to reach for it

- "Continue what I was doing in Codex / OpenCode / Crush / JCode / Pi."
- "The session where we fixed the auth bug" / "that conversation about the parser".
- "What was I doing in this repo?" when this transcript does not answer it.
- The user assumes context you do not have and mentions another agent or another project.

Not for this conversation: what happened here is already in front of you.

## How

MCP tools are `mcp__plugin_session-hub_hub__search`, `..._context`, `..._native`.

1. **Find it.** `search` with `{"query": "auth bug", "dir": "/path/to/project"}`.
   Leave out `dir` to search the current directory, which answers "in this repo".
   Pass `{"dir": "/some/other/project"}` to look at another project, or
   `{"harness": "codex"}` to restrict to one agent.
2. **Show the user the matches** with their harness, project, date and message count,
   then ask which one. Do not guess on their behalf.
3. **Bring it in**, one of two ways:
   - `context` with `{"uid": "<uid>"}`: the transcript arrives in this turn and costs
     tokens now. Use it when they want it immediately.
   - `pick <uid> --chars 40000` through the CLI: it arrives with their **next**
     message, so they can keep working first. Nothing is sent until then. They can
     cancel with `pending --clear`.
     Say the cost before injecting: the default is 40,000 characters (~10k tokens);
     lower `--chars` when context is tight. `--note "why"` puts their reason in the block.
4. **Reopening instead.** `native` with a uid returns the verified command that reopens
   that session in the agent that owns it (`codex resume <id>` and so on). If it answers
   `"action": null`, the hub has no verified command for that session: say so and stop.
   Never type a resume command the hub did not verify.

## When the tools are not there

Run the same subcommands through the bundled CLI instead:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs search "auth bug" --json
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs context <uid> --chars 20000 --json
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs pick <uid> --chars 20000 --note "why"
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs native <uid> --json
node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs here --json      # sessions of this project, every harness
```

stdout is the payload, stderr is diagnostics, `--json` everywhere.

If it answers that the hub cannot be found, tell the user exactly this: run
`sessionhub setup`, or set `SESSION_HUB_ROOT` to the directory that contains
`bin/sessionhub.mjs` and `mcp/server.mjs`. Do not try to work around it.
