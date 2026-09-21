/**
 * MCP server implementation.
 *
 * Hand-rolled JSON-RPC over stdio for one reason: the whole project stays
 * dependency-free, so installing it never runs a package manager and never pulls
 * code the user did not ask for.
 *
 * Protocol facts this relies on, both stable in the MCP stdio transport:
 *  - messages are newline-delimited JSON on stdin and stdout
 *  - the harness sends `initialize`, then `notifications/initialized`, then
 *    `tools/list` and `tools/call`
 * stdout must carry protocol messages only, so every diagnostic goes to stderr.
 */

import process from "node:process";

import { Hub, HubReadError } from "../core/hub.ts";
import { HARNESS_LABEL, type HarnessId } from "../core/types.ts";
import { formatNativeResume } from "../core/native.ts";

const SERVER_NAME = "session-hub";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL = "2025-06-18";
const MAX_CONTEXT_CHARS = 120_000;

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "search",
    description:
      "Find coding-agent sessions from any harness on this machine (Claude Code, Codex, OpenCode, Crush, JCode, Pi). " +
      "Use this when the user refers to work done elsewhere: 'continue what I did in Codex', 'the session where we fixed X', " +
      "'what was I doing yesterday', or when you lack context the user assumes you have. " +
      "Returns uid, harness, project, time and title for each match. Pass a uid to `context` to actually load it.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words to match against session titles and conversation text. Bare terms use prefix matching, \"quoted\" matches a phrase, -term excludes.",
        },
        dir: {
          type: "string",
          description:
            "Project directory. Only sessions from that project are returned. When omitted and no query is given, the current working directory is used, which answers 'what was I doing in this repo'. With a query and no dir, every project is searched.",
        },
        harness: {
          type: "string",
          enum: ["claude-code", "codex", "opencode", "crush", "jcode", "pi"],
          description: "Restrict to one harness.",
        },
        limit: { type: "number", description: "Maximum hits, default 15." },
      },
    },
  },
  {
    name: "context",
    description:
      "Load one session's conversation into this conversation, so the user does not have to re-explain it. " +
      "This is the tool for 'continue the work I left in another agent': pick a uid from `search`, call this, and the " +
      "returned text is the real transcript, tiered with a hard budget (recent turns verbatim, older ones condensed, tool " +
      "output compressed) plus a header with the objective, repo, model, files touched and commands run.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Session uid from `search`, e.g. codex:0191ab... A unique prefix is enough." },
        chars: { type: "number", description: "Character budget, default 40000 (~10k tokens). Lower it when context is tight." },
      },
      required: ["uid"],
    },
  },
  {
    name: "native",
    description:
      "Get the verified command that reopens a session in the harness that owns it (for example `codex resume <id>`). " +
      "Use when the user wants to go back to where that work lives rather than continue it here. Never invents a command: " +
      "if no verified resume exists for that session, this says so.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Session uid from `search`." },
      },
      required: ["uid"],
    },
  },
] as const;

let hubPromise: Promise<Hub> | null = null;
let hubReady: Promise<void> | null = null;

async function hub(): Promise<Hub> {
  if (!hubPromise) hubPromise = Hub.open({});
  return hubPromise;
}

