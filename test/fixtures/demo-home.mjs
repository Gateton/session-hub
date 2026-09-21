/**
 * Build a synthetic home that looks like somebody else's machine.
 *
 * Two jobs, both about honesty:
 *
 *  1. The screenshot the README shows for OpenCode is a public artefact. It must not
 *     contain a single string from this machine's real session stores, so every
 *     session here is invented: invented project names, invented repositories,
 *     invented conversations. Nothing in this file reads the user's data.
 *  2. The adapters must be exercised against a home they have never seen, with
 *     formats that match what the real harnesses write. If a format detail is
 *     wrong, `sessionhub doctor` says so and the image does not get made.
 *
 * The dataset is: three projects (`acme-api`, `ledger-ui`, `search-service`),
 * eighteen sessions, three per harness, all six harnesses. Each session has an
 * opening exchange, filler turns so the message counts look like work rather
 * than a fixture, and a closing exchange, because the hub's import package
 * renders the opening and the recent tail and the image should show both.
 *
 * Timestamps are relative to a fixed `now` passed in, so "12m ago" in the
 * browser is true when the image is made.
 *
 * Usage (on its own):
 *   node test/fixtures/demo-home.mjs --root /tmp/session-hub-demo
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openIndexDb } from "../../core/sqlite.ts";

/** Project names, and the directories they live in. All invented. */
export const PROJECT_NAMES = ["acme-api", "ledger-ui", "search-service"];

/**
 * Deterministic ids. A hash of the session key formatted as a UUID looks like
 * every other session id in these stores, and does not change between runs, so
 * two runs of the generator produce byte-identical session ids.
 */
