---
name: session-hub
description: Find and import work the user did in another coding agent (Claude Code, OpenCode, Crush, JCode, Pi, or an earlier Codex session). Use when the user refers to previous work that is not in this conversation ("like we did yesterday", "the session where I fixed the parser", "continue what I started"), assumes context you do not have, asks which session something was discussed in, or asks you to resume or reopen a session from another agent. Also use it to hand your own current work off to another agent.
---

# Importing a session from another coding agent

session-hub indexes every coding-agent session on this machine: Claude Code,
Codex, OpenCode, Crush, JCode and Pi. It can search them, and it can bring one
of them into this conversation.

The point is that the user should never have to re-explain context that already
exists on disk in another agent's history. When they refer to work you cannot
see, do not guess and do not ask them to paste a transcript. Look it up.

## When this applies

Reach for session-hub when any of these is true:

- The user refers to prior work that is not in this conversation: "the auth
  refactor we did", "that session yesterday", "where I debugged the caching bug".
- The user assumes context you do not have: "continue from where we stopped",
  "apply the same fix as before", "the file we discussed".
- The user names another agent: "what I did in Claude Code", "my OpenCode
  session", "the Pi session".
- The user asks you to reopen, resume or hand off a session.
- You are about to say "I don't have that context" or ask the user to
  re-explain something that plausibly exists in another agent's history. Check
  first, then say what you found.

Do not use it when the work is already in this conversation, or when the user is
asking about something that never happened on this machine.

## How to use it

### Preferred: the MCP tools

The plugin registers a `hub` MCP server with three tools:

- `search` with `{ query, dir, harness, limit }` - find sessions by words in
  titles and transcripts. `dir` defaults to the working directory, which is the
  right choice when the user says "this project".
- `context` with `{ uid, chars }` - the budgeted transcript for one session.
  This is the big one: it is what actually imports the conversation.
- `native` with `{ uid }` - the verified command that reopens the session in
  the agent that owns it.

Start with `search`. Show the user what matched, with uid, harness, date and
title, and let them choose. Do not import a session the user did not ask for.

### Fallback: the shell

If the MCP tools are not available (the user installed the hooks but not the
server, or the server failed to start), the same three operations exist as a
CLI. Every command takes `--json`, writes its payload to stdout and its
diagnostics to stderr:

```bash
sessionhub here --json                    # sessions for the current directory, every agent
sessionhub search "<words>" --json        # find sessions
sessionhub list --harness claude-code --json
sessionhub context <uid> --chars 40000 --json
sessionhub native <uid> --json
```

If `sessionhub` is not on PATH, the plugin's own copies are the fallback:

```bash
node "${PLUGIN_ROOT}/../../bin/sessionhub.mjs" here --json
```

and if that path does not exist either, tell the user to run `sessionhub setup`
or set `SESSION_HUB_ROOT`. Never invent session contents.

## The explicit import: `pick`

Searching and reading are safe. Making a session *arrive in this conversation*
is a deliberate act, and it always goes through the user:

```bash
sessionhub pick <uid> --chars 40000 --note "why we need it"
```

`pick` records the choice and prints what it will cost. Nothing is imported
yet. The session-hub hook delivers it as extra context with the user's next
message, so the user stays in control of when they pay for it.

Use this when the user says "bring it in", "import that", "load it into this
conversation", or when they pick a session you found. Show the cost first: how
many messages, and roughly how many tokens.

If the user wants the conversation in front of them right now rather than on
their next message, use `context` instead. It prints the same budgeted
material, and you can read it directly.

## Continuing in the agent that owns the session

When the user wants to go back to the other agent rather than import the work
here, `native <uid>` returns the exact command, the working directory, and the
evidence for why that command is correct:

```
{ uid, harness, action: { command, args, cwd, verified, verificationBasis, verificationNote } }
```

`action` is `null` when the hub has no verified resume command for that
harness. Say that plainly rather than guessing a command line. Always show the
command to the user before they run it; never run it for them unasked.

## Rules

- Report what the hub reported. If a session has no title, no repo, or no
  capture of tool calls, say so; do not fill the gap.
- Budgets are real. `--chars` is the user's money. Mention the estimated tokens
  before a large import. `context` tells you `includedMessages`,
  `omittedMessages` and `estimatedTokens`; pass those on.
- One pending selection at a time. `sessionhub pending --peek --json` shows what
  is armed; `sessionhub pending --clear` cancels it.
- Empty is a real answer. "No sessions matched" means that, not "the tool is
  broken". If a search comes back empty, try fewer words, or drop `--harness`.
- If the hub reports that a harness is `not_installed` or `path_missing`, relay
  that. `sessionhub doctor --json` lists every harness and what was found.
