/** Types for the Obsidian companion script (plain JavaScript, used by the API tests). */
export interface SyncConfig {
  vault: string;
  url: string;
  token: string;
}
export interface SyncSummary {
  written: number;
  pushed: number;
  applied: number;
  conflicts: number;
  removed: number;
}
export function safePath(vault: string, rel: string): string | null;
export function syncOnce(cfg: SyncConfig, log?: (line: string) => void): Promise<SyncSummary>;
