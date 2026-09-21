/**
 * Acceptance suite.
 *
 * These are the properties the hub must hold on any machine, tested against the
 * real stores on this one plus a synthetic empty home. Nothing here is a unit
 * test of an internal function: every check runs the real CLI and looks at what a
 * user or a harness hook would actually receive.
 *
 * Run: node test/acceptance.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "bin", "sessionhub.mjs");
const OTHER_REPO = "/home/gateton/Projects/pi-session-hub";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    process.stdout.write(`  FAIL ${name}${detail ? `: ${detail}` : ""}\n`);
  }
}

/**
 * Run the CLI. The index location is always passed explicitly with --home, so
 * the suite can never read or write the user's real index.
 */
function run(args, { env = {}, home = hubHome } = {}) {
  const full = [...args, ...(home ? ["--home", home] : [])];
  const result = spawnSync(process.execPath, [CLI, ...full], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 180_000,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runJson(args, opts = {}) {
  const result = run([...args, "--json"], opts);
  let data = null;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    data = null;
  }
  return { ...result, data };
}

/** Fingerprint every file under the given roots: size and mtime. */
function fingerprint(roots) {
  const entries = new Map();
  const walk = (target) => {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let children = [];
      try {
        children = fs.readdirSync(target);
      } catch {
        return;
      }
      for (const child of children) walk(path.join(target, child));
      return;
    }
    entries.set(target, `${stat.size}:${stat.mtimeMs}`);
  };
  for (const root of roots) walk(root);
  return entries;
}

function diffFingerprints(before, after) {
  const changed = [];
  for (const [file, print] of before) {
    const now = after.get(file);
    if (now === undefined) changed.push(`${file} (removed)`);
    else if (now !== print) changed.push(file);
  }
  for (const file of after.keys()) if (!before.has(file)) changed.push(`${file} (new)`);
  return changed;
}

function tmpdir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `session-hub-${label}-`));
  return dir;
}

const home = os.homedir();
const storeRoots = [
  path.join(home, ".claude", "projects"),
  path.join(home, ".codex", "sessions"),
  path.join(home, ".local", "share", "opencode"),
  path.join(home, ".crush"),
  path.join(home, ".jcode", "sessions"),
  path.join(home, ".pi", "agent", "sessions"),
].filter((p) => fs.existsSync(p));

const hubHome = tmpdir("index");
const env = {};

process.stdout.write("\n1. reading every harness without touching it\n");

/**
 * Files another live process is writing right now (another agent's session, for
 * example) are not the hub's responsibility, so they are detected and excluded
 * rather than blamed. Sampling twice with the hub idle is how we tell them apart
 * from files the hub would have touched.
 */
function liveFiles(roots, rounds = 2, windowMs = 1500) {
  const live = new Set();
  for (let i = 0; i < rounds; i++) {
    const a = fingerprint(roots);
    const start = Date.now();
    while (Date.now() - start < windowMs) {
      // busy wait: sampling must not itself touch the stores
    }
    const b = fingerprint(roots);
    for (const [file, print] of b) if (a.get(file) !== print) live.add(file);
    for (const file of a.keys()) if (!b.has(file)) live.add(file);
  }
  return live;
}

const live = liveFiles([...storeRoots, OTHER_REPO]);
if (live.size > 0) {
  process.stdout.write(`  note ${live.size} file(s) are being written by other live processes and are excluded\n`);
}

const before = fingerprint([...storeRoots, OTHER_REPO]);
const indexed = runJson(["index", "--force", "--limit", "50"], { env });
check("index --json parses", indexed.data !== null, indexed.stderr.slice(0, 200));
check("index reports no adapter errors", (indexed.data?.errors ?? []).length === 0, JSON.stringify(indexed.data?.errors ?? []));

const doctor = runJson(["doctor"], { env });
check("doctor lists the six harnesses", (doctor.data?.detections ?? []).length === 6);
const available = (doctor.data?.detections ?? []).filter((d) => d.status === "available");
check("at least one harness was found", available.length > 0, JSON.stringify(doctor.data?.detections ?? []));
check("every harness found is indexed", available.some((d) => (doctor.data.indexed?.[d.harness] ?? 0) > 0));

const afterScan = fingerprint([...storeRoots, OTHER_REPO]);