function uuidFor(key) {
  const h = crypto.createHash("sha256").update(key).digest("hex");
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `a${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** `--srv-work-acme-api--`, the directory Pi files a project's sessions under. */
function piSlug(cwd) {
  return `--${cwd.replace(/^\/+/, "").replace(/[/\\]/g, "-")}--`;
}

/** Claude Code's project slug: every separator becomes a dash. */
function claudeSlug(cwd) {
  return cwd.replace(/[/\\.]/g, "-");
}

// ---------------------------------------------------------------------------
// Filler
// ---------------------------------------------------------------------------

/**
 * Turns used to pad a session out to a plausible message count. They sit in the
 * middle of the conversation, between the opening and the closing exchange, so
 * they show up as condensed one-liners in the imported package and never as the
 * thing the session is about.
 */
const FILLER = [
  { user: "run the tests", tool: { name: "bash", input: { command: "npm test -- --runInBand" }, result: "43 passed, 1 skipped. 12.4s" }, assistant: "All green except the two I skipped; they need a redis fixture." },
  { user: "what does the stack trace say on line 3?", tool: { name: "read", input: { file_path: "src/queue/worker.ts" }, result: "…readonly offset: 412…" }, assistant: "It is the backoff timer firing twice; the second call sees a stale lease." },
  { user: "typecheck it", tool: { name: "bash", input: { command: "pnpm tsc --noEmit" }, result: "no errors" }, assistant: "Clean." },
  { user: "and the lint step?", tool: { name: "bash", input: { command: "pnpm lint" }, result: "warning: unused import in src/retry.ts" }, assistant: "One unused import left; I removed it and lint is clean now." },
  { user: "keep the old behaviour behind a flag", tool: { name: "edit", input: { file_path: "src/config.ts" }, result: "applied 1 hunk" }, assistant: "`LEGACY_RETRY=1` restores the previous path, default is the new one." },
  { user: "show me the diff", tool: { name: "bash", input: { command: "git diff --stat" }, result: "5 files changed, 214 insertions(+), 61 deletions(-)" }, assistant: "Five files; the interesting one is the lease rewrite in `worker.ts`." },
  { user: "does it hold under load?", tool: { name: "bash", input: { command: "k6 run load/smoke.js" }, result: "p95 143ms, 0 dropped iterations" }, assistant: "p95 dropped from 410ms to 143ms at the same rate." },
  { user: "write it down in the changelog", tool: { name: "edit", input: { file_path: "CHANGELOG.md" }, result: "applied 1 hunk" }, assistant: "Added under Unreleased, with the issue number." },
];

// ---------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------

/**
 * Every session the demo home contains. `opening` and `closing` are the parts
 * worth reading; `padTo` is the rough message count the filler brings it to.
 */
const SESSIONS = [
  // ---------------------------------------------------------------- acme-api
  {
    harness: "pi",
    project: "acme-api",
    key: "acme-idempotency",
    title: "idempotency keys on the charge endpoint",
    model: "anthropic/claude-sonnet-4-5",
    minutesAgo: 12,
    spanMinutes: 26,
    padTo: 18,
    opening: [
      { role: "user", text: "a retried charge creates a second payment intent, so a customer who hits retry twice gets billed twice. add idempotency keys to POST /charges" },
      { role: "assistant", text: "Right now the handler calls `stripe.paymentIntents.create` inline with no key, so every retry is a fresh intent. I will take an `Idempotency-Key` header, fall back to a body hash, and store the mapping in `charge_requests` with a unique index so a duplicate insert loses the race instead of the customer." },
    ],
    closing: [
      { role: "user", text: "and what happens when the same key arrives with a different amount?" },
      { role: "assistant", text: "That is a 409, not a replay: the stored request hash is compared before the intent is returned, so a mismatched body is refused rather than silently answering with the first charge. Ten minutes of test coverage in `charges.idempotency.spec.ts`, and the migration adds the unique index concurrently so the deploy does not lock the table." },
    ],
  },
  {
    harness: "claude-code",
    project: "acme-api",
    key: "acme-webhook-refunds",
    title: "Refunds are duplicated when the webhook retries",
    model: "claude-sonnet-4-5",
    minutesAgo: 62,
    spanMinutes: 48,
    padTo: 43,
    opening: [
      { role: "user", text: "our refunds webhook is duplicating refunds on retry. find where the handler is non-idempotent and fix it" },
      { role: "assistant", text: "Found it. `handleRefundUpdated` writes the refund row and then calls the ledger, with no unique constraint on `provider_refund_id` and no transaction wrapping both writes. A retry after the ledger call but before the row commit produces exactly the duplicate you are seeing." },
    ],
    closing: [
      { role: "user", text: "did anything already double-refund in production?" },
      { role: "assistant", text: "I checked the ledger for June: 17 refunds have two entries within 30 seconds, totalling 41,300 in the same currency. The backfill script in `scripts/dedupe-refunds.ts` merges them and writes an audit row per merge, and it prints what it would do until you pass `--apply`." },
    ],
  },
  {
    harness: "codex",
    project: "acme-api",
    key: "acme-reconcile-worker",
    title: "Port the reconciliation worker to the new queue",
    model: "gpt-5-codex",
    minutesAgo: 187,
    spanMinutes: 95,
    padTo: 27,
    opening: [
      { role: "user", text: "move the reconciliation worker off the old job runner onto the new queue, and keep the retry semantics identical" },
      { role: "assistant", text: "Plan: swap `JobRunner.enqueue` for `queue.publish`, keep the same four retry bands, and translate the old `maxAttempts` into the queue's attempt ceiling. The behavioural difference to watch is that the old runner retried inside the same process, where the new one re-enqueues." },
    ],
    closing: [
      { role: "user", text: "what breaks if the queue redelivers after the visibility timeout?" },
      { role: "assistant", text: "The settlement step becomes non-idempotent, which is why the reconciliation write is now keyed by `(provider, period, run_id)`. Redelivery then re-reads and overwrites the same row instead of appending a second one. I left the old runner in place behind `RECONCILE_QUEUE=new` so a rollback is one env var." },
    ],
  },
  {
    harness: "opencode",
    project: "acme-api",
    key: "acme-tax-rounding",
    title: "Round the tax line before it reaches the ledger",
    model: "anthropic/claude-sonnet-4-5",
    minutesAgo: 41,
    spanMinutes: 22,
    padTo: 16,
    opening: [
      { role: "user", text: "invoices are off by one cent on some EU orders. the tax line is rounded to four decimals but the ledger stores two" },
      { role: "assistant", text: "The totals are computed in floating point and rounded once at the end, so the printed lines and the ledger row disagree when a line rounds the other way. The fix is to keep cents as integers through the whole calculation and round half-up exactly once, at the boundary where the ledger row is built." },
    ],
    closing: [
      { role: "user", text: "re-run last month and tell me how many invoices change" },
      { role: "assistant", text: "1,204 of 38,900, all by one cent, and every one of them moves the total *up* to what the customer was already shown. The replay writes credit notes rather than rewriting history, so the audit trail stays intact." },
    ],
  },
  {
    harness: "crush",
    project: "acme-api",
    key: "acme-payout-backoff",
    title: "Add backoff to the payout retry loop",
    model: "deepseek/deepseek-v4-flash",
    minutesAgo: 300,
    spanMinutes: 34,
    padTo: 9,
    opening: [
      { role: "user", text: "the payout retry loop hammers the provider when it is degraded, we get 429s and then a ban. add exponential backoff with jitter" },
      { role: "assistant", text: "The loop retries immediately with no delay, so a degraded provider takes the whole retry budget in under a second. I will add exponential backoff with full jitter, cap the total wait at the payout window, and treat a 429 as a retryable signal with its own delay." },
    ],
    closing: [
      { role: "user", text: "make the delay visible in the logs" },
      { role: "assistant", text: "Each attempt logs `payout retry attempt=3 wait=1.7s` with the jittered value, so the next incident shows the backoff working instead of just a gap in the log." },
    ],
  },
  {
    harness: "jcode",
    project: "acme-api",
    key: "acme-billing-split",
    title: "Split billing.ts into two modules",
    model: "claude-opus-5",
    minutesAgo: 128,
    spanMinutes: 55,
    padTo: 31,
    opening: [
      { role: "user", text: "billing.ts is 1,400 lines and half of it is pricing rules. split it without changing behaviour" },
      { role: "assistant", text: "Two seams, not three: the parts that decide an amount (pricing rules, discounts, tax) and the parts that move money (charge, refund, payout). Everything else is glue and stays. I will move the pricing half into `src/billing/pricing.ts` first and keep `billing.ts` re-exporting so no call site changes in this commit." },
    ],
    closing: [
      { role: "user", text: "are there tests that cover the old import path?" },
      { role: "assistant", text: "Four, and they pass unchanged because the re-export keeps `billing.ts` honest. I would rather delete the re-export in a follow-up once the call sites are moved, so the split and the migration are separate risks." },
    ],
  },

  // --------------------------------------------------------------- ledger-ui
  {
    harness: "claude-code",
    project: "ledger-ui",
    key: "ledger-empty-filter",
    title: "The ledger table drops every row when the filter is empty",
    model: "claude-sonnet-4-5",
    minutesAgo: 25,
    spanMinutes: 18,
    padTo: 22,
    opening: [
      { role: "user", text: "clearing the filter in the ledger table shows zero rows instead of all of them" },
      { role: "assistant", text: "`useMemo` filters on `query.toLowerCase()` and the empty string matches nothing once the predicate also tests the account column, because that column is undefined for the summary rows. The predicate needs to treat an empty query as 'match everything' before it looks at any field." },
    ],
    closing: [
      { role: "user", text: "does the same bug affect the accounts page?" },
      { role: "assistant", text: "Yes, same predicate copy-pasted in `useAccountFilter`. I pulled it into `matchesQuery` with tests for the empty, whitespace and unicode cases, and both pages now call it." },
    ],
  },
  {
    harness: "codex",
    project: "ledger-ui",
    key: "ledger-virtualise",
    title: "Virtualise the transactions list",
    model: "gpt-5-codex",
    minutesAgo: 141,
    spanMinutes: 40,
    padTo: 14,
    opening: [
      { role: "user", text: "the transactions page takes four seconds to become interactive for an account with 30k rows. virtualise the list" },
      { role: "assistant", text: "The whole list renders before the tab is interactive, so the cost is 30k React elements, not the data. Windowed rendering keeps about 30 rows mounted, and because the rows are fixed height the measurement pass can be skipped entirely." },
    ],
    closing: [
      { role: "user", text: "keep ctrl+f working" },
      { role: "assistant", text: "Native find only sees mounted rows, so I added an in-page search that filters the data and jumps the window to the hit. That covers the case people actually use while scrolling a ledger." },
    ],
  },
  {
    harness: "opencode",
    project: "ledger-ui",
    key: "ledger-column-jump",
    title: "Column widths jump while the data loads",
    model: "anthropic/claude-sonnet-4-5",
    minutesAgo: 259,
    spanMinutes: 15,
    padTo: 11,
    opening: [
      { role: "user", text: "the amounts column jumps left when the page finishes loading, because the skeleton has no width" },
      { role: "assistant", text: "The skeleton uses `auto` sizing and the loaded table uses numeric alignment, so the column has two different widths and the whole table shifts. Reserving the numeric columns with `ch` units in both states removes the jump without touching the real layout." },
    ],
    closing: [
      { role: "user", text: "check the 320px breakpoint too" },
      { role: "assistant", text: "At 320px the amounts wrap; the reserved width was too wide there. The reserved size now follows the same breakpoint as the table, and the screenshot test at that width passes." },
    ],
  },
  {
    harness: "jcode",
    project: "ledger-ui",
    key: "ledger-totals-footer",
    title: "Move the totals footer into its own component",
    model: "claude-opus-5",
    minutesAgo: 331,
    spanMinutes: 28,
    padTo: 19,
    opening: [
      { role: "user", text: "the totals footer is duplicated in three tables and they have already drifted apart" },
      { role: "assistant", text: "The three copies differ in how they treat a null total: one renders 0, one renders a dash, one drops the cell. I will extract `TotalsFooter` with the dash behaviour, since a missing total and a zero total are different facts and the table should not conflate them." },
    ],
    closing: [
      { role: "user", text: "add a story for the empty case" },
      { role: "assistant", text: "Added to Storybook with all-null totals, mixed, and a single currency, which is the case that used to render three dashes with no label." },
    ],
  },
  {
    harness: "pi",
    project: "ledger-ui",
    key: "ledger-tooltip-clip",
    title: "chart tooltips are clipped at the right edge",
    model: "anthropic/claude-opus-5",
    minutesAgo: 34,
    spanMinutes: 12,
    padTo: 8,
    opening: [
      { role: "user", text: "tooltips on the balance chart are cut off when the point is near the right edge of the card" },
      { role: "assistant", text: "The tooltip is positioned inside the chart's overflow-hidden container, so anything past the last x tick is clipped. Rendering it in a portal above the card fixes the clipping, and the flip logic keeps it on screen at the left edge." },
    ],
    closing: [
      { role: "user", text: "does it still follow the cursor on a touch drag?" },
      { role: "assistant", text: "Yes. The portal reads the same pointer position the chart already tracks, so dragging on a tablet moves the tooltip with the finger the way it did before." },
    ],
  },
  {
    harness: "crush",
    project: "ledger-ui",
    key: "ledger-date-range",
    title: "Date range picker should default to this month",
    model: "deepseek/deepseek-v4-flash",
    minutesAgo: 540,
    spanMinutes: 10,
    padTo: 6,
    opening: [
      { role: "user", text: "the date range picker opens on the last 30 days, users expect the current month. change the default and keep the presets" },
      { role: "assistant", text: "Default becomes the first of the current month through today, computed in the user's timezone rather than UTC so the month boundary is the one they see. The presets stay as they are." },
    ],
    closing: [
      { role: "user", text: "what about the saved views from last month?" },
      { role: "assistant", text: "Saved views carry an explicit range, so they are untouched by the default change. Only a fresh view picks up the month." },
    ],
  },

  // ----------------------------------------------------------- search-service
  {
    harness: "codex",
    project: "search-service",
    key: "search-facet-drift",
    title: "Facet counts drift after a reindex",
    model: "gpt-5-codex",
    minutesAgo: 7,
    spanMinutes: 52,
    padTo: 35,
    opening: [
      { role: "user", text: "facet counts are wrong for about a minute after a reindex and then correct themselves. where is the drift coming from" },
      { role: "assistant", text: "The facet aggregation runs against the read alias while the reindex writes into the next index, so during the swap the two disagree by exactly the documents that moved. The counts are not lost, they are read from the old generation until the alias flips." },
    ],
    closing: [
      { role: "user", text: "can we make the swap atomic from the client's point of view?" },
      { role: "assistant", text: "Alias swaps are atomic in Elasticsearch, so the drift is the window where the aggregation is computed on one index and the hits on another. Moving the aggregation into the same request as the hits closes it, at the cost of one extra query per page, which is 3ms at p95 here." },
    ],
  },
  {
    harness: "pi",
    project: "search-service",
    key: "search-suggest-p99",
    title: "reduce the p99 on the suggest endpoint",
    model: "anthropic/claude-sonnet-4-5",
    minutesAgo: 58,
    spanMinutes: 44,
    padTo: 23,
    opening: [
      { role: "user", text: "the suggest endpoint has a p99 of 800ms while the median is 12ms. find the tail" },
      { role: "assistant", text: "The tail is not the query, it is the cold path: suggestions for a prefix that no one has typed before walk the whole term dictionary. The hot prefixes are cached, so the p99 is the cache miss, which is one request in a thousand." },
    ],
    closing: [
      { role: "user", text: "so what do we cache?" },
      { role: "assistant", text: "Prefix results for the first three characters, which is a bounded set and covers 94% of traffic, with a 60 second TTL. After that the p99 is 190ms and the hit rate on the term dictionary drops by a third." },
    ],
  },
  {
    harness: "claude-code",
    project: "search-service",
    key: "search-tokenizer-test",
    title: "Add a regression test for the tokenizer split",
    model: "claude-sonnet-4-5",
    minutesAgo: 173,
    spanMinutes: 20,
    padTo: 17,
    opening: [
      { role: "user", text: "we fixed the tokenizer splitting hyphens last week and nothing tests it. add a regression test that would have caught it" },
      { role: "assistant", text: "The old behaviour split `state-of-the-art` into four tokens and dropped the joining words from the index, so a search for the phrase found nothing. The test indexes the phrase, searches for the hyphenated form and for the words around it, and asserts both hit the same document." },
    ],
    closing: [
      { role: "user", text: "include a case with a trailing hyphen" },
      { role: "assistant", text: "Added `foo- ` and `-foo`, which is the shape that produced the empty token and the analyzer exception in the incident log. Both now produce a normal token." },
    ],
  },
  {
    harness: "jcode",
    project: "search-service",
    key: "search-negative-cache",
    title: "Cache negative lookups for 30 seconds",
    model: "claude-opus-5",
    minutesAgo: 301,
    spanMinutes: 33,
    padTo: 12,
    opening: [
      { role: "user", text: "we get hammered by lookups for ids that do not exist. cache the misses, but keep it short" },
      { role: "assistant", text: "A 30 second negative cache with a small negative-only store, so a newly created document is visible within half a minute. The TTL is deliberately shorter than the write path's own consistency window, so the cache can never be the reason a customer cannot see their own write." },
    ],
    closing: [
      { role: "user", text: "how do we invalidate on create?" },
      { role: "assistant", text: "The create path publishes to the same topic the cache subscribes to, so a create drops the key immediately and the TTL is only the backstop for a missed message." },
    ],
  },
  {
    harness: "opencode",
    project: "search-service",
    key: "search-analyzer-operator",
    title: "The analyzer keeps dropping the trailing operator",
    model: "anthropic/claude-opus-5",
    minutesAgo: 421,
    spanMinutes: 38,
    padTo: 28,
    opening: [
      { role: "user", text: "queries like `status:open AND` are accepted and then silently behave as `status:open`. the trailing operator should be an error" },
      { role: "assistant", text: "The parser discards a trailing operator rather than failing, which is why the query looks accepted and the result set is wider than intended. Making it an explicit parse error is the honest fix; silently answering a different question than the one asked is the actual bug." },
    ],
    closing: [
      { role: "user", text: "will that break saved searches?" },
      { role: "assistant", text: "I ran every saved search in the store through the new parser: 12 of 4,300 have a trailing operator, all of them written by the same internal tool. Those now return a 400 with the position of the offending token, and the tool was fixed in the same change." },
    ],
  },
  {
    harness: "crush",
    project: "search-service",
    key: "search-score-tiebreak",
    title: "Tie-break equal scores by recency",
    model: "deepseek/deepseek-v4-flash",
    minutesAgo: 660,
    spanMinutes: 16,
    padTo: 10,
    opening: [
      { role: "user", text: "results with the same score come back in a different order every time, which makes the pagination skip documents" },
      { role: "assistant", text: "Equal scores have no defined order, so the tie-break is whatever the shard returns, and pages overlap when the shards disagree between requests. Sorting by score then by `updated_at` descending, with the document id last, makes the order total." },
    ],
    closing: [
      { role: "user", text: "does the second key hurt relevance?" },
      { role: "assistant", text: "It can only reorder documents that scored the same, so relevance is unchanged for anything the score separated. The page overlap went to zero in the replay of the last 10,000 queries." },
    ],
  },
];

// ---------------------------------------------------------------------------
// Per-harness emitters
// ---------------------------------------------------------------------------

/** Expand one session's journey into a flat list of generic messages. */
function timeline(session) {
  const start = session.now - session.minutesAgo * 60_000;
  const end = start + session.spanMinutes * 60_000;
  const authored = [...session.opening, ...session.closing];
  const total = authored.length + FILLER.length * 3;
  const step = total > 1 ? (end - start) / (total - 1) : 0;

  const out = [];
  const push = (m) => out.push({ ...m, at: start + step * out.length });

  for (const m of session.opening) push(m);
  // Filler sits in the middle: the opening and the closing stay the two ends.
  let i = 0;
  while (out.length + 2 < session.padTo) {
    const f = FILLER[i % FILLER.length];
    i++;
    push({ role: "user", text: f.user });
    push({ role: "assistant", text: f.assistant, tool: f.tool });
  }
  for (const m of session.closing) push(m);
  return out;
}

/** Turn a tool call into the shape each store uses for "a tool ran". */
function toolArgs(tool) {
  return tool?.input ?? {};
}

async function emitPi(root, session, messages) {
  const cwd = session.cwd;
  const dir = path.join(root, "home", ".pi", "agent", "sessions", piSlug(cwd));
  const id = uuidFor(session.key);
  const rows = [
    { type: "session", version: 3, id, timestamp: iso(messages[0].at), cwd },
    { type: "session_info", name: session.title },
    { type: "model_change", provider: session.model.split("/")[0], modelId: session.model.split("/").slice(1).join("/") },
  ];
  let parent = null;
  for (const m of messages) {
    const entryId = `${session.key}-${rows.length}`;
    if (m.role === "user") {
      rows.push({
        type: "message",
        id: entryId,
        parentId: parent,
        timestamp: iso(m.at),
        message: { role: "user", content: [{ type: "text", text: m.text }] },
      });
    } else {
      const content = [{ type: "thinking", thinking: "weighing the options before writing code" }, { type: "text", text: m.text }];
      if (m.tool) content.push({ type: "toolCall", id: entryId, name: m.tool.name, arguments: toolArgs(m.tool) });
      rows.push({
        type: "message",
        id: entryId,
        parentId: parent,
        timestamp: iso(m.at),
        message: { role: "assistant", model: session.model, content },
      });
      if (m.tool) {
        rows.push({
          type: "message",
          id: `${entryId}-r`,
          parentId: entryId,
          timestamp: iso(m.at + 1000),
          message: {
            role: "toolResult",
            toolName: m.tool.name,
            content: [{ type: "text", text: m.tool.result }],
            details: toolArgs(m.tool),
          },
        });
      }
    }
    parent = entryId;
  }
  const stamp = iso(messages[0].at).replace(/[:.]/g, "-");
  write(path.join(dir, `${stamp}_${id}.jsonl`), jsonl(rows));
  write(
    path.join(root, "home", ".pi", "agent", "settings.json"),
    JSON.stringify({ theme: "dark", sessionHub: { contextChars: 40000 } }, null, 2),
  );
}

async function emitClaude(root, session, messages) {
  const cwd = session.cwd;
  const dir = path.join(root, "home", ".claude", "projects", claudeSlug(cwd));
  const id = uuidFor(session.key);
  const rows = [];
  const changed = new Set();
  const read = new Set();
  for (const m of messages) {
    if (m.role === "user") {
      rows.push({
        type: "user",
        sessionId: id,
        cwd,
        timestamp: iso(m.at),
        message: { role: "user", content: m.text },
      });
    } else {
      const content = [{ type: "text", text: m.text }];
      if (m.tool) {
        content.push({ type: "tool_use", id: `tu_${rows.length}`, name: m.tool.name, input: toolArgs(m.tool) });
        const p = toolArgs(m.tool).file_path;
        if (typeof p === "string") changed.add(p);
      }
      rows.push({
        type: "assistant",
        sessionId: id,
        cwd,
        timestamp: iso(m.at),
        message: { role: "assistant", model: session.model, content },
      });
      if (m.tool) {
        rows.push({
          type: "user",
          sessionId: id,
          cwd,
          timestamp: iso(m.at + 900),
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: `tu_${rows.length - 1}`, content: m.tool.result }],
          },
        });
      }
    }
  }
  rows.push({ type: "ai-title", sessionId: id, title: session.title });
  write(path.join(dir, `${id}.jsonl`), jsonl(rows));
}

async function emitCodex(root, session, messages) {
  const cwd = session.cwd;
  const id = uuidFor(session.key);
  const first = new Date(messages[0].at);
  const dir = path.join(
    root,
    "home",
    ".codex",
    "sessions",
    String(first.getUTCFullYear()),
    String(first.getUTCMonth() + 1).padStart(2, "0"),
    String(first.getUTCDate()).padStart(2, "0"),
  );
  const rows = [
    {
      timestamp: iso(messages[0].at),
      type: "session_meta",
      payload: { session_id: id, cwd, cli_version: "0.9.4", timestamp: iso(messages[0].at), originator: "codex_cli_rs" },
    },
    { timestamp: iso(messages[0].at), type: "turn_context", payload: { model: session.model, cwd, approval_policy: "on-request" } },
  ];
  for (const m of messages) {
    if (m.role === "user") {
      rows.push({
        timestamp: iso(m.at),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: m.text }] },
      });
    } else {
      if (m.tool) {
        rows.push({
          timestamp: iso(m.at),
          type: "response_item",
          payload: {
            type: "function_call",
            name: m.tool.name,
            arguments: JSON.stringify(toolArgs(m.tool)),
            call_id: `call_${rows.length}`,
          },
        });
      }
      rows.push({
        timestamp: iso(m.at),
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] },
      });
      if (m.tool) {
        rows.push({
          timestamp: iso(m.at + 800),
          type: "response_item",
          payload: { type: "function_call_output", call_id: `call_${rows.length - 1}`, output: m.tool.result },
        });
      }
    }
  }
  const stamp = iso(messages[0].at).replace(/[:.]/g, "-").replace("Z", "");
  write(path.join(dir, `rollout-${stamp}-${id}.jsonl`), jsonl(rows));
}

async function emitJcode(root, session, messages) {
  const dir = path.join(root, "home", ".jcode", "sessions");
  const id = `session_${session.key}`;
  const doc = {
    id,
    title: session.title,
    created_at: iso(messages[0].at),
    updated_at: iso(messages[messages.length - 1].at),
    working_dir: session.cwd,
    model: session.model,
    provider_key: session.model.split("/")[0],
    messages: messages
      .filter((m) => m.role !== "tool")
      .map((m) => {
        const content = [{ type: "text", text: m.text }];
        if (m.tool) {
          content.unshift({ type: "tool_use", id: `t_${m.at}`, name: m.tool.name, input: toolArgs(m.tool) });
          content.push({ type: "tool_result", tool_use_id: `t_${m.at}`, content: m.tool.result });
        }
        return { role: m.role, content };
      }),
  };
  write(path.join(dir, `${id}.json`), JSON.stringify(doc, null, 2));
}

/**
 * OpenCode's own store, written into a database OpenCode itself created.
 *
 * It is not enough to create `session`/`message`/`part` by hand. OpenCode runs
 * schema migrations against this file every time it starts, and a store that
 * has the tables but none of the migration history makes the TUI hang before it
 * draws a single cell (this happened: see docs/demo.md). So `warmOpenCodeStore`
 * asks the real binary to create and migrate the file, and this function only
 * inserts rows into the schema that came back.
 */
async function emitOpenCode(root, session, messages) {
  const db = await openIndexDb(session.dbPath);
  if (!db) throw new Error(`cannot open the demo OpenCode database at ${session.dbPath}`);
  const sessionColumns = new Set(
    db.all("pragma table_info(session)").map((c) => c.name),
  );
  if (!sessionColumns.has("id") || !sessionColumns.has("time_updated")) {
    throw new Error(
      "the demo OpenCode store has no migrated session table; " +
        "warmOpenCodeStore must run before any rows are inserted",
    );
  }

  const created = messages[0].at;
  const updated = messages[messages.length - 1].at;
  const model = {
    id: session.model.split("/").slice(1).join("/"),
    providerID: session.model.split("/")[0],
  };

  // One project row per directory, which is what OpenCode writes when it first
  // opens a directory it has not seen.
  db.run(
    `insert or ignore into project (id, worktree, vcs, name, sandboxes, time_created, time_updated)
     values (?,?,?,?,?,?,?)`,
    [`proj_${session.project}`, session.cwd, null, session.project, "[]", created, updated],
  );

  db.run(
    `insert into session (id, project_id, slug, directory, path, title, version, model,
       cost, tokens_input, tokens_output, tokens_reasoning, time_created, time_updated)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      session.nativeId,
      `proj_${session.project}`,
      session.key.replace(/^acme-|^ledger-|^search-/, ""),
      session.cwd,
      path.join(session.cwd, "src"),
      session.title,
      "1.18.31",
      JSON.stringify(model),
      0.41,
      18400,
      3100,
      900,
      created,
      updated,
    ],
  );
  let index = 0;
  for (const m of messages) {
    if (m.role === "tool") continue;
    const messageId = `msg_${session.key}_${index}`;
    db.run("insert into message (id, session_id, time_created, time_updated, data) values (?,?,?,?,?)", [
      messageId,
      session.nativeId,
      m.at,
      m.at,
      JSON.stringify({
        role: m.role,
        parentID: index > 0 ? `msg_${session.key}_${index - 1}` : undefined,
        time: { created: m.at, completed: m.at + 400 },
        path: { cwd: session.cwd, root: "/" },
        cost: m.role === "assistant" ? 0.018 : 0,
        modelID: model.id,
        providerID: model.providerID,
        tokens:
          m.role === "assistant"
            ? { input: 5200, output: 610, reasoning: 120, cache: { write: 0, read: 2100 } }
            : undefined,
      }),
    ]);
    db.run(
      "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?,?,?,?,?,?)",
      [
        `prt_${session.key}_${index}_0`,
        messageId,
        session.nativeId,
        m.at,
        m.at,
        JSON.stringify({ type: "text", text: m.text, time: { start: m.at, end: m.at } }),
      ],
    );
    if (m.role === "assistant") {
      db.run(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?,?,?,?,?,?)",
        [
          `prt_${session.key}_${index}_r`,
          messageId,
          session.nativeId,
          m.at + 1,
          m.at + 1,
          JSON.stringify({ type: "reasoning", text: "checking the call site before editing", time: { start: m.at, end: m.at + 1 } }),
        ],
      );
      if (m.tool) {
        db.run(
          "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?,?,?,?,?,?)",
          [
            `prt_${session.key}_${index}_t`,
            messageId,
            session.nativeId,
            m.at + 2,
            m.at + 2,
            JSON.stringify({
              type: "tool",
              tool: m.tool.name,
              callID: `call_${index}`,
              state: { status: "completed", input: toolArgs(m.tool), time: { start: m.at, end: m.at + 2 } },
            }),
          ],
        );
      }
    }
    index++;
  }
}

