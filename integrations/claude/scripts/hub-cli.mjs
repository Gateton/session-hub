#!/usr/bin/env node
/**
 * The hub's command line, the way this plugin reaches it.
 *
 * The MCP server is how the model normally talks to the hub, but the server can
 * be down, and a person may want to see the raw output. This wrapper exists so
 * there is exactly one answer to "what command do I run": it finds the hub with
 * the shared resolver (an in-plugin vendor copy, $SESSION_HUB_ROOT, a recorded
 * install, a checkout above the current directory, or `sessionhub` on PATH) and
 * passes every argument straight through.
 *
 *   node ${CLAUDE_PLUGIN_ROOT}/scripts/hub-cli.mjs search "auth bug" --json
 *
 * Exit code and output are the hub's own, so it behaves exactly like running
 * `sessionhub` directly, including when the hub is missing: you get the message
 * that says what to install.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runHub } from "./resolve.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(SCRIPT_DIR);

const result = await runHub(process.argv.slice(2), { pluginRoot: PLUGIN_ROOT });

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

process.exit(result.code);