/** Scan once per process, on first use. */
async function ready(): Promise<Hub> {
  const h = await hub();
  if (!hubReady) hubReady = h.ensureFresh().catch(() => undefined);
  await hubReady;
  return h;
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function describeError(err: unknown): string {
  if (err instanceof HubReadError) return `session-hub could not read its index: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function formatHit(s: {
  uid: string;
  harness: HarnessId;
  updatedAt: string | null;
  createdAt: string | null;
  repo: string | null;
  cwd: string | null;
  title: string | null;
  preview: string | null;
  model: string | null;
}): string {
  const when = (s.updatedAt ?? s.createdAt ?? "").slice(0, 16).replace("T", " ");
  return [
    `uid: ${s.uid}`,
    `  harness: ${HARNESS_LABEL[s.harness] ?? s.harness}   updated: ${when || "unknown"}   project: ${s.repo ?? s.cwd ?? "unknown"}`,
    `  model: ${s.model ?? "unknown"}`,
    `  title: ${s.title ?? s.preview ?? "(none)"}`,
  ].join("\n");
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const h = await ready();

  if (name === "search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    // No query and no dir means "what was I doing in this project", so the
    // current directory is the honest default. A query without a dir stays
    // global, because that is what asking about a topic means.
    const dir =
      typeof args.dir === "string"
        ? args.dir
        : query
          ? undefined
          : process.cwd();
    const harness = typeof args.harness === "string" ? (args.harness as HarnessId) : undefined;
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 15;

    if (dir) {
      const sessions = h.here(dir, Math.max(limit, 25));
      const filtered = query
        ? sessions.filter((s) => `${s.title ?? ""} ${s.preview ?? ""}`.toLowerCase().includes(query.toLowerCase()))
        : sessions;
      if (filtered.length === 0) {
        return textResult(
          `No sessions found for ${dir}${query ? ` matching "${query}"` : ""} in any harness.\n` +
            `Call search again without \`dir\` to look across every project.`,
        );
      }
      const shown = filtered.slice(0, limit);
      const heading =
        shown.length < filtered.length
          ? `Showing ${shown.length} of ${filtered.length} session(s) for ${dir}${query ? ` matching "${query}"` : ""}:`
          : `${filtered.length} session(s) for ${dir}${query ? ` matching "${query}"` : ""}:`;
      return textResult(
        `${heading}\n\n` +
          shown.map(formatHit).join("\n\n") +
          `\n\nLoad one with the \`context\` tool and its uid.`,
      );
    }

    const hits = h.search(query || undefined, { harness, limit });
    if (hits.length === 0) {
      return textResult(
        `No sessions matched${query ? ` "${query}"` : ""}.\n` +
          `Try fewer or different words, or call search with a \`dir\` to list that project's sessions.`,
      );
    }
    return textResult(
      `${hits.length} match(es)${query ? ` for "${query}"` : ""}:\n\n` +
        hits.map((x) => formatHit(x.session)).join("\n\n") +
        `\n\nLoad one with the \`context\` tool and its uid.`,
    );
  }

  if (name === "context") {
    const uid = typeof args.uid === "string" ? args.uid.trim() : "";
    if (!uid) return textResult("`uid` is required. Get one from the `search` tool.", true);
    const requested = typeof args.chars === "number" && args.chars > 0 ? Math.floor(args.chars) : undefined;
    if (requested && requested > MAX_CONTEXT_CHARS) {
      return textResult(`Refusing a budget above ${MAX_CONTEXT_CHARS} characters. That is more than any session needs.`, true);
    }
    const loaded = await h.contextFor(uid, { charBudget: requested });
    if (!loaded) {
      return textResult(`No session matches "${uid}". Call \`search\` to get a valid uid.`, true);
    }
    const { session, context } = loaded;
    const footer =
      `\n\n---\n` +
      `Imported from ${HARNESS_LABEL[session.harness]}: ${context.fullMessages} recent message(s) verbatim, ` +
      `${context.condensedMessages} older condensed, ${context.omittedMessages} omitted, ` +
      `${context.toolResultsCompressed} tool results compressed. ~${context.estimatedTokens.toLocaleString()} tokens.\n` +
      `Source: ${session.path}\n` +
      `If the user needs the omitted part, call \`context\` again with a larger \`chars\`, or \`native\` to reopen it where it lives.`;
    return textResult(context.markdown + footer);
  }

  if (name === "native") {
    const uid = typeof args.uid === "string" ? args.uid.trim() : "";
    if (!uid) return textResult("`uid` is required. Get one from the `search` tool.", true);
    const result = await h.nativeFor(uid);
    if (!result) return textResult(`No session matches "${uid}". Call \`search\` to get a valid uid.`, true);
    const { session, action } = result;
    if (!action) {
      return textResult(
        `${HARNESS_LABEL[session.harness]} has no verified resume command for ${session.uid}. ` +
          `Open it from ${HARNESS_LABEL[session.harness]} itself, or load its context here with the \`context\` tool.`,
      );
    }
    return textResult(
      `${HARNESS_LABEL[session.harness]}: ${session.title ?? session.uid}\n\n` +
        `  ${formatNativeResume(action)}\n\n` +
        `Verification: ${action.verificationBasis} - ${action.verificationNote}\n` +
        `Status: ${action.verified ? "verified, safe to run" : "not verified, do not run"}\n\n` +
        `Show this command to the user and let them decide; do not run it unprompted.`,
    );
  }

  return textResult(`Unknown tool "${name}".`, true);
}

function send(message: JsonRpc): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message: JsonRpc): Promise<void> {
  // Notifications carry no id and expect no response.
  if (message.id === undefined || message.id === null) return Promise.resolve();

  const id = message.id;
  const method = message.method ?? "";

  if (method === "initialize") {
    const requested = message.params?.protocolVersion;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return Promise.resolve();
  }

  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return Promise.resolve();
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return Promise.resolve();
  }

  if (method === "tools/call") {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    return callTool(name, args)
      .then((result) => send({ jsonrpc: "2.0", id, result }))
      .catch((err) => {
        process.stderr.write(`session-hub tool "${name}" failed: ${describeError(err)}\n`);
        send({ jsonrpc: "2.0", id, result: textResult(describeError(err), true) });
      });
  }

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  return Promise.resolve();
}

export async function start(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpc;
          void handle(message);
        } catch (err) {
          process.stderr.write(`session-hub ignoring an unparseable message: ${describeError(err)}\n`);
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    void hubPromise?.then((h) => h.close()).catch(() => undefined);
    process.exit(0);
  });
}