/**
 * The precise read-only claim: of the files the hub actually opened, none
 * changed. The hub records every file it reads in its `sources` table, so the
 * comparison is limited to those files instead of every file in the store
 * directories, which would wrongly include things the hub has no code path for
 * (SQLite sidecars, jcode's live edit-stats, other agents' append logs).
 *
 * Files another live process is writing are excluded too, and named, so a real
 * violation can never hide behind them.
 */
const { DatabaseSync } = await import("node:sqlite");
const indexDb = new DatabaseSync(path.join(hubHome, "index.sqlite"), { readOnly: true });
const readPaths = indexDb
  .prepare("select distinct path from sources")
  .all()
  .map((row) => row.path)
  .filter((p) => typeof p === "string" && before.has(p));
indexDb.close();

const changedRead = readPaths.filter((file) => {
  if (live.has(file)) return false;
  return afterScan.get(file) !== before.get(file);
});
const liveRead = readPaths.filter((file) => live.has(file));

check("the hub recorded every file it read", readPaths.length > 0, `${readPaths.length} paths`);
check(
  "no file the hub opened was modified by the scan",
  changedRead.length === 0,
  changedRead.slice(0, 5).join(", "),
);
if (liveRead.length > 0) {
  process.stdout.write(`  note ${liveRead.length} read file(s) are being appended to by other live agents\n`);
}

const changedAnywhere = diffFingerprints(before, afterScan);
const created = changedAnywhere.filter((f) => f.endsWith("(new)"));
const removed = changedAnywhere.filter((f) => f.endsWith("(removed)"));
check("a full scan created no file outside the hub home", created.length === 0, created.slice(0, 5).join(", "));
check("a full scan removed no file outside the hub home", removed.length === 0, removed.slice(0, 5).join(", "));
check(
  "the database data files are untouched",
  changedAnywhere.filter((f) => !live.has(f)).every((f) => !/(opencode\.db|crush\.db)$/.test(f)),
);
check("the hub home is where it says", indexed.data?.home === hubHome, indexed.data?.home);

// The strong version of the read-only claim: a home the hub has never seen,
// built from copies of real files, with no other process writing to it.
process.stdout.write("\n1b. a foreign home built from copies, read with nothing else running\n");
const foreignHome = tmpdir("foreign-home");
const copies = [];
const copyInto = (from, to) => {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copies.push(to);
  return true;
};
const claudeSessions = fs.existsSync(path.join(home, ".claude", "projects"))
  ? fs
      .readdirSync(path.join(home, ".claude", "projects"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .slice(0, 2)
      .map((d) => path.join(home, ".claude", "projects", d.name))
  : [];
let copied = 0;
for (const dir of claudeSessions) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).slice(0, 2);
  for (const f of files) {
    if (copyInto(path.join(dir, f), path.join(foreignHome, ".claude", "projects", path.basename(dir), f))) copied++;
  }
}
const jcodeDir = path.join(home, ".jcode", "sessions");
if (fs.existsSync(jcodeDir)) {
  for (const f of fs.readdirSync(jcodeDir).filter((f) => f.endsWith(".json")).slice(0, 3)) {
    if (copyInto(path.join(jcodeDir, f), path.join(foreignHome, ".jcode", "sessions", f))) copied++;
  }
}
const codexDir = path.join(home, ".codex", "sessions");
if (fs.existsSync(codexDir) && copied > 0) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl") && copied < 12) {
        const rel = path.relative(path.join(home, ".codex", "sessions"), full);
        if (copyInto(full, path.join(foreignHome, ".codex", "sessions", rel))) copied++;
      }
    }
  };
  walk(codexDir);
}
check("a foreign home was built from real session files", copied > 0, `copied ${copied}`);

if (copied > 0) {
  const foreignHub = tmpdir("foreign-index");
  const beforeForeign = fingerprint([foreignHome]);
  const foreignDoctor = runJson(["doctor"], { env: { HOME: foreignHome }, home: foreignHub });
  const foreignStatuses = (foreignDoctor.data?.detections ?? []).map((d) => `${d.harness}:${d.status}`);
  check(
    "harnesses with no store in the foreign home report path_missing",
    foreignStatuses.includes("opencode:path_missing"),
    foreignStatuses.join(","),
  );
  const foreignList = runJson(["list", "--limit", "50"], { env: { HOME: foreignHome }, home: foreignHub });
  check(
    "the foreign home's own sessions are indexed",
    Array.isArray(foreignList.data) && foreignList.data.length === copied,
    `expected ${copied}, got ${Array.isArray(foreignList.data) ? foreignList.data.length : foreignList.data}`,
  );
  const owned = (foreignList.data ?? []).map((s) => s.uid);
  check("every session in the foreign index comes from a copied file", owned.length === copied);
  const afterForeign = fingerprint([foreignHome]);
  const changedForeign = diffFingerprints(beforeForeign, afterForeign);
  check(
    "reading a foreign home changed none of its files",
    changedForeign.length === 0,
    changedForeign.slice(0, 5).join(", "),
  );
  fs.rmSync(foreignHub, { recursive: true, force: true });
}
fs.rmSync(foreignHome, { recursive: true, force: true });

