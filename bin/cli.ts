#!/usr/bin/env node
/**
 * sessionhub, the cross-harness session CLI.
 *
 * This is the whole product surface in one binary: every harness integration
 * (Claude Code plugin, Codex plugin, OpenCode plugin, Pi extension) is a thin
 * shell that calls these subcommands. Keeping the logic here means the
 * behaviours that matter (budgeted context, verified resume commands, honest
 * failures) are implemented once and cannot drift per harness.
 *
 * stdout carries the payload, stderr carries progress and diagnostics, so
 * `sessionhub context <uid>` can be piped straight into a prompt.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Hub, HubReadError, hubHome } from "../core/hub.ts";
import { looksLikeRoot, packageRoot, readOwnVersion, vendorInto, writeInstallRecord } from "../core/install.ts";
import { INSTALLABLE, anyFailed, detectTargets, installIntegrations } from "../core/install-harnesses.ts";
import { askSelection } from "../core/prompt.ts";
import { installCliOnPath, stageHub } from "../core/install.ts";
import { HARNESS_LABEL, HARNESS_ORDER, type ExternalSession, type HarnessId } from "../core/types.ts";
import { formatNativeResume } from "../core/native.ts";
import { clearPending, readPending, writePending } from "../core/pending.ts";

const USAGE = `sessionhub: browse, search and continue sessions from every coding agent on this machine.

Usage:
  sessionhub here [options]              Sessions of the project you are standing in, every harness
  sessionhub list [options]              List sessions, newest first
  sessionhub search <query> [options]    Full-text search over titles and transcripts
  sessionhub context <uid> [options]     Print the budgeted context package for one session
  sessionhub show <uid> [options]        Print the transcript (read-only, no model involved)
  sessionhub handoff <uid> [options]     Print the deterministic handoff document
  sessionhub native <uid> [options]      Print the verified resume command for the owning harness
  sessionhub pick <uid> [options]        Choose a session to arrive with your next message
  sessionhub pending [options]           Show or take the picked session (what hooks call)
  sessionhub index [options]             Rebuild the local index
  sessionhub doctor [options]            Report which harnesses were found and how many sessions
  sessionhub version                     Print the version
  sessionhub install [options]           One command: install into every harness found on PATH
  sessionhub mcp                         Run the MCP server on stdio (for npx and MCP clients)
  sessionhub setup [options]             Record where the hub lives, for the harness plugins
  sessionhub vendor --into <dir>         Copy the hub into a plugin so it is self-contained

Options:
  --harness <id>   Filter by harness: ${HARNESS_ORDER.join(", ")}
  --repo <text>    Filter by repo or project path
  --file <text>    Filter by a touched file path
  --limit <n>      Maximum rows (default 25 for lists, 300 for search)
  --chars <n>      Context budget in characters (default 40000)
  --only <list>    With install: comma-separated claude-code,codex,opencode
  --in-place       With install: use this directory instead of staging a copy
  --all            With install: install into every agent found, without asking
  --dry-run        Show what install would run, without running it
  --deep           Search full transcripts instead of the indexed excerpt
  --max <n>        Sessions to read in --deep mode (default 400)
  --json           Machine-readable output
  --home <dir>     Hub home for the index (default ~/.session-hub)
  --force          Re-read every source, ignoring fingerprints
  --verbose        Include the source path and details in human output
  -h, --help       This text

A uid looks like "claude-code:0f3a-...". A unique prefix is enough.
Nothing outside ${hubHome()} is ever written.`;

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = splitFlag(token);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  const command = positional.shift() ?? "help";
  return { command, positional, flags };
}

function splitFlag(token: string): [string, string | undefined] {
  const body = token.replace(/^--/, "");
  const eq = body.indexOf("=");
  if (eq === -1) return [body, undefined];
  return [body.slice(0, eq), body.slice(eq + 1)];
}

function flagNum(args: Args, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (typeof raw !== "string") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function flagStr(args: Args, name: string): string | undefined {
  const raw = args.flags.get(name);
  return typeof raw === "string" ? raw : undefined;
}

function flagBool(args: Args, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}

function harnessFilter(args: Args): HarnessId | undefined {
  const raw = flagStr(args, "harness");
  if (!raw) return undefined;
  if (!HARNESS_ORDER.includes(raw as HarnessId)) {
    die(`unknown harness "${raw}". Known: ${HARNESS_ORDER.join(", ")}`);
  }
  return raw as HarnessId;
}

/**
 * Fail loudly, and synchronously: a piped stdout may still be draining, and
 * `process.exit` would truncate it. Writing with fs keeps the message intact.
 */
