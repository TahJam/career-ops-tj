// @ts-check
// Google Sheets sync — mirror the application tracker into the user's own sheet.
//
// data/applications.md stays the source of truth; the sheet is an additive
// mirror. One command drives both sync modes:
//
//   node plugins.mjs run sheets export [--dry-run]
//
// Scope comes from the plugin's cursor (data/sheets-sync-state.json), not from a
// flag — plugins.mjs ignores positional args for `export`, so a hook that needed
// arguments could not be driven at all. No state file means a full sync, which
// makes the first run self-bootstrapping.
//
// What this never does, and why (the sheet has live formulas interleaved with
// the data, and hyperlinks the values API cannot round-trip):
//   - never writes outside A:H — I/J hold COUNTIF/SUM counters
//   - never inserts, deletes or sorts rows — that would shift I/J's position;
//     reordering happens by rewriting values in place
//   - never writes a bare "Link" — column E is rebuilt as =HYPERLINK(...)

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { readTab, readFormulas, a1, isoToUsDate, colLetter } from './_sheets.mjs';
import { getAccessToken, SCOPE_WRITE } from './_auth.mjs';
import { buildDesiredRows, planWrites, pendingFromJournal, SYNCED_STATES } from './_reconcile.mjs';
import { applyDates, resumeNames, reportFacts, reportNumsFromCell, profileLocation } from './_sources.mjs';
import { loadState, saveState, writeBackup } from './_state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

const DEFAULTS = {
  tab: 'Apply 2026',
  location_default: '',
  max_rows_per_run: 50,
  status_map: {
    Applied: 'Submitted - Waiting',
    Responded: 'Submitted - Waiting',
    Interview: 'Interviewing',
    Offer: 'Offer Received',
    Hired: 'Offer Accepted',
    Rejected: 'Rejected',
  },
};

/** Year the tab is scoped to, from a trailing 4-digit year in its name. */
function tabYear(tab) {
  const m = /(\d{4})\s*$/.exec(String(tab));
  return m ? parseInt(m[1], 10) : null;
}

/** Referral evidence, from the report's `via:` or a mention in the tracker note. */
function isReferral(row, facts) {
  if (facts.via) return true;
  return /\breferr(al|ed)\b/i.test(String(row.notes ?? ''));
}

