// tests/sheets-reconcile.test.mjs — the pure reconciler behind the sheets plugin.
//
// Fixtures mirror the real "Apply 2026" tab: sidecar COUNTIF/SUM formulas in
// I/J that must never be written, cell-level hyperlinks in column E that the
// values API cannot round-trip, and a tracker whose Date column is the
// EVALUATION date rather than the apply date.

import {
  joinKey, hyperlinkFormula, buildDesiredRows, planWrites, pendingFromJournal, SYNCED_STATES,
} from '../plugins/sheets/_reconcile.mjs';
import { pass, fail } from './helpers.mjs';

const ok = (label, cond) => (cond ? pass(label) : fail(label));

const STATUS_MAP = {
  Applied: 'Submitted - Waiting',
  Responded: 'Submitted - Waiting',
  Interview: 'Interviewing',
  Offer: 'Offer Received',
  Hired: 'Offer Accepted',
  Rejected: 'Rejected',
};
const LOC = 'Austin, TX';
const noFacts = () => ({ applyDate: null, resume: null, url: null, referral: false });
const sheetRow = (rowNumber, company, role, date, resume, link, status) => ({
  rowNumber, link, cells: [company, role, date, resume, 'Link', LOC, 'No', status],
});

console.log('\nsheets reconciler — join key');
ok('company+role match ignores punctuation and case',
  joinKey('Lightspeed Systems', 'Software Engineer (AI Native)') === joinKey('lightspeed systems', 'Software Engineer AI Native'));
ok('different roles at one company stay distinct',
  joinKey('Sierra', 'SWE, Agent - Healthcare') !== joinKey('Sierra', 'SWE, Agent - Insurance'));

console.log('\nsheets reconciler — hyperlink rendering');
ok('a URL becomes a HYPERLINK formula, not the bare text',
  hyperlinkFormula('https://example.com/job/1') === '=HYPERLINK("https://example.com/job/1","Link")');
ok('a missing URL degrades to plain label (never a broken formula)',
  hyperlinkFormula(null) === 'Link');
ok('quotes/backslashes in an untrusted job URL cannot close the formula string',
  !/[\\]/.test(hyperlinkFormula('https://x.test/a"),"pwned")+IMPORTLOC("evil')) &&
  hyperlinkFormula('https://x.test/a"b').split('"').length === 5);

console.log('\nsheets reconciler — union semantics');
{
  const sheetRows = [
    sheetRow(2, 'Datasent', 'Back end Developer', '2026-01-20', 'TJ FTS SE', 'https://x.test/1', 'Submitted - Waiting'),
    sheetRow(3, 'Lightspeed Systems', 'Software Engineer (AI Native)', '2026-05-21', 'TJ_LS', 'https://x.test/2', 'Submitted - Waiting'),
  ];
  const trackerRows = [
    // Overlap: tracker says Rejected, and its Date is the EVALUATION date.
    { num: 94, company: 'Lightspeed Systems', role: 'Software Engineer (AI Native)', date: '2026-08-05', status: 'Rejected' },
    // Tracker-only, applied-or-later.
    { num: 114, company: 'LangChain', role: 'Fullstack Software Engineer, Applied AI', date: '2026-08-24', status: 'Applied' },
    // Never synced: an evaluation is not an application.
    { num: 120, company: 'Perplexity', role: 'MTS Security', date: '2026-08-28', status: 'Evaluated' },
    { num: 116, company: 'DeepL', role: 'Developer Growth', date: '2026-08-24', status: 'SKIP' },
  ];
  const facts = (t) => t.num === 114
    ? { applyDate: '2026-08-22', resume: 'cv-taher-jamali-langchain-applied-ai', url: 'https://x.test/lc', referral: false }
    : noFacts();

  const { rows, stats, skipped } = buildDesiredRows({
    sheetRows, trackerRows, facts, statusMap: STATUS_MAP, locationDefault: LOC, year: 2026,
  });

  ok('Evaluated and SKIP rows never reach the sheet', rows.length === 3 && stats.added === 1);
  ok('a sheet-only row survives verbatim', rows[0][0] === 'Datasent' && rows[0][2] === '2026-01-20');
  ok('on an overlap career-ops wins Response', rows[1][7] === 'Rejected');
  ok('on an overlap the SHEET keeps its apply date (not the evaluation date)', rows[1][2] === '2026-05-21');
  ok('overlap counted as an update, not an insert', stats.updated === 1 && stats.added === 1);
  ok('a tracker-only row uses the status-log apply date', rows[2][2] === '2026-08-22');
  ok('a tracker-only row carries resume, link and default location',
    rows[2][3] === 'cv-taher-jamali-langchain-applied-ai'
    && rows[2][4] === '=HYPERLINK("https://x.test/lc","Link")'
    && rows[2][5] === LOC && rows[2][6] === 'No');
  ok('an existing row keeps a clickable link (hyperlink is not flattened to "Link")',
    rows[0][4] === '=HYPERLINK("https://x.test/1","Link")');
  ok('rows come out in date order', rows.map(r => r[2]).join() === '2026-01-20,2026-05-21,2026-08-22');
  ok('nothing was skipped', skipped.length === 0);
}