function die(message: string): never {
  fs.writeSync(2, `${message}\n`);
  process.exit(2);
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Human row: one session, two lines, stable column order. */
function sessionRow(s: ExternalSession, verbose: boolean): string {
  const when = (s.updatedAt ?? s.createdAt ?? "").slice(0, 16).replace("T", " ");
  const harness = HARNESS_LABEL[s.harness] ?? s.harness;
  const where = s.repo ?? s.cwd ?? "-";
  const head = [s.uid, when || "-", harness.padEnd(11), where].join("  ");
  const body = `    ${s.title ?? s.preview ?? "(no title)"}`;
  if (!verbose) return `${head}\n${body}`;
  const extra = [
    `    path: ${s.path}`,
    `    model: ${s.model ?? "-"}  messages: ${s.messageCount}  tools: ${s.toolCount}`,
  ].join("\n");
  return `${head}\n${body}\n${extra}`;
}

async function withHub<T>(fn: (hub: Hub) => Promise<T>, home?: string): Promise<T> {
  let hub: Hub;
  try {
    hub = await Hub.open(home ? { home } : {});
  } catch (err) {
    return die(err instanceof Error ? err.message : String(err)) as never;
  }
  try {
    return await fn(hub);
  } finally {
    hub.close();
  }
}

/** Every command accepts --home so tests and scripts never need environment plumbing. */
function command(args: Args, fn: (hub: Hub) => Promise<void>): Promise<void> {
  return withHub(fn, flagStr(args, "home"));
}

const commands: Record<string, (args: Args) => Promise<void>> = {
  async help() {
    process.stdout.write(`${USAGE}\n`);
  },

  async version(args) {
    const version = readOwnVersion(packageRoot());
    if (flagBool(args, "json")) return json({ name: "session-hub", version, node: process.version });
    process.stdout.write(`session-hub ${version} (node ${process.version})\n`);
  },

  async setup(args) {
    const root = packageRoot();
    if (!looksLikeRoot(root)) {
      die(`cannot find the hub at ${root}. Run this from an unpacked session-hub package.`);
    }
    const record = writeInstallRecord(root);
    if (flagBool(args, "json")) return json(record);
    process.stdout.write(
      [
        `registered session-hub ${record.version}`,
        `  root: ${record.root}`,
        `  cli:  ${record.cli}`,
        `  mcp:  ${record.mcp}`,
        "",
        "The harness integrations read this record, so they work from any",
        "directory and survive the plugin being copied into a cache.",
        "",
        record.cli.replace(/\/bin\/sessionhub\.mjs$/, "") === root
          ? "Add it to your PATH if you want the bare `sessionhub` command:"
          : "Add it to your PATH if you want the bare `sessionhub` command:",
        `  export PATH="${path.join(root, "bin")}:$PATH"`,
        "",
      ].join("\n"),
    );
  },

  async mcp() {
    // The server as a subcommand, so a one-line MCP registration works:
    //   claude mcp add session-hub -- npx -y session-hub mcp
    const { start } = await import("../mcp/server.impl.ts");
    await start();
  },

  async install(args) {
    const root = packageRoot();
    if (!looksLikeRoot(root)) {
      die(`cannot find the hub at ${root}. Run this from an unpacked session-hub package.`);
    }
    // Installers run from places that disappear: npx's cache is garbage-collected
    // and a checkout can move. Stage a copy in the hub home so every plugin and
    // the MCP server has one path that stays put.
    const dryRun = flagBool(args, "dry-run");
    const staged = flagBool(args, "in-place") || dryRun ? { root, files: 0, bytes: 0 } : stageHub(root);
    const installRoot = dryRun ? path.join(hubHome(), "src") : staged.root;
    if (!looksLikeRoot(installRoot)) {
      die(`staging the hub into ${installRoot} did not produce a usable copy.`);
    }
    // Register the install location: plugins find the hub through this record, so
    // installing without it would produce plugins that cannot answer anything.
    if (!flagBool(args, "dry-run")) writeInstallRecord(installRoot);

    // Choosing where to install is the user's call, so when nothing was specified
    // and there is a person at the keyboard, ask. --only and --all keep it
    // scriptable, and a non-interactive caller gets told what to pass instead of
    // a menu it cannot see.
    let only = flagStr(args, "only")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // A typo in --only used to fall through to "no supported harness found", which
    // blames the machine for a misspelled argument.
    if (only) {
      const unknown = only.filter((name) => !INSTALLABLE.includes(name as (typeof INSTALLABLE)[number]));
      if (unknown.length > 0) {
        die(
          `unknown harness in --only: ${unknown.join(", ")}\n` +
            `Known: ${INSTALLABLE.join(", ")}\n` +
            `For tools-only installation without a plugin, see the README.`,
        );
      }
    }


    if (!only && !flagBool(args, "all") && !dryRun) {
      const detected = detectTargets();
      if (detected.length === 0) {
        process.stdout.write("No supported agent found on PATH (claude, codex, opencode).\n");
        return;
      }
      // SESSION_HUB_FORCE_TTY lets the acceptance suite drive the menu over a
      // pipe; nothing else changes behaviour.
      const interactive =
        (process.stdin.isTTY && process.stdout.isTTY) || process.env.SESSION_HUB_FORCE_TTY === "1";
      if (interactive) {
        const chosen = await askSelection(detected);
        if (chosen.length === 0) {
          process.stdout.write("Nothing selected, nothing installed.\n");
          return;
        }
        only = chosen;
      } else {
        process.stdout.write(
          [
            `Detected: ${detected.map((d) => `${d.label} (${d.binary})`).join(", ")}`,
            "",
            "Nothing was installed because this is not an interactive terminal.",
            "Pass the ones you want, for example:",
            "",
            `  sessionhub install --only ${detected.map((d) => d.harness).join(",")}`,
            "",
          ].join("\n"),
        );
        return;
      }
    }
    const results = installIntegrations({ root: installRoot, only, dryRun: flagBool(args, "dry-run") });

    const pathShim = dryRun ? null : installCliOnPath(path.join(installRoot, "bin", "sessionhub.mjs"));

    if (flagBool(args, "json")) {
      return json({
        root,
        installRoot,
        staged: staged.files,
        dryRun,
        cli: pathShim ? { file: pathShim.file, onPath: pathShim.onPath } : null,
        results,
      });
    }

    const lines: string[] = [];
    if (dryRun) {
      lines.push(`would stage the hub at ${installRoot} so nothing depends on where this copy lives`, "");
    } else if (installRoot !== root) {
      lines.push(`staged the hub at ${installRoot} (${staged.files} files), so nothing depends on this directory`, "");
    }
    for (const result of results) {
      lines.push(`${result.label}:`);
      if (result.skipped) lines.push(`  skipped: ${result.skipped}`);
      for (const step of result.steps) {
        const mark = step.ok ? "ok  " : "FAIL";
        lines.push(`  ${mark} ${step.command}`);
        if (!step.ok) lines.push(`       ${step.output.split("\n").slice(0, 3).join("\n       ")}`);
      }
      if (result.manual) lines.push(`  next: ${result.manual}`);
      lines.push("");
    }
    if (pathShim) {
      lines.push(
        pathShim.onPath
          ? `installed ${pathShim.file}, so \`sessionhub\` works in a terminal`
          : `wrote ${pathShim.file}, but ${pathShim.dir} is not on your PATH. Add it with:\n  export PATH="${pathShim.dir}:$PATH"`,
        "",
      );
    }
    lines.push(
      results.some((r) => r.detected && !r.skipped)
        ? "Open a new session in the harness you just installed, and ask it to continue something you did elsewhere."
        : "No supported harness was found on PATH (claude, codex, opencode). The command line still works.",
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    if (anyFailed(results)) process.exitCode = 1;
  },

  async vendor(args) {
    const into = flagStr(args, "into");
    if (!into) die("usage: sessionhub vendor --into <plugin-directory>");
    const target = path.resolve(into);
    if (!fs.existsSync(target)) die(`no such directory: ${target}`);
    const result = vendorInto(target, packageRoot());
    if (flagBool(args, "json")) return json({ target, ...result });
    process.stdout.write(
      `vendored ${result.files} file(s), ${(result.bytes / 1024 / 1024).toFixed(1)} MiB into ${path.join(target, "vendor")}\n`,
    );
  },

  async pick(args) {
    const uid = args.positional[0];
    if (!uid) die("usage: sessionhub pick <uid> [--chars 40000] [--note \"why\"]");
    await command(args, async (hub) => {
      await hub.ensureFresh();
      const session = await hub.get(uid);
      if (!session) die(`no session matches "${uid}"`);
      const chars = flagNum(args, "chars") ?? 40_000;
      const record = writePending({
        uid: session!.uid,
        harness: session!.harness,
        title: session!.title,
        chars,
        note: flagStr(args, "note"),
      });
      if (flagBool(args, "json")) return json(record);
      process.stdout.write(
        [
          `selected: ${session!.title ?? session!.uid}`,
          `  from: ${HARNESS_LABEL[session!.harness]}   ${session!.repo ?? session!.cwd ?? "-"}`,
          `  budget: ~${chars.toLocaleString()} characters (~${Math.round(chars / 4).toLocaleString()} tokens)`,
          "",
          "It arrives with your next message in this harness. Nothing was sent yet.",
          `Cancel with: sessionhub pending --clear`,
          "",
        ].join("\n"),
      );
    });
  },

  async pending(args) {
    if (flagBool(args, "clear")) {
      const cleared = clearPending();
      if (flagBool(args, "json")) return json({ cleared });
      process.stdout.write(cleared ? "pending selection cleared\n" : "nothing was pending\n");
      return;
    }

    if (flagBool(args, "peek")) {
      const found = readPending();
      if (flagBool(args, "json")) return json(found ?? { pending: null });
      process.stdout.write(
        found
          ? `pending: ${found.selection.uid} (${found.selection.chars} chars, ${found.expired ? "expired" : "ready"})\n`
          : "nothing is pending\n",
      );
      return;
    }

    // Default and --take: print the block a harness hook should inject. Empty
    // output with exit 0 means "nothing to inject", which is what every hook
    // wants to hear most of the time.
    //
    // The selection is cleared only after the block has been built. Clearing
    // first would lose the user's pick whenever building failed (a slow read, a
    // store that moved), and a hook cannot tell that apart from "nothing was
    // picked", so it would silently drop the session the user chose.
    const found = readPending();
    if (!found || found.expired) {
      if (found) clearPending();
      if (flagBool(args, "json")) return json({ pending: null });
      return;
    }
    const taken = found.selection;
    await command(args, async (hub) => {
      await hub.ensureFresh();
      const loaded = await hub.contextFor(taken.uid, { charBudget: taken.chars });
      if (!loaded) {
        process.stderr.write(
          `pending session ${taken.uid} could not be read, so nothing was injected and the selection is still pending.\n` +
            `Check it with: sessionhub pending --peek (cancel with sessionhub pending --clear)\n`,
        );
        process.exitCode = 3;
        return;
      }
      // Built successfully: the pick is now consumed, exactly once.
      clearPending();
      const { session, context } = loaded;
      const block = [
        `[session-hub] The user picked a conversation from ${HARNESS_LABEL[session.harness]} to bring into this one.`,
        `Source: ${session.uid}`,
        `Path: ${session.path}`,
        taken.note ? `Why: ${taken.note}` : null,
        `Cost: ${context.includedMessages}/${context.totalMessages} message(s), ~${context.estimatedTokens.toLocaleString()} tokens.`,
        "",
        context.markdown,
        "",
        "[/session-hub] This is real prior work from another agent. Continue from it; do not ask the user to re-explain it.",
      ]
        .filter((line) => line !== null)
        .join("\n");

      if (flagBool(args, "json")) {
        return json({
          pending: { uid: session.uid, harness: session.harness, title: session.title },
          chars: block.length,
          estimatedTokens: context.estimatedTokens,
          text: block,
        });
      }
      process.stdout.write(`${block}\n`);
    });
  },

  async index(args) {
    await command(args, async (hub) => {
      const force = flagBool(args, "force");
      const result = await hub.refresh(force, (p) => {
        if (!flagBool(args, "json") && p.message) process.stderr.write(`  ${p.message}\n`);
      });
      if (flagBool(args, "json")) return json({ home: hub.home, ...result });
      process.stdout.write(
        [
          `indexed ${result.total} session(s) in ${result.durationMs}ms`,
          `  added ${result.added}, updated ${result.updated}, skipped ${result.skipped}, removed ${result.removed}`,
          ...Object.entries(result.perHarness).map(([h, n]) => `  ${h}: ${n}`),
          ...result.errors.map((e) => `  ! ${e.harness}: ${e.message}`),
          `  index: ${hub.indexPath}`,
        ].join("\n") + "\n",
      );
    });
  },

  async doctor(args) {
    await command(args, async (hub) => {
      const [detections, scan] = await Promise.all([
        hub.detect(),
        hub.ensureFresh(0).then(() => hub.counts()),
      ]);
      const indexed = new Map(scan.map((c) => [c.harness, c.n]));
      if (flagBool(args, "json")) return json({ home: hub.home, detections, indexed: Object.fromEntries(indexed) });
      const lines = detections.map((d) => {
        const n = indexed.get(d.harness) ?? 0;
        const status = d.status === "available" ? "ok" : d.status;
        return [
          `${(HARNESS_LABEL[d.harness] ?? d.harness).padEnd(12)} ${status.padEnd(16)} ${String(d.sessionCount).padStart(5)} found  ${String(n).padStart(5)} indexed`,
          `  root: ${d.root || "-"}`,
          d.detail ? `  note: ${d.detail}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      });
      process.stdout.write(
        `${lines.join("\n")}\n\nlast indexed: ${hub.lastIndexedAt() ?? "never"}\nhub home: ${hub.home}\n`,
      );
    });
  },

  async here(args) {
    await command(args, async (hub) => {
      await hub.ensureFresh();
      const dir = flagStr(args, "dir") ?? process.cwd();
      const limit = flagNum(args, "limit") ?? 25;
      const sessions = hub.here(dir, limit, harnessFilter(args));
      if (flagBool(args, "json")) return json({ dir, sessions });
      if (sessions.length === 0) {
        if (flagBool(args, "json")) return json({ dir, sessions: [] });
        return void process.stdout.write(
          `no sessions found for ${dir}${flagStr(args, "harness") ? ` [${flagStr(args, "harness")}]` : ""} in any harness.\n` +
            `Try "sessionhub list" for every session, or "sessionhub search <words>".\n`,
        );
      }
      const verbose = flagBool(args, "verbose");
      const byHarness = new Map<string, number>();
      for (const s of sessions) byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1);
      const summary = [...byHarness.entries()]
        .map(([h, n]) => `${HARNESS_LABEL[h as HarnessId] ?? h} ${n}`)
        .join(", ");
      process.stdout.write(
        `${sessions.length} session(s) for this project (${summary})\n\n` +
          `${sessions.map((s) => sessionRow(s, verbose)).join("\n\n")}\n\n` +
          `load one with:  sessionhub context <uid>\n`,
      );
    });
  },

  async list(args) {
    await command(args, async (hub) => {
      await hub.ensureFresh();
      const limit = flagNum(args, "limit") ?? 25;
      const harness = harnessFilter(args);
      const hits = hub.search(undefined, {
        harness,
        repo: flagStr(args, "repo"),
        filePath: flagStr(args, "file"),
        limit,
      });
      if (flagBool(args, "json")) {
        return json(hits.map((h) => h.session));
      }
      if (hits.length === 0) {
        if (flagBool(args, "json")) return json([]);
        return void process.stdout.write("no sessions matched\n");
      }
      const verbose = flagBool(args, "verbose");
      process.stdout.write(`${hits.map((h) => sessionRow(h.session, verbose)).join("\n\n")}\n`);
    });
  },

  async search(args) {
    const query = args.positional[0];
    if (!query) die("usage: sessionhub search <query>");
    await command(args, async (hub) => {
      await hub.ensureFresh();

      // Deep mode reads full transcripts instead of the indexed excerpt. It is
      // slower and bounded, so the count of what it actually read is reported
      // rather than implied.
      if (flagBool(args, "deep")) {
        const deep = await hub.deepSearch(query, {
          harness: harnessFilter(args),
          repo: flagStr(args, "repo"),
          limit: flagNum(args, "limit") ?? 30,
          maxSessions: flagNum(args, "max"),
          onProgress: flagBool(args, "json")
            ? undefined
            : (done, total) => {
                if (done % 25 === 0) process.stderr.write(`\r  read ${done}/${total} transcripts`);
              },
        });
        if (!flagBool(args, "json")) process.stderr.write("\r".padEnd(40) + "\r");
        if (flagBool(args, "json")) {
          return json({
            query,
            scanned: deep.scanned,
            truncated: deep.truncated,
            hits: deep.hits.map((h) => ({ ...h.session, snippet: h.snippet })),
          });
        }
        if (deep.hits.length === 0) {
          return void process.stdout.write(
            `no matches for "${query}" in ${deep.scanned} transcript(s).\n` +
              (deep.truncated ? `Run again with --max ${deep.scanned * 2} to read more.\n` : ""),
          );
        }
        process.stdout.write(
          `${deep.hits.length} match(es) for "${query}" in full transcripts` +
            ` (${deep.scanned} read${deep.truncated ? ", more available with --max" : ""}):\n\n` +
            deep.hits
              .map((h) => `${sessionRow(h.session, flagBool(args, "verbose"))}\n    …${h.snippet}…`)
              .join("\n\n") +
            `\n\nload one with:  sessionhub context <uid>\n`,
        );
        return;
      }

      const hits = hub.search(query, {
        harness: harnessFilter(args),
        repo: flagStr(args, "repo"),
        filePath: flagStr(args, "file"),
        limit: flagNum(args, "limit") ?? 300,
      });
      if (flagBool(args, "json")) return json(hits.map((h) => h.session));
      if (hits.length === 0) {
        if (flagBool(args, "json")) return json([]);
        return void process.stdout.write(
          `no matches for "${query}" in the index. Try --deep to read full transcripts.\n`,
        );
      }
      const verbose = flagBool(args, "verbose");
      process.stdout.write(
        `${hits.length} match(es) for "${query}"\n\n${hits.map((h) => sessionRow(h.session, verbose)).join("\n\n")}\n`,
      );
    });
  },

  async context(args) {
    const uid = args.positional[0];
    if (!uid) die("usage: sessionhub context <uid>");
    await command(args, async (hub) => {
      await hub.ensureFresh();
      const loaded = await hub.contextFor(uid, { charBudget: flagNum(args, "chars") });
      if (!loaded) die(`no session matches "${uid}"`);
      const { session, context } = loaded!;
      if (flagBool(args, "json")) {
        return json({
          uid: session.uid,
          harness: session.harness,
          title: session.title,
          source: session.path,
          chars: context.chars,
          estimatedTokens: context.estimatedTokens,
          includedMessages: context.includedMessages,
          omittedMessages: context.omittedMessages,
          condensedMessages: context.condensedMessages,
          fullMessages: context.fullMessages,
          totalMessages: context.totalMessages,
          sourceMessageCount: context.sourceMessageCount,
          toolResultsCompressed: context.toolResultsCompressed,
          markdown: context.markdown,
        });
      }
      process.stdout.write(`${context.markdown}\n`);
      process.stderr.write(
        `\nimported ${context.includedMessages}/${context.totalMessages} message(s) from ${HARNESS_LABEL[session.harness]}: ` +
          `${context.fullMessages} in full, ${context.condensedMessages} condensed, ${context.omittedMessages} omitted, ` +
          `${context.toolResultsCompressed} tool results compressed, ~${context.estimatedTokens.toLocaleString()} tokens.\n` +
          `source: ${session.path}\n`,
      );
    });
  },

  async show(args) {
    const uid = args.positional[0];
    if (!uid) die("usage: sessionhub show <uid>");
    await command(args, async (hub) => {
      await hub.ensureFresh();
      const session = await hub.get(uid);
      if (!session) die(`no session matches "${uid}"`);
      const limit = flagNum(args, "limit") ?? 2000;
      const messages = session!.messages.slice(-limit);
      if (flagBool(args, "json")) return json({ ...session, messages });
      const header = [
        `${session!.uid}`,
        `${HARNESS_LABEL[session!.harness]}  ${session!.repo ?? session!.cwd ?? "-"}  ${session!.model ?? "-"}`,
        `${session!.messageCount} message(s) in source, showing ${messages.length}`,
        `source: ${session!.path}`,
        "",
      ].join("\n");
      const body = messages
        .map((m) => `--- ${m.role} ---\n${m.text}`)
        .join("\n\n");
      process.stdout.write(`${header}${body}\n`);
    });
  },

  async handoff(args) {
    const uid = args.positional[0];
    if (!uid) die("usage: sessionhub handoff <uid>");
    await command(args, async (hub) => {
      await hub.ensureFresh();
      const result = await hub.handoffFor(uid, { skipWorkingTree: flagBool(args, "fast") });
      if (!result) die(`no session matches "${uid}"`);
      if (flagBool(args, "json")) return json(result);
      process.stdout.write(`${result!.markdown}\n`);
    });
  },

  async native(args) {
    const uid = args.positional[0];
    if (!uid) die("usage: sessionhub native <uid>");
    await command(args, async (hub) => {
      await hub.ensureFresh();
      const result = await hub.nativeFor(uid);
      if (!result) die(`no session matches "${uid}"`);
      const { session, action } = result!;
      if (flagBool(args, "json")) return json({ uid: session.uid, harness: session.harness, action });
      if (!action) {
        process.stdout.write(
          `no verified resume command for ${session.uid} (${HARNESS_LABEL[session.harness]}).\n` +
            `Open it from ${HARNESS_LABEL[session.harness]} itself.\n`,
        );
        return;
      }
      process.stdout.write(
        [
          `${HARNESS_LABEL[session.harness]}: ${session.title ?? session.uid}`,
          "",
          `  ${formatNativeResume(action)}`,
          "",
          `verification: ${action.verificationBasis} - ${action.verificationNote}`,
          action.verified ? "verified" : "NOT verified, do not run",
          "",
        ].join("\n"),
      );
    });
  },
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "version" || args.flags.has("version")) {
    return void (await commands.version(args));
  }
  if (args.flags.has("help") || args.command === "help" || args.command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const handler = commands[args.command];
  if (!handler) {
    process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}\n`);
    process.exit(2);
  }
  try {
    await handler(args);
  } catch (err) {
    if (err instanceof HubReadError) die(`hub error: ${err.message}`);
    throw err;
  }
}

// A single exit point keeps the CLI usable from hooks, where a stray open
// handle would hold the harness open.
//
// Note the absence of process.exit() on the success path: when stdout is a pipe,
// a large payload (a 200-session list, a 40k-character context) is written
// asynchronously, and forcing an exit truncates it into invalid JSON. Setting
// exitCode and letting Node drain is what makes --json reliable.
main().catch((err) => {
  fs.writeSync(2, `${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
