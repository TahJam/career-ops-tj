// @ts-check
// Google Sheets API access + the cell-level conversions the sync depends on.
//
// The read deliberately uses spreadsheets.get with a fields mask rather than
// spreadsheets.values.get, because the values API cannot see two things this
// sync must preserve:
//
//   1. Column E's URLs. They are cell-level hyperlinks: userEnteredValue is the
//      string "Link" and the URL lives in the separate, OUTPUT-ONLY `hyperlink`
//      field. Writing "Link" back through the values API keeps the text and
//      silently destroys every link.
//   2. Column H's ONE_OF_LIST validation and column C's DATE number format,
//      which stop partway down the grid and must be extended when rows are added.

import { getAccessToken, SCOPE_READ } from './_auth.mjs';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Sheets serial-date epoch: 1899-12-30 UTC. */
const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** Sheets date serial -> "YYYY-MM-DD". */
export function serialToIso(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return '';
  return new Date(SERIAL_EPOCH_MS + Math.round(serial) * DAY_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" -> Sheets date serial. */
export function isoToSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - SERIAL_EPOCH_MS) / DAY_MS);
}

/** "YYYY-MM-DD" -> "MM/DD/YYYY", the pattern column C already renders with. */
export function isoToUsDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

/** 0-based column index -> A1 letter(s). */
export function colLetter(index) {
  let n = index, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

/** Quote a tab name for an A1 range ('Apply 2026'!A1:H5). */
export function a1(tab, range) {
  return `'${String(tab).replace(/'/g, "''")}'!${range}`;
}

async function api(ctx, pathAndQuery, { method = 'GET', body, scope = SCOPE_READ } = {}) {
  const token = await getAccessToken(ctx, scope);
  const sheetId = String(ctx?.env?.GOOGLE_SHEET_ID ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID is empty');
  const res = await ctx.fetch(`${API}/${encodeURIComponent(sheetId)}${pathAndQuery}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    timeoutMs: 20_000,
  });
  return res.json();
}

/** Tab metadata for the whole spreadsheet. */
export async function getTabs(ctx) {
  const meta = await api(ctx, '?fields=properties.title,sheets.properties');
  return (meta.sheets ?? []).map(s => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
    rowCount: s.properties.gridProperties?.rowCount ?? 0,
    columnCount: s.properties.gridProperties?.columnCount ?? 0,
  }));
}

/**
 * Read one tab's A:H grid, carrying the cell-level detail the values API drops.
 *
 * @returns {Promise<{
 *   header: string[],
 *   rows: Array<{ rowNumber: number, cells: string[], link: string|null }>,
 *   lastDataRow: number,
 *   validationLastRow: number,
 *   dateFormatLastRow: number,
 * }>}
 */
export async function readTab(ctx, tab, { maxRows = 1000, lastCol = 'H' } = {}) {
  const fields = 'sheets.data.rowData.values(formattedValue,userEnteredValue,hyperlink,dataValidation,userEnteredFormat.numberFormat)';
  const range = encodeURIComponent(a1(tab, `A1:${lastCol}${maxRows}`));
  const res = await api(ctx, `?ranges=${range}&fields=${encodeURIComponent(fields)}`);
  const rowData = res.sheets?.[0]?.data?.[0]?.rowData ?? [];

  const header = (rowData[0]?.values ?? []).map(v => v?.formattedValue ?? '');
  const rows = [];
  let validationLastRow = 0;
  let dateFormatLastRow = 0;

  rowData.forEach((rd, i) => {
    const rowNumber = i + 1;
    const values = rd.values ?? [];
    if (values[7]?.dataValidation) validationLastRow = rowNumber;
    if (values[2]?.userEnteredFormat?.numberFormat?.type === 'DATE') dateFormatLastRow = rowNumber;
    if (rowNumber === 1) return;

    const cells = [];
    for (let c = 0; c < 8; c++) {
      const v = values[c];
      // Column C is a date serial; normalise to ISO so comparisons are date-based.
      if (c === 2 && typeof v?.userEnteredValue?.numberValue === 'number') {
        cells.push(serialToIso(v.userEnteredValue.numberValue));
      } else {
        cells.push(v?.formattedValue ?? '');
      }
    }
    if (cells.every(c => !c)) return; // fully blank row
    rows.push({ rowNumber, cells, link: values[4]?.hyperlink ?? null });
  });

  const lastDataRow = rows.length ? rows[rows.length - 1].rowNumber : 1;
  return { header, rows, lastDataRow, validationLastRow, dateFormatLastRow };
}

/**
 * Read the exact formulas in a column range — used to snapshot the sidecar
 * counters (I/J) into the pre-write backup so a bad run is recoverable.
 */
export async function readFormulas(ctx, tab, range) {
  const res = await api(ctx, `/values/${encodeURIComponent(a1(tab, range))}?valueRenderOption=FORMULA`);
  return res.values ?? [];
}
