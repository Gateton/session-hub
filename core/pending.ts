/**
 * The pending selection.
 *
 * This is how "explicit" works: the user picks a session, the hub records that
 * choice, and the harness's own hook delivers it on the next message. The user
 * always knows which session is coming and what it costs; nothing is imported
 * behind their back.
 *
 * One pending selection at a time, consumed exactly once. A stale record (older
 * than a couple of hours) is ignored rather than injected, so a forgotten choice
 * cannot surprise anyone later in the day.
 */

import fs from "node:fs";
import path from "node:path";

import { hubHome } from "./hub.ts";
import type { HarnessId } from "./types.ts";

export const PENDING_TTL_MS = 2 * 60 * 60 * 1000;

export interface PendingSelection {
  uid: string;
  harness: HarnessId;
  title: string | null;
  /** Character budget the user expects to pay. */
  chars: number;
  createdAt: string;
  /** Free-form note, e.g. why they picked it. Shown once, in the injected block. */
  note?: string;
}

export function pendingPath(home?: string): string {
  return path.join(hubHome(home), "pending.json");
}

export function writePending(selection: Omit<PendingSelection, "createdAt">, home?: string): PendingSelection {
  const record: PendingSelection = { ...selection, createdAt: new Date().toISOString() };
  const target = pendingPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export function readPending(home?: string, now = Date.now()): { selection: PendingSelection; expired: boolean } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingPath(home), "utf8")) as PendingSelection;
    if (typeof parsed?.uid !== "string") return null;
    const created = Date.parse(parsed.createdAt ?? "");
    const expired = Number.isFinite(created) ? now - created > PENDING_TTL_MS : false;
    return { selection: parsed, expired };
  } catch {
    return null;
  }
}

export function clearPending(home?: string): boolean {
  try {
    fs.unlinkSync(pendingPath(home));
    return true;
  } catch {
    return false;
  }
}

/** Read and clear in one step, so a hook can never deliver the same session twice. */
export function takePending(home?: string): PendingSelection | null {
  const found = readPending(home);
  if (!found) return null;
  clearPending(home);
  return found.expired ? null : found.selection;
}
