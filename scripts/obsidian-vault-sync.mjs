#!/usr/bin/env node
/**
 * Obsidian vault sync for the club platform (Phase 6).
 *
 * Obsidian has no server API: a vault is a folder of Markdown files on your computer. This
 * script runs on that computer, asks the platform for your meetings and writes them into the
 * vault as notes; in two-way mode it sends back the notes you edited (the title property and
 * the Purpose and Notes sections). It needs Node.js 18+ or Bun, and nothing else.
 *
 *   node obsidian-vault-sync.mjs --vault "/path/to/My Vault" --url https://<web-app>/api --token obs_…
 *   node obsidian-vault-sync.mjs … --watch 300        # keep running, sync every 5 minutes
 *
 * The same settings can come from ESPORTS_VAULT, ESPORTS_API_URL and ESPORTS_SYNC_TOKEN.
 * Create the token in the platform: Settings → Integrations → Obsidian (it is shown once).
 *
 * Safety:
 * - Nothing you write is lost. If an edit can't be applied (changed on the platform too, or you
 *   may not change that meeting), your version is kept next to the note as
 *   "<note>.conflict-<time>.md" before the platform's version is written.
 * - Notes for meetings you're no longer part of are moved to Meetings/_removed/, not deleted.
 * - Only files under Meetings/ ending in .md are ever written; paths from the server are
 *   checked, so nothing can be written outside the vault.
 * - Sync state is kept in .esports-platform-sync.json at the vault root (Obsidian ignores
 *   dotfiles).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

const STATE_FILE = '.esports-platform-sync.json';
const ROOT = 'Meetings';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** A vault-relative path from the server, accepted only under Meetings/ and ending in .md. */
export function safePath(vault, rel) {
  if (typeof rel !== 'string' || !rel.endsWith('.md') || rel.includes('\0')) return null;
  const clean = normalize(rel).replace(/\\/g, '/');
  if (clean.startsWith('/') || clean.split('/').includes('..') || !clean.startsWith(`${ROOT}/`))
    return null;
  const full = resolve(vault, clean);
  const back = relative(resolve(vault), full);
  if (back.startsWith('..') || back.startsWith(sep)) return null;
  return full;
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

async function keepConflict(path, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.replace(/\.md$/, `.conflict-${stamp}.md`);
  await writeAtomic(copy, content);
  return copy;
}

async function api(cfg, method, path, body) {
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.error?.code ?? res.status;
    throw new Error(
      code === 'unauthenticated'
        ? 'The token was refused (revoked or mistyped).'
        : `The platform answered ${res.status} (${code}).`,
    );
  }
  return data;
}

export async function syncOnce(cfg, log = console.log) {
  const vault = resolve(cfg.vault);
  if (!(await exists(vault))) throw new Error(`Vault folder not found: ${vault}`);
  const statePath = join(vault, STATE_FILE);
  const state = (await exists(statePath))
    ? JSON.parse(await readFile(statePath, 'utf8'))
    : { cursor: null, direction: null, notes: {} };
  const summary = { written: 0, pushed: 0, applied: 0, conflicts: 0, removed: 0 };

  // 1. Local edits since the last sync.
  const edited = [];
  for (const [meetingId, n] of Object.entries(state.notes)) {
    const path = safePath(vault, n.path);
    if (!path || !(await exists(path))) continue;
    const content = await readFile(path, 'utf8');
    if (sha(content) !== n.hash) edited.push({ meetingId, baseVersion: n.version, content, path });
  }

  // 2. Send them back (two-way). Push-only connections answer "ignored".
  for (let i = 0; i < edited.length; i += 50) {
    const batch = edited.slice(i, i + 50);
    const res = await api(cfg, 'POST', '/integrations/obsidian/push', {
      notes: batch.map(({ meetingId, baseVersion, content }) => ({
        meetingId,
        baseVersion,
        content,
      })),
    });
    for (const r of res.results) {
      const local = batch.find((b) => b.meetingId === r.meetingId);
      summary.pushed += 1;
      if (r.outcome === 'not_found' || !r.content) continue;
      if (r.outcome === 'conflict' || r.outcome === 'rejected' || r.outcome === 'ignored') {
        const copy = await keepConflict(local.path, local.content);
        summary.conflicts += 1;
        log(
          `kept your version of ${relative(vault, local.path)} as ${relative(vault, copy)} (${r.outcome}${r.message ? `: ${r.message}` : ''})`,
        );
      } else if (r.outcome === 'applied') summary.applied += 1;
      await writeAtomic(local.path, r.content);
      state.notes[r.meetingId] = {
        ...state.notes[r.meetingId],
        version: r.version,
        hash: sha(r.content),
      };
    }
  }

  // 3. What changed on the platform.
  const feed = await api(
    cfg,
    'GET',
    `/integrations/obsidian/feed${state.cursor ? `?since=${encodeURIComponent(state.cursor)}` : ''}`,
  );
  state.direction = feed.direction;
  for (const n of feed.notes) {
    const known = state.notes[n.meetingId];
    if (n.deleted) {
      const old = known && safePath(vault, known.path);
      if (old && (await exists(old))) {
        const target = safePath(vault, `${ROOT}/_removed/${old.split(sep).pop()}`);
        if (target) {
          await mkdir(dirname(target), { recursive: true });
          await rename(old, target);
          summary.removed += 1;
        }
      }
      delete state.notes[n.meetingId];
      continue;
    }
    const path = safePath(vault, n.path);
    if (!path) {
      log(`skipped an unexpected path from the server: ${String(n.path).slice(0, 120)}`);
      continue;
    }
    const oldPath = known && safePath(vault, known.path);
    if (n.content === null && known && oldPath === path) continue;
    if (n.content === null) continue; // unchanged and not in the vault yet: next full sync writes it
    // Don't overwrite an edit that wasn't sent (e.g. made during this run).
    const current = oldPath && (await exists(oldPath)) ? await readFile(oldPath, 'utf8') : null;
    if (current !== null && known && sha(current) !== known.hash) {
      const copy = await keepConflict(oldPath, current);
      summary.conflicts += 1;
      log(`kept your unsent edit as ${relative(vault, copy)}`);
    }
    await writeAtomic(path, n.content);
    if (oldPath && oldPath !== path && (await exists(oldPath))) await rm(oldPath);
    state.notes[n.meetingId] = { path: n.path, version: n.version, hash: sha(n.content) };
    summary.written += 1;
  }
  state.cursor = feed.cursor;
  await writeAtomic(statePath, JSON.stringify(state, null, 2));
  return summary;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cfg = {
    vault: a.vault ?? process.env.ESPORTS_VAULT,
    url: a.url ?? process.env.ESPORTS_API_URL,
    token: a.token ?? process.env.ESPORTS_SYNC_TOKEN,
  };
  if (!cfg.vault || !cfg.url || !cfg.token) {
    console.error(
      'Usage: obsidian-vault-sync.mjs --vault <folder> --url <https://web-app/api> --token <obs_…> [--watch <seconds>]',
    );
    process.exit(2);
  }
  const every = a.watch ? Math.max(60, Number(a.watch)) : 0;
  for (;;) {
    try {
      const s = await syncOnce(cfg);
      console.log(
        `synced: ${s.written} written, ${s.applied} edits applied, ${s.conflicts} kept as conflict copies, ${s.removed} moved to _removed`,
      );
    } catch (e) {
      console.error(`sync failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!every) process.exit(1);
    }
    if (!every) return;
    await new Promise((r) => setTimeout(r, every * 1000));
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('obsidian-vault-sync.mjs')
)
  await main();
