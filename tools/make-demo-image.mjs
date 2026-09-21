#!/usr/bin/env node
/**
 * Regenerate `assets/opencode-hub.png`: the screenshot at the top of the README.
 *
 * One command, no manual steps, no state that a previous run left behind:
 *
 *   node tools/make-demo-image.mjs
 *
 * What it does, in order:
 *
 *   1. builds a synthetic home (`test/fixtures/demo-home.mjs`) with eighteen
 *      invented sessions, three in each of the six harnesses, so nothing from
 *      this machine ends up in a public image;
 *   2. builds the hub's index from that home with the real CLI, and refuses to
 *      go on unless `sessionhub doctor` reports all six harnesses `ok` with
 *      sessions. A picture that quietly dropped a harness would be worse than
 *      no picture;
 *   3. starts OpenCode in a real pty pointed at a scratch config that loads this
 *      checkout's plugin, presses `alt+h`, and captures the ANSI stream
 *      (`test/tools/capture.py`);
 *   4. renders that stream to a PNG (`test/tools/png.py`), applying cursor
 *      positioning, 24-bit colour, backgrounds and the alternate screen.
 *
 * The demo projects live at `/srv/work/<project>` inside a private mount
 * namespace when the machine allows one, which is what makes the paths in the
 * image read like the fixture's own `/srv/work/acme-api` rather than a scratch
 * directory. Without a namespace it falls back to a directory under the demo
 * root and says so.
 *
 * Everything it creates lives under the demo root (a temporary directory) and in
 * `assets/`. It never reads or writes the real `~/.session-hub`, never touches
 * a real harness store, and never modifies a file in this repository other than
 * the image it is asked to write.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDemoHome } from "../test/fixtures/demo-home.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "bin", "sessionhub.mjs");
const CAPTURE = path.join(REPO, "test", "tools", "capture.py");
const PNG = path.join(REPO, "test", "tools", "png.py");
const PLUGIN = path.join(REPO, "integrations", "opencode");

/** Harnesses `doctor` must report as available, with at least one session. */
const HARNESSES = ["pi", "claude-code", "codex", "opencode", "crush", "jcode"];

function parseArgs(argv) {
  const args = {
    cols: 140,
    rows: 44,
    size: 26,
    out: path.join(REPO, "assets", "opencode-hub.png"),
    // Deliberately not `os.tmpdir()`: on a machine where TMPDIR points into the
    // user's home, the demo home lands under /home/<user>/... and the image then
    // shows that path in the "Source path" line. A fixed, obviously synthetic
    // location keeps a public screenshot free of anyone's real directories.
    demoRoot:
      process.env.SESSION_HUB_DEMO_ROOT ??
      (process.platform === "linux" ? "/tmp/session-hub-demo" : path.join(os.tmpdir(), "session-hub-demo")),
    keep: false,
    noNamespace: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === "--cols") args.cols = Number(next());
    else if (token === "--rows") args.rows = Number(next());
    else if (token === "--size") args.size = Number(next());
    else if (token === "--out") args.out = path.resolve(next());
    else if (token === "--demo-root") args.demoRoot = path.resolve(next());
    else if (token === "--keep") args.keep = true;
    else if (token === "--no-namespace") args.noNamespace = true;
    else if (token === "-h" || token === "--help") {
      process.stdout.write(
        "usage: node tools/make-demo-image.mjs [--cols N] [--rows N] [--size N] [--out FILE]\n" +
          "                                   [--demo-root DIR] [--keep] [--no-namespace]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`make-demo-image: unknown argument ${token}\n`);
      process.exit(2);
    }
  }
  return args;
}

function log(message) {
  process.stdout.write(`make-demo-image: ${message}\n`);
}