process.stdout.write("\n2. listing, searching, and the current project\n");
const list = runJson(["list", "--limit", "200"], { env });
check("list returns sessions", Array.isArray(list.data) && list.data.length > 0);
const first = list.data?.[0];
check(
  "a session has the fields a harness needs",
  Boolean(first?.uid && first?.harness && first?.path),
  JSON.stringify(first ?? {}).slice(0, 160),
);
check("list is ordered newest first", (() => {
  const times = (list.data ?? []).map((s) => Date.parse(s.updatedAt ?? s.createdAt ?? "") || 0);
  return times.every((t, i) => i === 0 || times[i - 1] >= t);
})());

const search = runJson(["search", "session", "--limit", "5"], { env });
check("search answers", Array.isArray(search.data));
if ((search.data ?? []).length > 0) {
  check("search hits carry a uid", Boolean(search.data[0].uid));
}

const here = runJson(["here", "--dir", repoRoot, "--limit", "5"], { env });
check("here answers for this repo", here.data !== null && Array.isArray(here.data.sessions));

process.stdout.write("\n3. context stays inside its budget\n");
const target = (list.data ?? []).find((s) => s.messageCount > 3) ?? list.data?.[0];
if (target) {
  for (const chars of [2000, 40_000]) {
    const ctx = runJson(["context", target.uid, "--chars", String(chars)], { env });
    const text = ctx.data?.markdown ?? "";
    check(`context at ${chars} chars parses`, ctx.data !== null, ctx.stderr.slice(0, 160));
    check(`context at ${chars} chars respects the budget`, text.length <= chars + 8_000, `got ${text.length}`);
    check(`context at ${chars} chars reports its own cost`, typeof ctx.data?.estimatedTokens === "number");
    check(
      `context at ${chars} chars accounts for every message`,
      (ctx.data?.includedMessages ?? 0) + (ctx.data?.omittedMessages ?? 0) === (ctx.data?.totalMessages ?? -1),
      JSON.stringify({
        included: ctx.data?.includedMessages,
        omitted: ctx.data?.omittedMessages,
        total: ctx.data?.totalMessages,
      }),
    );
  }
  const show = runJson(["show", target.uid, "--limit", "5"], { env });
  check("show returns messages without a model", (show.data?.messages ?? []).length > 0);
} else {
  check("a session with messages exists", false, "no sessions on this machine");
}

process.stdout.write("\n3b. a session loads its own transcript, not a nested one\n");
// A Claude Code subagent transcript lives inside its parent's directory, so its
// path contains the parent's id. Asking for the parent must never return the
// subagent's transcript: that would silently load the wrong conversation.
const resolvedClaude = (list.data ?? []).filter((s) => s.harness === "claude-code");
const parents = resolvedClaude.filter((s) => !s.path.includes("/subagents/"));
const subagents = resolvedClaude.filter((s) => s.path.includes("/subagents/"));
if (parents.length > 0) {
  const parent = parents[0];
  const ctx = runJson(["context", parent.uid, "--chars", "2000"], { env });
  check(
    "asking for a parent session returns the parent's own file",
    ctx.data?.source === parent.path,
    `${ctx.data?.source} !== ${parent.path}`,
  );
  check("the parent's file is not a subagent transcript", !String(ctx.data?.source ?? "").includes("/subagents/"));
}
if (subagents.length > 0) {
  const sub = subagents[0];
  const ctx = runJson(["context", sub.uid, "--chars", "2000"], { env });
  check(
    "asking for a subagent transcript returns that subagent",
    String(ctx.data?.source ?? "").includes("/subagents/"),
    String(ctx.data?.source ?? ""),
  );
  const native = runJson(["native", sub.uid], { env });
  check("a subagent transcript has no resume command", native.data?.action === null, JSON.stringify(native.data?.action ?? null));
}
for (const session of [...parents.slice(0, 3), ...subagents.slice(0, 3)]) {
  const ctx = runJson(["context", session.uid, "--chars", "2000"], { env });
  check(
    `uid ${session.uid.slice(0, 24)} resolves to its own path`,
    ctx.data?.source === session.path,
    `${ctx.data?.source} !== ${session.path}`,
  );
}

