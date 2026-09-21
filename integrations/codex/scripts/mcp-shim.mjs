#!/usr/bin/env node
/**
 * MCP shim for Codex.
 *
 * Codex copies an installed plugin into its own cache, so `.mcp.json` cannot
 * point at a path inside the session-hub checkout. The plugin has to find the
 * hub the same way its hook does, through the shared resolver, and this file is
 * that one line of glue. It holds no protocol logic of its own when the hub is
 * there: it hands the real server the same stdio Codex handed it.
 *
 * When the hub cannot be found anywhere, exiting silently would leave three
 * tools that never answer, and the user would see a plugin that appears
 * installed and does nothing. Instead the shim speaks just enough JSON-RPC to
 * complete the handshake, list the same three tools, and fail every call with
 * the sentence that says how to fix the installation. That puts the failure
 * where the user will actually read it: in the answer to their question.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hubRoot, missingHubMessage } from "./resolve.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Codex sets PLUGIN_ROOT for plugin resources; the alias is kept for compatibility. */
const PLUGIN_ROOT =
  process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || path.dirname(SCRIPT_DIR);

const root = hubRoot(PLUGIN_ROOT);

if (root) {
  const child = spawn(process.execPath, [path.join(root, "mcp", "server.mjs")], {
    stdio: "inherit",
    env: { ...process.env, SESSION_HUB_ROOT: root },
  });

  // A harness that stops the session usually signals this process first. Pass the
  // signal through so the server it owns shuts down the same way.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    });
  }

  child.on("error", (err) => {
    process.stderr.write(`session-hub: could not start the MCP server: ${err.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
} else {
  await degradedServer();
}

/**
 * The hub is missing. Answer the handshake, list the same three tools, and make
 * every call return the message that tells the user what to run.
 */
async function degradedServer() {
  const reason = missingHubMessage();
  const unavailable = `Unavailable: ${reason.replace(/\n+/g, " ").trim()}`;
  const tools = [
    {
      name: "search",
      description: unavailable,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to match against session titles and conversation text." },
          dir: { type: "string", description: "Project directory. Defaults to the current working directory." },
          harness: { type: "string", description: "Restrict to one harness." },
          limit: { type: "number", description: "Maximum hits." },
        },
      },
    },
    {
      name: "context",
      description: unavailable,
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Session uid from `search`." },
          chars: { type: "number", description: "Character budget." },
        },
        required: ["uid"],
      },
    },
    {
      name: "native",
      description: unavailable,
      inputSchema: {
        type: "object",
        properties: { uid: { type: "string", description: "Session uid from `search`." } },
        required: ["uid"],
      },
    },
  ];

  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

  const handle = (request) => {
    const id = request?.id;
    const method = request?.method;
    if (typeof method !== "string") return;
    if (method.startsWith("notifications/")) return; // notifications take no reply

    const reply = (result) => write({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

    switch (method) {
      case "initialize":
        // Answer with the version the client asked for: it is a client-side choice
        // and the hub cannot be asked what it supports when it is not installed.
        reply({
          protocolVersion: request?.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "session-hub", version: "unavailable" },
        });
        return;
      case "tools/list":
        reply({ tools });
        return;
      case "tools/call":
        reply({ content: [{ type: "text", text: reason }], isError: true });
        return;
      case "resources/list":
        reply({ resources: [] });
        return;
      case "prompts/list":
        reply({ prompts: [] });
        return;
      case "ping":
        reply({});
        return;
      default:
        fail(-32601, `Method not found: ${method}. session-hub's CLI was not found, so only the handshake, tools/list and tools/call are answered.`);
    }
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          handle(JSON.parse(line));
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  // The client closing stdin is how a stdio server learns the session is over.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
}
