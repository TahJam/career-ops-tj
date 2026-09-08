// @ts-check
// The reconciler: (sheet rows, tracker rows, config) -> a write plan.
//
// PURE. No network, no filesystem, no clock. Every fact it needs is passed in,
// so the join, the date ordering and the A:H-only write planning are testable
// against fixtures — which is where the bugs in this feature actually live.
//
// One reconciler serves both sync modes (full and delta). Separate code paths
// would drift and start producing different sheets; a scope filter cannot.

/** Sheet columns, in order. Nothing outside A:H is ever planned. */
export const COLUMNS = ['company', 'role', 'date', 'resume', 'link', 'location', 'referral', 'status'];
export const LAST_COL = 'H';

/** Tracker states that mean "this application exists in the outside world". */
export const SYNCED_STATES = new Set(['Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected']);

/**
 * Join key. Company + role, punctuation-insensitive.
 *
 * Deliberately NOT date-based: the tracker's Date is the EVALUATION date and the
 * sheet's is the APPLY date. Report #94 differs by 11 weeks across the two.
 */
export function joinKey(company, role) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm(company)}|${norm(role)}`;
}

/** A URL rendered as the clickable "Link" text the sheet already uses. */
export function hyperlinkFormula(url, label = 'Link') {
  if (!url || !/^https?:\/\//i.test(url)) return label;
  // Escape for the formula string literal; also strip anything that could close
  // it early. A job URL is untrusted input (it comes from a posting).
  const safe = String(url).replace(/["\\]/g, '').replace(/[\r\n\t]/g, '');
  return `=HYPERLINK("${safe}","${label}")`;
}

/**
 * Build the desired A:H row set as the union of both sides, date-ordered.
 *
 * Precedence, per plan §2.2:
 *   - sheet-only rows survive verbatim (they pre-date career-ops)
 *   - on an overlap the SHEET wins Date (it holds the true apply date) and
 *     career-ops wins Response (it holds the current status)
 *   - tracker-only rows are built from career-ops facts
 *
 * @param {{
 *   sheetRows: Array<{ rowNumber: number, cells: string[], link: string|null }>,
 *   trackerRows: Array<Record<string, any>>,
 *   facts: (row: Record<string, any>) => { applyDate: string|null, resume: string|null, url: string|null, referral: boolean },
 *   statusMap: Record<string, string>,
 *   locationDefault: string,
 *   year: number|null,
 * }} input
 * @returns {{ rows: string[][], stats: object, skipped: Array<object> }}
 */
export function buildDesiredRows({ sheetRows, trackerRows, facts, statusMap, locationDefault, year = null }) {
  const skipped = [];
  const byKey = new Map();

  // 1. Sheet rows first — they are the historical record and always survive.
  for (const r of sheetRows) {
    const [company, role, date, resume, , location, referral, status] = r.cells;
    byKey.set(joinKey(company, role), {
      source: 'sheet',
      company, role, date, resume, location, referral, status,
      link: r.link ? hyperlinkFormula(r.link) : (r.cells[4] || ''),
    });
  }

  // 2. Fold in the tracker.
  let updated = 0;
  let added = 0;
  for (const t of trackerRows) {
    const status = String(t.status ?? '').trim();
    if (!SYNCED_STATES.has(status)) continue;

    const mapped = statusMap[status];
    if (!mapped) { skipped.push({ num: t.num, company: t.company, reason: `no status_map entry for "${status}"` }); continue; }

    const key = joinKey(t.company, t.role);
    const existing = byKey.get(key);
    const f = facts(t);

    if (existing) {
      // Overlap: career-ops owns Response, the sheet keeps everything else.
      if (existing.status !== mapped) { existing.status = mapped; updated++; }
      existing.source = 'both';
      continue;
    }

    const date = f.applyDate || t.date || '';
    if (year !== null && date.slice(0, 4) !== String(year)) {
      skipped.push({ num: t.num, company: t.company, reason: `date ${date || '(none)'} is outside ${year}` });
      continue;
    }
    byKey.set(key, {
      source: 'tracker',
      company: String(t.company ?? '').trim(),
      role: String(t.role ?? '').trim(),
      date,
      resume: f.resume || '',
      link: hyperlinkFormula(f.url),
      location: locationDefault,
      referral: f.referral ? 'Yes' : 'No',
      status: mapped,
    });
    added++;
  }

  // 3. Date order. Undated rows sort last but keep their relative order, so a
  //    row with a missing date never silently jumps to the top of the sheet.
  const all = [...byKey.values()];
  const rows = all
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ad = a.r.date || '9999-99-99';
      const bd = b.r.date || '9999-99-99';
      return ad === bd ? a.i - b.i : (ad < bd ? -1 : 1);
    })
    .map(({ r }) => [r.company, r.role, r.date, r.resume, r.link, r.location, r.referral, r.status]);

  return {
    rows,
    stats: { total: rows.length, fromSheet: sheetRows.length, added, updated, skipped: skipped.length },
    skipped,
  };
}

/**
 * Turn the desired rows into concrete write operations.
 *
 * Invariants enforced here, not by the caller (plan §2.2):
 *   - only A2:H<n> is ever written; I/J hold live COUNTIF/SUM formulas
 *   - no row insert/delete/sort — reordering happens by rewriting VALUES, which
 *     leaves the sidecar's grid position untouched
 *   - a shrunk row set clears the tail within A:H only
 *
 * @returns {{ update: {range: string, values: string[][]}|null, clear: string|null, rowCount: number }}
 */
export function planWrites({ rows, previousLastRow, tab }) {
  const firstDataRow = 2;
  const lastRow = firstDataRow + rows.length - 1;
  const update = rows.length
    ? { range: `A${firstDataRow}:${LAST_COL}${lastRow}`, values: rows }
    : null;
  const clear = previousLastRow > lastRow
    ? `A${lastRow + 1}:${LAST_COL}${previousLastRow}`
    : null;
  return { update, clear, rowCount: rows.length, tab, lastRow };
}

/**
 * Which tracker rows a delta run should look at, from the status-log journal.
 * @param {string} journal  raw data/status-log.tsv
 * @param {number} cursor   lines already consumed
 * @returns {{ nums: Set<number>, cursor: number }}
 */
export function pendingFromJournal(journal, cursor = 0) {
  const lines = String(journal ?? '').split('\n').filter(l => l.trim());
  const nums = new Set();
  for (const line of lines.slice(cursor)) {
    const num = line.split('\t')[0];
    if (/^\d+$/.test(num)) nums.add(parseInt(num, 10));
  }
  return { nums, cursor: lines.length };
}

/**
 * The sheet's CURRENT A:H content, in the same shape buildDesiredRows emits.
 *
 * Column E needs reconstructing: a read returns the cell TEXT ("Link") with the
 * URL in a separate output-only `hyperlink` field, while a write emits
 * =HYPERLINK(url,"Link"). Comparing the raw cells would report a difference on
 * every row forever.
 *
 * @param {Array<{cells: string[], link: string|null}>} sheetRows
 * @returns {string[][]}
 */
export function currentSheetValues(sheetRows) {
  return sheetRows.map((r) => {
    const cells = [...r.cells];
    cells[4] = r.link ? hyperlinkFormula(r.link) : (cells[4] || '');
    return cells;
  });
}

/**
 * Does the sheet already match the plan?
 *
 * This is the sync's real correctness gate. An earlier design gated on
 * data/status-log.tsv, but that journal has exactly ONE writer
 * (set-status.mjs) — the Go dashboard, merge-tracker.mjs, normalize-statuses.mjs
 * and hand edits all change a status without appending to it, so the sync
 * silently no-opped while the sheet went stale. Comparing actual values instead
 * of consulting a proxy is correct for every writer, present and future.
 *
 * Compare in ISO date space (buildDesiredRows output), NOT the US-formatted
 * values handed to the API.
 *
 * @returns {boolean} true when a write would change nothing
 */
export function planIsNoOp(currentValues, plannedRows) {
  if (currentValues.length !== plannedRows.length) return false;
  for (let i = 0; i < plannedRows.length; i++) {
    for (let c = 0; c < COLUMNS.length; c++) {
      if ((currentValues[i]?.[c] ?? '') !== (plannedRows[i]?.[c] ?? '')) return false;
    }
  }
  return true;
}