console.log('\nsheets reconciler — guards');
{
  const trackerRows = [{ num: 1, company: 'Anthropic', role: 'AppSec', date: '2025-11-02', status: 'Rejected' }];
  const { rows, skipped } = buildDesiredRows({
    sheetRows: [], trackerRows, facts: noFacts, statusMap: STATUS_MAP, locationDefault: LOC, year: 2026,
  });
  ok('a row dated outside the tab year is skipped, not misfiled',
    rows.length === 0 && skipped.length === 1 && /outside 2026/.test(skipped[0].reason));
}
{
  const trackerRows = [{ num: 2, company: 'Acme', role: 'Eng', date: '2026-02-02', status: 'Discarded' }];
  const { rows } = buildDesiredRows({
    sheetRows: [], trackerRows, facts: noFacts, statusMap: STATUS_MAP, locationDefault: LOC, year: 2026,
  });
  ok('Discarded has no dropdown value and is never written', rows.length === 0);
  ok('SYNCED_STATES excludes Discarded/Evaluated/SKIP',
    !SYNCED_STATES.has('Discarded') && !SYNCED_STATES.has('Evaluated') && !SYNCED_STATES.has('SKIP'));
}
{
  const trackerRows = [{ num: 3, company: 'Acme', role: 'Eng', date: '', status: 'Applied' }];
  const { rows } = buildDesiredRows({
    sheetRows: [sheetRow(2, 'Zed', 'Dev', '2026-03-01', 'r', 'https://x.test/z', 'Rejected')],
    trackerRows, facts: noFacts, statusMap: STATUS_MAP, locationDefault: LOC, year: null,
  });
  ok('an undated row sorts last instead of jumping to the top', rows[rows.length - 1][0] === 'Acme');
}

console.log('\nsheets reconciler — write planning (A:H only)');
{
  const rows = [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['i', 'j', 'k', 'l', 'm', 'n', 'o', 'p']];
  const plan = planWrites({ rows, previousLastRow: 25, tab: 'Apply 2026' });
  ok('write range starts at row 2 and stops at column H', plan.update.range === 'A2:H3');
  ok('a shrunk set clears only the tail, still within A:H', plan.clear === 'A4:H25');
  ok('the plan never mentions column I or J', !/[IJ]\d/.test(`${plan.update.range} ${plan.clear}`));
  const grown = planWrites({ rows, previousLastRow: 2, tab: 'Apply 2026' });
  ok('a grown set clears nothing', grown.clear === null);
  const empty = planWrites({ rows: [], previousLastRow: 25, tab: 'Apply 2026' });
  ok('an empty set plans no update and clears the old body', empty.update === null && empty.clear === 'A2:H25');
}

console.log('\nsheets reconciler — journal cursor');
{
  const journal = [
    '93\t2026-08-03\tEvaluated\tApplied\tset-status\t',
    '94\t2026-08-05\tEvaluated\tResponded\tset-status\t',
    '82\t2026-08-18\tApplied\tRejected\tset-status\t',
  ].join('\n');
  const first = pendingFromJournal(journal, 0);
  ok('a cold cursor picks up every journal line', first.nums.size === 3 && first.cursor === 3);
  const second = pendingFromJournal(journal, 3);
  ok('a caught-up cursor yields nothing', second.nums.size === 0 && second.cursor === 3);
  const partial = pendingFromJournal(journal, 2);
  ok('a partial cursor yields only the new lines', partial.nums.size === 1 && partial.nums.has(82));
  ok('an empty journal is safe', pendingFromJournal('', 0).cursor === 0);
}
