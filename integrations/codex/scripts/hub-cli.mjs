#!/usr/bin/env node
/**
 * The hub's command line, the way this plugin reaches it.
 *
 * The MCP server is how the model normally talks to the hub, but the server can
 * be down, and a person may want to see the raw output. This wrapper exists so
 * there is exactly one answer to "what command do I run": it finds the hub with
 * the shared resolver (an in-plugin vendor copy, $SESSION_HUB_ROOT, the install
 * record, or a checkout above the current directory) and passes argv through.
 *
 * It replaces a relative path into the repository, which does not exist once the
 * plugin has been copied into a harness's cache.
 */

import { hubRoot, missingHubMessage, runHub } from "./resolve.mjs";

const args = process.argv.slice(2);
const root = hubRoot(new URL("..", import.meta.url).pathname);

if (!root) {
  process.stderr.write(`${missingHubMessage()}\n`);
  process.exit(127);
}

const result = await runHub(args, { pluginRoot: new URL("..", import.meta.url).pathname });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.code === 0 ? 0 : result.code);