export default {
  /**
   * export: reconcile the user's Google Sheet with the tracker snapshot.
   * @param {{ applications: Array<Record<string,string>> }} snapshot
   * @param {any} ctx
   * @returns {Promise<{pushed: number}>}
   */
  async export(snapshot, ctx) {
    const log = (m) => ctx?.log?.(m);

    if (String(ctx?.env?.GOOGLE_SYNC ?? 'true').toLowerCase() === 'false') {
      log('GOOGLE_SYNC=false — sync disabled, nothing done.');
      return { pushed: 0 };
    }

    const cfg = { ...DEFAULTS, ...(ctx?.settings ?? {}) };
    cfg.status_map = { ...DEFAULTS.status_map, ...(ctx?.settings?.status_map ?? {}) };
    const tab = cfg.tab;
    const year = tabYear(tab);

    // ── scope ─────────────────────────────────────────────────────────
    const journalPath = path.join(ROOT, 'data', 'status-log.tsv');
    const journal = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
    const state = loadState();
    const forceFull = String(ctx?.env?.SHEETS_SYNC_MODE ?? '').toLowerCase() === 'full';
    const full = forceFull || state === null;
    const { nums: pending, cursor } = pendingFromJournal(journal, full ? 0 : state.statusLogCursor);

    if (!full && pending.size === 0) {
      log('nothing pending since the last sync.');
      return { pushed: 0 };
    }
    log(full
      ? `full sync${forceFull ? ' (SHEETS_SYNC_MODE=full)' : ' (no cursor yet)'} → ${tab}`
      : `delta sync → ${tab}: ${pending.size} row(s) changed since the last run`);

    // ── read both sides ───────────────────────────────────────────────
    const sheet = await readTab(ctx, tab);
    const dates = applyDates();
    const resumes = resumeNames();
    const location = cfg.location_default || profileLocation('');

    const all = Array.isArray(snapshot?.applications) ? snapshot.applications : [];
    // A delta run still reconciles the WHOLE union — it just refuses to act when
    // nothing changed. Narrowing the input set instead would let the two modes
    // produce different sheets, which is the drift this design exists to avoid.
    const trackerRows = all.map(r => ({
      num: parseInt(r['#'], 10),
      company: r.company,
      role: r.role,
      date: r.date,
      status: r.status,
      notes: r.notes,
      report: r.report,
    })).filter(r => Number.isInteger(r.num));

    const facts = (row) => {
      const reportNum = reportNumsFromCell(row.report)[0] ?? row.num;
      const rf = reportFacts(reportNum);
      return {
        applyDate: dates.get(row.num) ?? null,
        resume: resumes.get(reportNum) ?? rf.pdf ?? null,
        url: rf.url,
        referral: isReferral(row, rf),
      };
    };

    const { rows, stats, skipped } = buildDesiredRows({
      sheetRows: sheet.rows,
      trackerRows,
      facts,
      statusMap: cfg.status_map,
      locationDefault: location,
      year,
    });

    // Column C's DATE number format stops partway down the grid; rows past it
    // would land as plain text and drop out of the COUNTIF(C:C,…) counters.
    const plan = planWrites({ rows, previousLastRow: sheet.lastDataRow, tab });
    const values = rows.map(r => [...r]);
    values.forEach(r => { r[2] = isoToUsDate(r[2]) || r[2]; });

    log(`plan: ${stats.total} row(s) — ${stats.fromSheet} existing, ${stats.added} added, ${stats.updated} status update(s)`);
    for (const s of skipped) log(`  skipped #${s.num} ${s.company}: ${s.reason}`);

    const changed = stats.added + stats.updated;
    if (changed > cfg.max_rows_per_run) {
      throw new Error(`refusing to write ${changed} rows in one run (max_rows_per_run=${cfg.max_rows_per_run}) — raise it in config/plugins.yml if this is intended`);
    }

    if (ctx?.dryRun) {
      log(`would write ${a1(tab, plan.update?.range ?? '(nothing)')}${plan.clear ? ` and clear ${a1(tab, plan.clear)}` : ''}`);
      for (const r of values.slice(-Math.min(values.length, stats.added + 2))) {
        log(`  ${r[2]}  ${r[0]} — ${r[1]}  [${r[7]}]  ${r[3] || '(no resume)'}`);
      }
      log('(--dry-run: sheet not written)');
      return { pushed: 0 };
    }

    if (!plan.update) { log('nothing to write.'); return { pushed: 0 }; }

    // ── backup, then write ────────────────────────────────────────────
    const backup = writeBackup(tab, {
      tab,
      capturedAt: new Date().toISOString(),
      lastDataRow: sheet.lastDataRow,
      rows: sheet.rows,
      sidecarFormulas: await readFormulas(ctx, tab, 'I1:J10'),
    });
    log(`backup → ${backup}`);

    const token = await getAccessToken(ctx, SCOPE_WRITE);
    const sheetId = String(ctx.env.GOOGLE_SHEET_ID).trim().replace(/^(['"])(.*)\1$/, '$2');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    if (plan.clear) {
      await ctx.fetch(`${API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(a1(tab, plan.clear))}:clear`,
        { method: 'POST', headers, body: '{}', timeoutMs: 20_000 });
    }

    // USER_ENTERED, never RAW: column C must stay a real date for
    // COUNTIF(C:C,TODAY()-1), and column E must evaluate as =HYPERLINK.
    await ctx.fetch(
      `${API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(a1(tab, plan.update.range))}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', headers, body: JSON.stringify({ values }), timeoutMs: 20_000 },
    );

    // Persist the cursor IMMEDIATELY after the write lands. runHook's 15s
    // timeout is cooperative — it resolves the wait without aborting the hook —
    // so a slow run can be reported as failed while the write succeeded. Saving
    // here means the retry sees a caught-up cursor instead of double-writing.
    saveState({ statusLogCursor: cursor, rows: {}, lastSyncedAt: new Date().toISOString(), tab });

    if (sheet.dateFormatLastRow < plan.lastRow) {
      await extendDateFormat(ctx, sheetId, tab, sheet.dateFormatLastRow, plan.lastRow, headers);
      log(`extended column C date format to row ${plan.lastRow}`);
    }

    log(`wrote ${a1(tab, plan.update.range)} (${stats.added} added, ${stats.updated} updated)`);
    return { pushed: changed };
  },
};

/**
 * Copy row 2's formats down column C only.
 *
 * copyPaste with PASTE_FORMAT rather than a values write: it carries the DATE
 * numberFormat without touching any cell content, and is scoped to one column
 * so it can never disturb the sidecar in I/J.
 */
async function extendDateFormat(ctx, sheetId, tab, fromRow, toRow, headers) {
  const tabs = await ctx.fetchJson(`${API}/${encodeURIComponent(sheetId)}?fields=sheets.properties`, { headers, timeoutMs: 20_000 });
  const target = (tabs.sheets ?? []).find(s => s.properties.title === tab);
  if (!target) return;
  const gridId = target.properties.sheetId;
  await ctx.fetch(`${API}/${encodeURIComponent(sheetId)}:batchUpdate`, {
    method: 'POST',
    headers,
    timeoutMs: 20_000,
    body: JSON.stringify({
      requests: [{
        copyPaste: {
          source: { sheetId: gridId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex: 3 },
          destination: { sheetId: gridId, startRowIndex: Math.max(fromRow, 1), endRowIndex: toRow, startColumnIndex: 2, endColumnIndex: 3 },
          pasteType: 'PASTE_FORMAT',
        },
      }],
    }),
  });
}