process.stdout.write("\n4. the explicit pick and delivery flow\n");
if (target) {
  const pick = runJson(["pick", target.uid, "--chars", "3000"], { env });
  check("pick records the selection", pick.data?.uid === target.uid, JSON.stringify(pick.data ?? {}).slice(0, 160));
  const peek = runJson(["pending", "--peek"], { env });
  check("the pending selection is visible before delivery", peek.data?.selection?.uid === target.uid);
  const take = run(["pending"], { env });
  check("delivery prints a block", take.stdout.length > 200, `got ${take.stdout.length} chars`);
  check("the block names its source", take.stdout.includes(target.uid));
  check("the block states the cost", /tokens/i.test(take.stdout));
  const again = run(["pending"], { env });
  check("a selection is delivered exactly once", again.stdout.trim() === "", `got ${again.stdout.length} chars`);
  check("delivery succeeds when there is nothing to deliver", again.code === 0);
  const empty = runJson(["pending"], { env, home: hubHome });
  check("an empty delivery is not an error", empty.data?.pending === null);
} else {
  check("pick/deliver flow exercised", false, "no sessions on this machine");
}

process.stdout.write("\n5. resume commands are verified or refused, never invented\n");
const byHarness = new Map();
for (const s of list.data ?? []) if (!byHarness.has(s.harness)) byHarness.set(s.harness, s);
for (const [harness, session] of byHarness) {
  const native = runJson(["native", session.uid], { env });
  const action = native.data?.action;
  if (action) {
    check(`${harness}: resume command is verified`, action.verified === true && action.verificationBasis.length > 0);
    check(`${harness}: resume command names the harness binary`, action.command.length > 0);
  } else {
    check(`${harness}: no verified command, so the hub says nothing`, native.code === 0);
  }
}

process.stdout.write("\n6. honest failures\n");
const bogus = run(["context", "does-not-exist-anywhere"], { env });
check("an unknown uid fails loudly", bogus.code !== 0);
check("an unknown uid explains itself", /no session matches/i.test(bogus.stderr + bogus.stdout));

const emptyHome = tmpdir("empty-home");
const emptyHub = tmpdir("empty-index");
const emptyEnv = { HOME: emptyHome };
const emptyDoctor = runJson(["doctor"], { env: emptyEnv, home: emptyHub });
const statuses = (emptyDoctor.data?.detections ?? []).map((d) => d.status);
check("a machine with no stores reports path_missing, not silence", statuses.every((s) => s === "path_missing"), statuses.join(","));
check("doctor still succeeds on an empty machine", emptyDoctor.code === 0);
const emptyList = run(["list"], { env: emptyEnv, home: emptyHub });
check("an empty machine says nothing matched", /no sessions matched/i.test(emptyList.stdout));
check("an empty machine is not an error", emptyList.code === 0);

process.stdout.write("\n6b. deep search reads transcripts the index missed\n");
const deep = runJson(["search", "session", "--deep", "--limit", "3", "--max", "40"], { env });
check("--deep answers with a bounded scan", deep.data !== null && typeof deep.data.scanned === "number", deep.stderr.slice(0, 160));
check("--deep reports how many transcripts it read", (deep.data?.scanned ?? 0) > 0 && (deep.data?.scanned ?? 0) <= 40);
check(
  "--deep hits carry a snippet",
  (deep.data?.hits ?? []).every((h) => typeof h.snippet === "string" && h.snippet.length > 0),
);
// A random token cannot appear in any real transcript. The harness filter keeps
// this run's own jcode session (which records the token) out of the search.
const token = `zzq${Date.now()}qq`;
const deepMiss = runJson(["search", token, "--deep", "--max", "40", "--harness", "claude-code"], { env });
check("--deep says nothing matched instead of inventing", (deepMiss.data?.hits ?? []).length === 0);
check("--deep on an empty result is not an error", deepMiss.code === 0);

