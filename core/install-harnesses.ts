/**
 * One-command install, per harness.
 *
 * All three targets expose a command line entry point for installing plugins
 * (verified on this machine: `claude plugin marketplace add` + `claude plugin
 * install`, `codex plugin marketplace add` + `codex plugin add`, and
 * `opencode plugin`), so installing session-hub does not need a TUI, a manual
 * config edit, or a visit to a marketplace website.
 *
 * Two honest wrinkles are handled here rather than hidden:
 *  - Codex loads a plugin's skills and MCP server, but not its `hooks/hooks.json`
 *    (0.154.0), so the delivery hooks are merged into `$CODEX_HOME/hooks.json` by
 *    the integration's own installer, which backs the file up first.
 *  - Codex asks a person to trust hooks once, in `/hooks`. That step cannot be
 *    automated, so it is reported instead of pretended.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface InstallStep {
  /** What was run, written the way a person would type it. */
  command: string;
  ok: boolean;
  output: string;
}

export interface HarnessInstallResult {
  harness: "claude-code" | "codex" | "opencode";
  label: string;
  detected: boolean;
  /** Human-readable reason when not detected. */
  skipped?: string;
  steps: InstallStep[];
  /** The one thing a person still has to do, if anything. */
  manual?: string;
}

export interface InstallOptions {
  root: string;
  only?: string[];
  dryRun?: boolean;
  timeoutMs?: number;
}

/**
 * `%DIR%` is replaced with `dir`: the checkout root for Claude Code and Codex,
 * whose marketplace manifests live at the repository root, and the integration
 * directory for OpenCode, which takes the plugin directory itself.
 *
 * Order matters: the marketplace has to exist before the plugin can be installed
 * from it.
 */
const TARGETS = [
  {
    harness: "claude-code" as const,
    label: "Claude Code",
    binary: "claude",
    integration: "integrations/claude",
    dir: "root" as const,
    commands: [
      ["plugin", "marketplace", "add", "%DIR%"],
      ["plugin", "install", "session-hub@session-hub"],
    ],
  },
  {
    harness: "codex" as const,
    label: "Codex",
    binary: "codex",
    integration: "integrations/codex",
    dir: "root" as const,
    commands: [
      ["plugin", "marketplace", "add", "%DIR%"],
      ["plugin", "add", "session-hub@session-hub"],
    ],
  },
  {
    harness: "opencode" as const,
    label: "OpenCode",
    binary: "opencode",
    integration: "integrations/opencode",
    dir: "integration" as const,
    commands: [["plugin", "%DIR%", "-g"]],
  },
];

function onPath(binary: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, binary);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable PATH entry, keep looking */
    }
  }
  return null;
}

function run(command: string, args: string[], timeoutMs: number): InstallStep {
  const printable = [command, ...args].join(" ");
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, env: process.env });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { command: printable, ok: (result.status ?? 1) === 0, output };
}

/** The root a marketplace with our name is registered at, when it is not ours. */
function staleMarketplace(
  target: (typeof TARGETS)[number],
  opts: InstallOptions,
  timeoutMs: number,
): string | null {
  const list = run(target.binary, ["plugin", "marketplace", "list"], timeoutMs);
  if (!list.ok) return null;
  for (const line of list.output.split("\n")) {
    const cells = line.trim().split(/\s+/);
    if (cells[0] !== "session-hub") continue;
    const root = cells.slice(1).join(" ");
    if (root && root !== opts.root) return root;
  }
  return null;
}

export function installIntegrations(opts: InstallOptions): HarnessInstallResult[] {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const results: HarnessInstallResult[] = [];

  for (const target of TARGETS) {
    if (opts.only && opts.only.length > 0 && !opts.only.includes(target.harness)) continue;

    const result: HarnessInstallResult = {
      harness: target.harness,
      label: target.label,
      detected: false,
      steps: [],
    };

    const binary = onPath(target.binary);
    if (!binary) {
      result.skipped = `${target.binary} is not on PATH`;
      results.push(result);
      continue;
    }
    result.detected = true;

    const integrationDir = path.join(opts.root, target.integration);
    if (!opts.dryRun && !fs.existsSync(integrationDir)) {
      result.skipped = `no integration directory at ${integrationDir}`;
      results.push(result);
      continue;
    }

    // OpenCode's installer refuses a directory without a package.json, which is
    // a real requirement rather than a bug: report it instead of failing obscurely.
    if (!opts.dryRun && target.harness === "opencode" && !fs.existsSync(path.join(integrationDir, "package.json"))) {
      result.skipped = `${integrationDir} has no package.json yet`;
      results.push(result);
      continue;
    }

    // A marketplace is remembered by name and root, so moving the hub (a new
    // checkout, or the staged copy) leaves a stale registration behind and the
    // plain `add` refuses. Converge instead of asking the user to clean up.
    if (!opts.dryRun) {
      const stale = staleMarketplace(target, opts, timeoutMs);
      if (stale) {
        const remove = run(target.binary, ["plugin", "marketplace", "remove", "session-hub"], timeoutMs);
        result.steps.push({
          ...remove,
          command: `${target.binary} plugin marketplace remove session-hub   # was ${stale}`,
        });
      }
    }

    const placeholder = target.dir === "root" ? opts.root : integrationDir;
    for (const command of target.commands) {
      const args = command.map((arg) => (arg === "%DIR%" ? placeholder : arg));
      const printable = [target.binary, ...args].join(" ");
      if (opts.dryRun) {
        result.steps.push({ command: printable, ok: true, output: "(dry run)" });
        continue;
      }
      result.steps.push(run(target.binary, args, timeoutMs));
    }

    // Codex ignores a plugin's own hooks file, so wire them into its config.
    if (target.harness === "codex") {
      const installer = path.join(integrationDir, "scripts", "install-hooks.mjs");
      const stepsOk = result.steps.every((s) => s.ok);
      if (stepsOk && fs.existsSync(installer)) {
        const printable = `node ${installer}`;
        if (opts.dryRun) result.steps.push({ command: printable, ok: true, output: "(dry run)" });
        else result.steps.push(run(process.execPath, [installer], timeoutMs));
        result.manual =
          "Codex: run /hooks once and trust the session-hub entries. Until then the tools and the skill work, " +
          "but a session you pick is not delivered automatically.";
      } else if (!stepsOk) {
        result.manual = "Fix the failing step above, then run: node integrations/codex/scripts/install-hooks.mjs";
      }
    }

    results.push(result);
  }

  return results;
}

export function anyFailed(results: HarnessInstallResult[]): boolean {
  return results.some((r) => r.detected && !r.skipped && r.steps.some((s) => !s.ok));
}
