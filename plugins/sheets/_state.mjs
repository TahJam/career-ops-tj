// @ts-check
// The plugin's own cursor + pre-write backups.
//
// Same shape as plugins/gmail/index.mjs's data/gmail-state.json: a plugin that
// needs to remember what it already handled keeps its own small state file.
//
// The cursor is what lets ONE argument-free command serve both sync modes. The
// export hook receives no arguments (plugins.mjs ignores positionals for
// `export`), so scope has to live somewhere else — here. Absence of the file
// means "full sync", which makes the first run self-bootstrapping and makes
// `rm data/sheets-sync-state.json` the legible "resync everything" gesture.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_PATH = path.join(ROOT, 'data', 'sheets-sync-state.json');
const BACKUP_DIR = path.join(ROOT, 'data', 'sheet-backups');

/** @returns {{ statusLogCursor: number, rows: Record<string, any> }|null} null when never synced. */
export function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { statusLogCursor: Number(s.statusLogCursor) || 0, rows: s.rows ?? {} };
  } catch {
    // A corrupt cursor must not silently downgrade to "delta from 0" — treating
    // it as absent forces a full reconcile, which is the safe direction.
    return null;
  }
}

export function saveState(state) {
  try {
    mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn(`sheets: could not persist cursor — ${err.message}`);
    return false;
  }
}

/**
 * Snapshot the tab before writing: values, formulas AND hyperlinks.
 *
 * This is the only real undo. It deliberately covers A:J — wider than anything
 * the sync writes — so the sidecar COUNTIF/SUM formulas in I/J are recoverable
 * even though the writer never touches them.
 *
 * @returns {string} the backup file path
 */
export function writeBackup(tab, payload) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = String(tab).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = path.join(BACKUP_DIR, `${slug}-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return path.relative(ROOT, file);
}
