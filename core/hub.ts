/**
 * Hub facade.
 *
 * One place that owns the index, the adapter registry and the read paths, so
 * every front end (CLI, MCP server, per-harness plugin) is a thin shell over
 * this and cannot drift from the others.
 *
 * Rules that do not change per harness:
 *  - the only writable path is the hub home (`~/.session-hub` by default)
 *  - every external store is opened read-only
 *  - a failed read throws, it is never reported as "no sessions"
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AdapterRegistry } from "./adapters/registry.ts";
import { deriveRepo } from "./adapters/util.ts";
import type { SessionAdapter } from "./adapters/types.ts";
import { buildTranscriptContext, type TranscriptContextOptions, type TranscriptContextResult } from "./context.ts";
import { buildHandoff, type HandoffOptions, type HandoffResult } from "./handoff.ts";
import {
  openIndex,
  querySessions,
  rowToSession,
  type IndexHandle,
  type IndexedSessionRow,
} from "./index/db.ts";
import { scan, type ScanOptions, type ScanResult } from "./index/scan.ts";
import { resolveNativeResume } from "./native.ts";
import type {
  DetectionResult,
  ExternalSession,
  HarnessId,
  HarnessId as Harness,
  SessionDetail,
} from "./types.ts";
import type { NativeResumeAction } from "./adapters/types.ts";

export interface HubOptions {
  /** Override the hub home. Defaults to $SESSION_HUB_HOME or ~/.session-hub. */
  home?: string;
  /** Cap on sessions read per harness during a scan. */
  maxPerHarness?: number;
}

export interface SearchHit {
  row: IndexedSessionRow;
  session: ExternalSession;
}

export interface LoadedContext {
  session: ExternalSession;
  /** The context package, ready to paste into any harness. */
  context: TranscriptContextResult;
}

export class HubReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubReadError";
  }
}

export function hubHome(explicit?: string): string {
  const fromEnv = process.env.SESSION_HUB_HOME;
  if (explicit) return path.resolve(explicit);
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".session-hub");
}

export class Hub {
  readonly home: string;
  readonly indexPath: string;
  private handle!: IndexHandle;
  private readonly registry: AdapterRegistry;
  private readonly maxPerHarness: number;
  private lastScanAt = 0;

  private constructor(home: string, handle: IndexHandle, maxPerHarness: number) {
    this.home = home;
    this.indexPath = path.join(home, "index.sqlite");
    this.handle = handle;
    this.registry = new AdapterRegistry(os.homedir());
    this.maxPerHarness = maxPerHarness;
  }

  static async open(opts: HubOptions = {}): Promise<Hub> {
    const home = hubHome(opts.home);
    try {
      fs.mkdirSync(home, { recursive: true });
    } catch (err) {
      throw new HubReadError(`cannot create hub home ${home}: ${describe(err)}`);
    }
    const handle = await openIndex(path.join(home, "index.sqlite"));
    if (!handle) {
      throw new HubReadError(
        "cannot open the hub index. node:sqlite is required (Node 22.5+) and the hub home must be writable.",
      );
    }
    return new Hub(home, handle, opts.maxPerHarness ?? 2000);
  }

  /** Adapters, in fixed order. */
  adapters(): SessionAdapter[] {
    return this.registry.all();
  }

  detect(): Promise<DetectionResult[]> {
    return this.registry.detectAll();
  }

  /**
   * Fold every enabled harness into the local index. Cheap when nothing changed.
   * Throws only on a broken index, never on a broken adapter: one unreadable
   * store must not take the others down.
   */
  async refresh(force = false, onProgress?: ScanOptions["onProgress"]): Promise<ScanResult> {
    const result = await scan(this.handle, this.registry, {
      force,
      maxPerHarness: this.maxPerHarness,
      onProgress,
    });
    this.lastScanAt = Date.now();
    return result;
  }

  /** Run a scan on first use, then reuse the index. */
  async ensureFresh(maxAgeMs = 15_000): Promise<void> {
    if (this.lastScanAt && Date.now() - this.lastScanAt < maxAgeMs) return;
    await this.refresh(false);
  }

  list(limit = 2000): ExternalSession[] {
    return querySessions(this.handle, { limit }).map(rowToSession);
  }

  search(text: string | undefined, opts: { harness?: HarnessId; repo?: string; filePath?: string; limit?: number } = {}): SearchHit[] {
    const rows = querySessions(this.handle, {
      text,
      harness: opts.harness ?? null,
      repo: opts.repo ?? null,
      filePath: opts.filePath ?? null,
      limit: opts.limit ?? 300,
    });
    return rows.map((row) => ({ row, session: rowToSession(row) }));
  }

  /**
   * Sessions belonging to one project directory, across every harness.
   *
   * This is the answer to "what was I doing in this repo, in any agent?" and it
   * is the fastest path to the thing the hub exists for: seeing the Codex or
   * OpenCode session you left behind in the project you are standing in.
   */
  here(dir: string, limit = 50): ExternalSession[] {
    const abs = path.resolve(dir);
    const repo = deriveRepo(abs);
    const rows = this.handle.db.all<IndexedSessionRow>(
      `select * from sessions
        where (repo is not null and repo = ?)
           or cwd = ?
           or cwd like ?
        order by coalesce(updated_at, created_at) desc
        limit ?`,
      [repo ?? abs, abs, `${abs.replace(/\/+$/, "")}/%`, limit],
    );
    return rows.map(rowToSession);
  }