/** Crush's store: sessions / messages / files / read_files. */
async function emitCrush(root, session, messages) {
  const db = await openIndexDb(session.dbPath);
  if (!db) throw new Error("cannot open the demo Crush database");
  const created = Math.floor(messages[0].at / 1000);
  const updated = Math.floor(messages[messages.length - 1].at / 1000);
  const rows = messages.filter((m) => m.role !== "tool");
  db.run(
    "insert into sessions (id,title,message_count,prompt_tokens,completion_tokens,cost,created_at,updated_at) values (?,?,?,?,?,?,?,?)",
    [session.nativeId, session.title, rows.length, 42000, 5800, 0.12, created, updated],
  );
  rows.forEach((m, i) => {
    const parts = [{ type: "text", data: { text: m.text } }];
    if (m.tool) {
      parts.push({ type: "tool_call", data: { name: m.tool.name, input: toolArgs(m.tool) } });
      parts.push({ type: "tool_result", data: { name: m.tool.name, text: m.tool.result } });
    }
    db.run(
      "insert into messages (id,session_id,role,parts,model,created_at,updated_at) values (?,?,?,?,?,?,?)",
      [
        `msg_${session.key}_${i}`,
        session.nativeId,
        m.role,
        JSON.stringify(parts),
        m.role === "assistant" ? session.model.split("/").slice(1).join("/") : null,
        Math.floor(m.at / 1000),
        Math.floor(m.at / 1000),
      ],
    );
  });
  for (const path_ of session.filesChanged ?? []) {
    db.run(
      "insert into files (id,session_id,path,content,version,created_at,updated_at) values (?,?,?,?,?,?,?)",
      [`file_${session.key}_${path_}`, session.nativeId, path_, "", 1, created, updated],
    );
    db.run("insert into read_files (session_id,path,read_at) values (?,?,?)", [
      session.nativeId,
      path_,
      created,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------

async function createCrushDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = await openIndexDb(dbPath);
  if (!db) throw new Error("cannot create the demo Crush database");
  db.run(
    `create table sessions (id text primary key, parent_session_id text, title text not null,
      message_count integer not null default 0, prompt_tokens integer default 0,
      completion_tokens integer default 0, cost real default 0, updated_at integer not null,
      created_at integer not null, summary_message_id text, todos text)`,
  );
  db.run(
    `create table messages (id text primary key, session_id text not null, role text not null,
      parts text not null default '[]', model text, created_at integer not null,
      updated_at integer not null, finished_at integer, provider text,
      is_summary_message integer default 0, prism_model_id text, prism_model_name text,
      prism_hypercredit_savings real, prism_dollar_savings real)`,
  );
  db.run(
    `create table files (id text primary key, session_id text not null, path text not null,
      content text not null, version integer default 0, created_at integer not null,
      updated_at integer not null)`,
  );
  db.run(
    `create table read_files (session_id text not null, path text not null, read_at integer not null,
      primary key (path, session_id))`,
  );
  db.close();
}

/**
 * Ask OpenCode to create and migrate its own store.
 *
 * `opencode db path` opens the database the same way the TUI does, which means
 * it runs the migrations. Writing the schema by hand instead produces a file
 * that looks right to the hub's adapter and hangs the TUI on startup, so this
 * is not a convenience: it is the only way to get a store OpenCode agrees with.
 *
 * Returns the data home the store was created in, or null when OpenCode is not
 * on PATH.
 */
export function warmOpenCodeStore(dataHome, { timeoutMs = 120_000 } = {}) {
  fs.mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
  const result = spawnSync("opencode", ["db", "path"], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, XDG_DATA_HOME: dataHome },
  });
  const dbPath = path.join(dataHome, "opencode", "opencode.db");
  if (result.error || !fs.existsSync(dbPath)) return null;
  return dbPath;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Write the whole demo home. `root` is the scratch directory that holds the
 * synthetic home, the demo projects and the harness stores.
 *
 * Returns the paths the caller needs, including the session counts it should
 * expect from `sessionhub doctor`.
 */
export async function buildDemoHome({ root, workRoot, now = Date.now() }) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.mkdirSync(path.join(root, "hub"), { recursive: true });

  const projects = Object.fromEntries(
    PROJECT_NAMES.map((name) => [name, path.join(workRoot, name)]),
  );
  for (const dir of Object.values(projects)) fs.mkdirSync(dir, { recursive: true });

  // One database per harness, created before the rows go in. Crush's schema is
  // simple enough to write here; OpenCode's is not, so its store is created by
  // OpenCode itself (see `warmOpenCodeStore`).
  await createCrushDb(path.join(root, "home", ".crush", "crush.db"));
  const openCodeDb = warmOpenCodeStore(path.join(root, "home", ".local", "share"));
  if (!openCodeDb) {
    process.stderr.write(
      "demo-home: opencode is not on PATH, so the OpenCode store was not created\n",
    );
  }

  const counts = {};
  const nativeIds = {};
  for (const spec of SESSIONS) {
    const session = {
      ...spec,
      now,
      cwd: projects[spec.project],
      dbPath: undefined,
      nativeId: undefined,
      filesChanged: undefined,
    };
    session.dbPath = path.join(root, "home", ".crush", "crush.db");
    session.nativeId = `crush_${spec.key}`;
    const messages = timeline(session);

    // Files the two SQLite-backed harnesses record as touched.
    const touched = [
      path.join(session.cwd, spec.harness === "crush" ? "src/retry.ts" : "src/index.ts"),
      path.join(session.cwd, "README.md"),
    ];
    session.filesChanged = touched;

    if (spec.harness === "pi") await emitPi(root, session, messages);
    else if (spec.harness === "claude-code") await emitClaude(root, session, messages);
    else if (spec.harness === "codex") await emitCodex(root, session, messages);
    else if (spec.harness === "jcode") await emitJcode(root, session, messages);
    else if (spec.harness === "opencode") {
      session.dbPath = path.join(root, "home", ".local", "share", "opencode", "opencode.db");
      session.nativeId = `ses_${uuidFor(spec.key).replace(/-/g, "").slice(0, 24)}`;
      await emitOpenCode(root, session, messages);
    } else if (spec.harness === "crush") {
      await emitCrush(root, session, messages);
    } else throw new Error(`unknown harness: ${spec.harness}`);

    counts[spec.harness] = (counts[spec.harness] ?? 0) + 1;
    nativeIds[spec.key] = session.nativeId;
  }

  return { root, home: path.join(root, "home"), hub: path.join(root, "hub"), projects, counts, nativeIds };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? "/tmp/session-hub-demo";
  const workRoot = args.work ?? path.join(root, "work");
  const result = await buildDemoHome({ root, workRoot });
  process.stdout.write(`demo home: ${result.home}\ndemo hub:  ${result.hub}\n`);
  process.stdout.write(`projects:  ${Object.values(result.projects).join(", ")}\n`);
  process.stdout.write(`sessions:  ${JSON.stringify(result.counts)}\n`);
}
