/**
 * Types for the generated copy of `integrations/_shared/resolve.mjs`.
 *
 * The resolver is plain JavaScript on purpose (see its own header): harness
 * hooks run under whatever runtime the harness ships, before TypeScript support
 * is guaranteed. This declaration file exists only so the TypeScript surfaces
 * that import it (`hub.ts`, and through it `plugin.ts` / `tui.tsx`) are typed
 * without turning on `allowJs`.
 *
 * Keep in sync with `integrations/_shared/resolve.mjs`. `tools/sync-shared.mjs`
 * rewrites the `.mjs` copy and leaves this file alone.
 */

export interface HubRunOptions {
  /** Directory the plugin was loaded from; `<pluginRoot>/vendor` is checked second. */
  pluginRoot?: string
  /** Kill the child after this many milliseconds. Defaults to 120000. */
  timeoutMs?: number
}

export interface HubRunResult {
  code: number
  stdout: string
  stderr: string
  /** True when the hub could not be located or spawned at all. */
  missing?: boolean
}

export type HubJsonResult<Data> =
  | { ok: true; data: Data; result: HubRunResult }
  | { ok: false; error: string; result: HubRunResult }

export declare function looksLikeRoot(dir?: string | null): boolean
export declare function hubRoot(pluginRoot?: string): string | null
export declare function missingHubMessage(): string
export declare function runHub(args: string[], options?: HubRunOptions): Promise<HubRunResult>
export declare function runHubJson<Data = unknown>(
  args: string[],
  options?: HubRunOptions,
): Promise<HubJsonResult<Data>>
