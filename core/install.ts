/**
 * Locating the hub from an installed plugin.
 *
 * Plugins do not live next to this code: harnesses copy them into their own
 * cache, and hooks run from the project directory. So every integration needs
 * the same, boring answer to "where is the real session-hub?".
 *
 * Resolution order, first hit wins:
 *   1. an in-plugin `vendor/` copy, which makes the plugin self-contained
 *   2. $SESSION_HUB_ROOT, for people running from a checkout
 *   3. ~/.session-hub/install.json, written by `sessionhub setup`
 *   4. the `sessionhub` binary on PATH
 * and if all four fail, say exactly that instead of failing obscurely.
 */

import fs from "node:fs";
import path from "node:path";

import { hubHome } from "./hub.ts";

export interface InstallRecord {
  /** Directory that contains bin/ and mcp/. */
  root: string;
  /** Absolute path to the CLI entry point. */
  cli: string;
  /** Absolute path to the MCP server entry point. */
  mcp: string;
  version: string;
  installedAt: string;
}

export function installRecordPath(home?: string): string {
  return path.join(hubHome(home), "install.json");
}

/** The directory that holds bin/ and mcp/, derived from this file's location. */
export function packageRoot(): string {
  // core/install.ts -> repo root
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

export function looksLikeRoot(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, "bin", "sessionhub.mjs")) &&
      fs.existsSync(path.join(dir, "mcp", "server.mjs"))
    );
  } catch {
    return false;
  }
}

export function writeInstallRecord(root: string, home?: string): InstallRecord {
  const record: InstallRecord = {
    root,
    cli: path.join(root, "bin", "sessionhub.mjs"),
    mcp: path.join(root, "mcp", "server.mjs"),
    version: readOwnVersion(root),
    installedAt: new Date().toISOString(),
  };
  const target = installRecordPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export function readInstallRecord(home?: string): InstallRecord | null {
  try {
    const raw = fs.readFileSync(installRecordPath(home), "utf8");
    const parsed = JSON.parse(raw) as InstallRecord;
    return typeof parsed?.root === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function readOwnVersion(root: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Copy the code an integration needs into its own directory.
 *
 * Claude Code moves a plugin into its cache, and a marketplace install has no
 * relationship with this checkout, so a plugin that wants to run the hub has to
 * carry it. Vendoring is what makes `claude plugin install` work with no global
 * setup step.
 */
export function vendorInto(targetDir: string, root = packageRoot()): { files: number; bytes: number } {
  const vendor = path.join(targetDir, "vendor");
  fs.rmSync(vendor, { recursive: true, force: true });
  fs.mkdirSync(vendor, { recursive: true });

  let files = 0;
  let bytes = 0;
  const copyTree = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        copyTree(src, dst);
        continue;
      }
      const data = fs.readFileSync(src);
      fs.writeFileSync(dst, data);
      files++;
      bytes += data.byteLength;
    }
  };

  for (const dir of ["core", "bin", "mcp"]) {
    const from = path.join(root, dir);
    if (fs.existsSync(from)) copyTree(from, path.join(vendor, dir));
  }
  fs.writeFileSync(
    path.join(vendor, "package.json"),
    `${JSON.stringify({ name: "session-hub-vendor", version: readOwnVersion(root), type: "module" }, null, 2)}\n`,
  );
  return { files, bytes };
}