function step(title) {
  process.stdout.write(`\n=== ${title}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
    cwd: options.cwd ?? REPO,
    timeout: options.timeoutMs ?? 600_000,
  });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

/**
 * Re-exec inside a private mount namespace with a tmpfs at /srv.
 *
 * The fixture's project paths (`/srv/work/acme-api`) are the point: an image
 * that shows `/tmp/session-hub-demo/work/acme-api` reads like a test fixture,
 * and the paths are truncated at the width the browser gives them. A user
 * namespace with a tmpfs over /srv makes those paths real for the length of the
 * run without needing root and without touching the machine's own /srv.
 *
 * Returns true when it has re-execed (so the caller should exit).
 */
function reexecInNamespace(args) {
  if (args.noNamespace || process.env.SESSION_HUB_DEMO_NAMESPACE === "1") return false;
  if (process.platform !== "linux") return false;
  const probe = spawnSync("unshare", ["-rm", "true"], { stdio: "ignore", timeout: 20_000 });
  if (probe.status !== 0) return false;

  const script = [
    "set -euo pipefail",
    "mount -t tmpfs tmpfs /srv 2>/dev/null || true",
    `mkdir -p ${JSON.stringify("/srv/work")} ${JSON.stringify("/srv/demo")}`,
    `export SESSION_HUB_DEMO_NAMESPACE=1`,
    `export SESSION_HUB_DEMO_WORK=${JSON.stringify("/srv/work")}`,
    `export SESSION_HUB_DEMO_LAUNCH=${JSON.stringify("/srv/demo")}`,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(REPO, "tools", "make-demo-image.mjs"))} ${process.argv
      .slice(2)
      .map((a) => JSON.stringify(a))
      .join(" ")}`,
  ].join("\n");
  log("entering a private mount namespace so the demo projects can live at /srv/work");
  const result = spawnSync("unshare", ["-rm", "--propagation", "private", "bash", "-c", script], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

/** Where the demo projects live, and where OpenCode is started from. */
function layout(args) {
  const fromNamespace = process.env.SESSION_HUB_DEMO_NAMESPACE === "1";
  return {
    inNamespace: fromNamespace,
    workRoot: process.env.SESSION_HUB_DEMO_WORK ?? path.join(args.demoRoot, "work"),
    // Not a parent of `workRoot`: OpenCode passes its own directory to the hub,
    // and a directory that contains indexed sessions would narrow the browser to
    // that project. Crush records no working directory, so a project-scoped view
    // can never list it. Starting outside every project is what puts all six
    // harnesses on screen at once.
    launchDir: process.env.SESSION_HUB_DEMO_LAUNCH ?? path.join(args.demoRoot, "demo"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (reexecInNamespace(args)) return 0;

  const place = layout(args);
  const root = args.demoRoot;
  const home = path.join(root, "home");
  const hub = path.join(root, "hub");
  const config = path.join(root, "config");
  const captureFile = path.join(root, "opencode-hub.ansi");

  step("synthetic home");
  log(`demo root: ${root}`);
  log(`projects:  ${place.workRoot}${place.inNamespace ? " (private namespace)" : " (no namespace available)"}`);
  const demo = await buildDemoHome({ root, workRoot: place.workRoot, now: Date.now() });
  fs.mkdirSync(place.launchDir, { recursive: true });
  const counts = Object.entries(demo.counts)
    .map(([harness, n]) => `${harness} ${n}`)
    .join(", ");
  log(`wrote ${Object.values(demo.counts).reduce((a, b) => a + b, 0)} sessions: ${counts}`);

  step("hub index and doctor");
  const env = { HOME: home, SESSION_HUB_HOME: hub };
  run(process.execPath, [CLI, "index", "--force"], { env });
  const doctor = run(process.execPath, [CLI, "doctor", "--json"], { env, capture: true });
  const report = JSON.parse(doctor.stdout);
  const missing = [];
  for (const harness of HARNESSES) {
    const detection = report.detections.find((d) => d.harness === harness);
    const indexed = report.indexed[harness] ?? 0;
    if (!detection || detection.status !== "available" || !indexed) {
      missing.push(`${harness} (${detection?.status ?? "not detected"}, ${indexed} indexed)`);
    }
    log(`${harness.padEnd(12)} ${detection?.status ?? "?"}  ${String(indexed).padStart(2)} indexed`);
  }
  if (missing.length) {
    throw new Error(
      `doctor did not report every harness with sessions: ${missing.join(", ")}. ` +
        "An image missing a harness would misrepresent the hub, so nothing was rendered.",
    );
  }

  step("scratch OpenCode config");
  fs.mkdirSync(path.join(config, "opencode"), { recursive: true });
  // Two halves, two files. `opencode.json` is what the server reads (tools and
  // the /hub command) and `tui.json` is what the TUI reads (the browser). A
  // plugin listed only in `opencode.json` loads the server half and nothing
  // else, which is exactly what happened the first time this was driven by
  // hand; see docs/demo.md.
  fs.writeFileSync(
    path.join(config, "opencode", "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [PLUGIN] }, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(config, "opencode", "tui.json"),
    JSON.stringify({ $schema: "https://opencode.ai/tui.json", plugin: [PLUGIN] }, null, 2) + "\n",
  );
  log(`config: ${path.join(config, "opencode")}`);

  step("capture");
  const steps = [
    { sleep: 2 },
    // Wait for the host's own home screen rather than sleeping a fixed number of
    // seconds. A key sent before the TUI is interactive is delivered to a program
    // that has not registered its keymaps yet, and simply does nothing: the first
    // version of this script pressed alt+h eight seconds in and captured the
    // splash screen instead of the browser.
    { wait: "Ask anything", timeout: 60 },
    { sleep: 2 },
    // alt+h: an ESC byte then h. ctrl+shift+h needs the kitty keyboard protocol,
    // which this pty declares it does not speak.
    { send: "\u001bh" },
    { wait: "open again from anywhere", timeout: 25 },
    // The list loads lazily on the first open and the preview reads a transcript
    // off disk; both are free but neither is instant.
    { sleep: 5 },
    { mark: "capture" },
    { send: "\u001b" },
    { sleep: 0.4 },
    { send: "\u0003" },
    { sleep: 1.0 },
  ];
  const stepsFile = path.join(root, "steps.json");
  fs.writeFileSync(stepsFile, JSON.stringify(steps, null, 2) + "\n");

  // "open again from anywhere" is the browser's own footer line. It appears
  // nowhere else in OpenCode, so it is a truthful test of "the route is on
  // screen" rather than "the capture produced bytes".
  const browserMarker = "open again from anywhere";
  const attempts = 4;
  let captured = false;
  for (let attempt = 1; attempt <= attempts && !captured; attempt++) {
    if (attempt > 1) log(`capture attempt ${attempt} of ${attempts}`);
    run("python3", [
      CAPTURE,
      "--out", captureFile,
      "--script", stepsFile,
      "--cols", String(args.cols),
      "--rows", String(args.rows),
      "--cwd", place.launchDir,
      "--env", `HOME=${home}`,
      "--env", `SESSION_HUB_HOME=${hub}`,
      "--env", `SESSION_HUB_ROOT=${REPO}`,
      "--env", `XDG_CONFIG_HOME=${config}`,
      "--env", `XDG_DATA_HOME=${path.join(home, ".local", "share")}`,
      "--env", `XDG_STATE_HOME=${path.join(home, ".local", "state")}`,
      "--env", `XDG_CACHE_HOME=${path.join(home, ".cache")}`,
      "--env", "COLORTERM=truecolor",
      "--", "opencode",
    ]);
    captured = fs.readFileSync(captureFile).includes(browserMarker);
    if (!captured && attempt < attempts) {
      log("the browser did not open in that attempt; starting a fresh one");
    }
  }
  if (!captured) {
    throw new Error(
      `the browser never opened in ${attempts} attempts: no ${JSON.stringify(browserMarker)} ` +
        `in ${captureFile}. Check that tui.json in ${config} lists the plugin, and that ` +
        "the hub CLI resolves for the plugin (SESSION_HUB_ROOT).",
    );
  }

  step("render");
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const rendered = run(
    "python3",
    [PNG, captureFile, args.out, "--cols", String(args.cols), "--rows", String(args.rows), "--size", String(args.size)],
    { capture: true },
  );
  process.stdout.write(rendered.stdout);
  const bytes = fs.statSync(args.out).size;
  log(`${path.relative(REPO, args.out)}: ${bytes} bytes`);

  if (!args.keep) {
    fs.rmSync(captureFile + ".raw", { force: true });
  }
  process.stdout.write(
    `\nDone. Look at the image before trusting it: the six markers should be six\n` +
      `different colours, the preview pane should have the imported package in it,\n` +
      `and the header and footer should be readable.\n` +
      `Raw capture kept at ${captureFile}${fs.existsSync(captureFile + ".raw") ? " and " + captureFile + ".raw" : ""}\n`,
  );
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  process.stderr.write(`make-demo-image: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