  /**
   * Search full transcripts, not just the indexed excerpt.
   *
   * The index samples 20k characters per session, which answers most questions
   * quickly but can miss a phrase buried in the middle of a long conversation.
   * This walks the newest candidates, loads each transcript through its adapter,
   * and requires every term to appear. Bounded on purpose: it reports how many
   * sessions it actually read, so a partial answer never looks complete.
   */
  async deepSearch(
    query: string,
    opts: {
      harness?: HarnessId;
      repo?: string;
      limit?: number;
      maxSessions?: number;
      onProgress?: (done: number, total: number) => void;
    } = {},
  ): Promise<{ hits: { session: ExternalSession; snippet: string }[]; scanned: number; truncated: boolean }> {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((t) => t.length > 2);
    if (terms.length === 0) return { hits: [], scanned: 0, truncated: false };

    const candidates = querySessions(this.handle, {
      harness: opts.harness ?? null,
      repo: opts.repo ?? null,
      limit: opts.maxSessions ?? 400,
    });
    const hits: { session: ExternalSession; snippet: string }[] = [];
    let scanned = 0;

    for (const row of candidates) {
      if (hits.length >= (opts.limit ?? 30)) break;
      const adapter = this.registry.get(row.harness);
      if (!adapter) continue;
      let detail: SessionDetail | null = null;
      try {
        detail = await adapter.getSession(row.native_id);
      } catch {
        continue;
      }
      scanned++;
      opts.onProgress?.(scanned, candidates.length);
      if (!detail) continue;
      const haystack = detail.messages
        .map((m) => m.text)
        .join("\n")
        .toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) continue;
      const at = haystack.indexOf(terms[0]);
      const from = Math.max(0, at - 160);
      const snippet = [...detail.messages]
        .map((m) => m.text)
        .join("\n")
        .slice(from, from + 320)
        .replace(/\s+/g, " ")
        .trim();
      hits.push({ session: rowToSession(row), snippet });
    }

    return { hits, scanned, truncated: scanned < candidates.length };
  }

  counts(): { harness: HarnessId; n: number }[] {
    return this.handle.db.all<{ harness: HarnessId; n: number }>(
      "select harness, count(*) as n from sessions group by harness",
    );
  }

  lastIndexedAt(): string | null {
    const row = this.handle.db.get<{ value: string }>(
      "select value from meta where key = 'last_indexed_at'",
    );
    return row?.value ?? null;
  }

  /** Resolve a uid against the index, then read the full transcript. */
  private async detail(uid: string): Promise<SessionDetail | null> {
    const row =
      this.handle.db.get<IndexedSessionRow>("select * from sessions where uid = ?", [uid]) ??
      this.findByPrefix(uid);
    if (!row) return null;
    const adapter = this.registry.get(row.harness);
    if (!adapter) throw new HubReadError(`no adapter for harness "${row.harness}"`);
    const detail = await adapter.getSession(row.native_id);
    if (!detail) return null;
    // Fill in the session row so the caller always sees it in context.
    return { ...rowToSession(row), ...detail };
  }

  /** A uid is `<harness>:<nativeId>`, which is long to type. Accept a prefix. */
  private findByPrefix(uid: string): IndexedSessionRow | undefined {
    const rows = this.handle.db.all<IndexedSessionRow>(
      "select * from sessions where uid like ? order by coalesce(updated_at, created_at) desc limit 2",
      [`${uid}%`],
    );
    if (rows.length > 1) {
      throw new HubReadError(
        `"${uid}" matches ${rows.length} sessions. Use a longer prefix:\n` +
          rows.map((r) => `  ${r.uid}`).join("\n"),
      );
    }
    return rows[0];
  }

  async get(uid: string): Promise<SessionDetail | null> {
    return this.detail(uid);
  }

  /** The tiered, budgeted context package for one session. */
  async contextFor(uid: string, opts: TranscriptContextOptions = {}): Promise<LoadedContext | null> {
    const session = await this.detail(uid);
    if (!session) return null;
    return { session, context: buildTranscriptContext(session, opts) };
  }

  /** The deterministic handoff document for one session. */
  async handoffFor(uid: string, opts: HandoffOptions = {}): Promise<({ session: SessionDetail } & HandoffResult) | null> {
    const session = await this.detail(uid);
    if (!session) return null;
    const result = buildHandoff(session, opts);
    return { session, ...result };
  }

  /** The verified native resume command for a session, or null. */
  async nativeFor(uid: string): Promise<{ session: ExternalSession; action: NativeResumeAction | null } | null> {
    const row =
      this.handle.db.get<IndexedSessionRow>("select * from sessions where uid = ?", [uid]) ??
      this.findByPrefix(uid);
    if (!row) return null;
    const session = rowToSession(row);
    const adapter = this.registry.get(row.harness);
    if (!adapter) throw new HubReadError(`no adapter for harness "${row.harness}"`);
    return { session, action: await resolveNativeResume(adapter, row.native_id) };
  }

  close(): void {
    this.handle.close();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