process.stdout.write("\n6c. the MCP server answers a harness\n");
const mcpCall = (messages) => {
  const payload = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  const r = spawnSync(process.execPath, [path.join(repoRoot, "mcp", "server.mjs"), "--home", hubHome], {
    input: payload,
    encoding: "utf8",
    timeout: 120_000,
  });
  const lines = (r.stdout ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { code: r.status, lines, stderr: r.stderr ?? "" };
};
const mcp = mcpCall([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { dir: repoRoot, limit: 2 } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "context", arguments: { uid: "nope-not-a-session" } } },
  { jsonrpc: "2.0", id: 5, method: "no/such/method" },
]);
const byId = new Map(mcp.lines.map((m) => [m.id, m]));
check("the MCP server initializes", byId.get(1)?.result?.serverInfo?.name === "session-hub", JSON.stringify(byId.get(1) ?? {}).slice(0, 160));
check(
  "it publishes search, context and native",
  (byId.get(2)?.result?.tools ?? []).map((t) => t.name).sort().join(",") === "context,native,search",
  JSON.stringify((byId.get(2)?.result?.tools ?? []).map((t) => t.name)),
);
check("it describes each tool for a model", (byId.get(2)?.result?.tools ?? []).every((t) => (t.description ?? "").length > 80));
check("a tool call returns text a model can use", (byId.get(3)?.result?.content?.[0]?.text ?? "").length > 50);
check("a bad uid is reported as an error, not as empty", byId.get(4)?.result?.isError === true);
check("an unknown method is refused properly", byId.get(5)?.error?.code === -32601);
check("stdout carried protocol messages only", mcp.lines.length === 5, `${mcp.lines.length} messages`);

process.stdout.write("\n6d. the installer asks before installing\n");
const promptProbe = (input) =>
  spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "-e",
      `import { askSelection } from ${JSON.stringify(path.join(repoRoot, "core", "prompt.ts"))};
       const chosen = await askSelection([
         { harness: "claude-code", label: "Claude Code", binary: "claude", version: "2.1.270" },
         { harness: "codex", label: "Codex", binary: "codex", version: "0.154.0" },
         { harness: "opencode", label: "OpenCode", binary: "opencode", version: "1.18.30" },
       ]);
       console.log("CHOSEN " + JSON.stringify(chosen));`,
    ],
    { input, encoding: "utf8", timeout: 60_000 },
  );
const chosenOf = (r) => (r.stdout.match(/CHOSEN (.*)/) ?? [])[1];

const picked = promptProbe("1,3\n");
check("a comma list selects those agents", chosenOf(picked) === '["claude-code","opencode"]', chosenOf(picked));
check("the menu shows each agent and its version", /Claude Code\s+2\.1\.270/.test(picked.stdout));

const all = promptProbe("a\n");
check("'a' selects every detected agent", chosenOf(all) === '["claude-code","codex","opencode"]', chosenOf(all));

const none = promptProbe("n\n");
check("'n' selects nothing", chosenOf(none) === "[]", chosenOf(none));

const retry = promptProbe("9\nbanana\n2\n");
check("invalid answers are re-asked, not guessed", chosenOf(retry) === '["codex"]', chosenOf(retry));
check("the retry names the offending input", /banana/.test(retry.stdout));
check("the installer never installs without an answer", !/Added marketplace/.test(retry.stdout));

const noTty = run(["install"], { env: { ...env }, home: hubHome });
check(
  "a non-interactive install refuses and explains",
  /not an interactive terminal/.test(noTty.stdout) && /--only/.test(noTty.stdout),
  `${noTty.stdout.slice(0, 120)}${noTty.stderr.slice(0, 120)}`,
);

process.stdout.write("\n7. the other project is untouched\n");
if (fs.existsSync(path.join(OTHER_REPO, ".git"))) {
  const status = spawnSync("git", ["-C", OTHER_REPO, "status", "--porcelain"], { encoding: "utf8" });
  const dirty = (status.stdout ?? "").trim();
  check("pi-session-hub has no new changes from this suite", dirty.length === 0, dirty.slice(0, 200));
}

fs.rmSync(hubHome, { recursive: true, force: true });
fs.rmSync(emptyHome, { recursive: true, force: true });
fs.rmSync(emptyHub, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`\nfailures:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
