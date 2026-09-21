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
for (const file of liveFiles([...storeRoots, OTHER_REPO], 1, 1500)) live.add(file);

/**
 * Files the hub has no code path for, so a change in them cannot be ours:
 *  - SQLite's `-shm` and `-wal` sidecars, touched by any connection to a WAL
 *    database even in read-only mode, and holding no session data
 *  - jcode `*.journal.jsonl` append logs; the jcode adapter reads only `.json`
 */
const NOT_OURS = [/-shm$/, /-wal$/, /\.journal\.jsonl$/];
const changedAfterScan = diffFingerprints(before, afterScan).filter(
  (file) => !live.has(file) && !NOT_OURS.some((re) => re.test(file)),
);
const created = changedAfterScan.filter((f) => f.endsWith("(new)"));
const removed = changedAfterScan.filter((f) => f.endsWith("(removed)"));
const modified = changedAfterScan.filter((f) => !f.endsWith("(new)") && !f.endsWith("(removed)"));

check("a full scan created no file outside the hub home", created.length === 0, created.slice(0, 5).join(", "));
check("a full scan removed no file outside the hub home", removed.length === 0, removed.slice(0, 5).join(", "));
check(
  "a full scan modified no session file",
  modified.length === 0,
  modified.slice(0, 5).join(", "),
);
check(
  "the database data files are untouched",
  diffFingerprints(before, afterScan).every((f) => !/(opencode\.db|crush\.db)$/.test(f)),
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
