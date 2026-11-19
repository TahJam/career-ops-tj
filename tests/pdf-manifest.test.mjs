// tests/pdf-manifest.test.mjs — lib/pdf-manifest.mjs, the shared data/pdf-index.tsv writer.

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
  updatePDFManifest, reconcilePDFManifest, parsePDFManifest, pdfPathsByReport, inferPDFKind, normReportKey,
} from '../lib/pdf-manifest.mjs';

console.log('\nlib/pdf-manifest.mjs — pdf-index.tsv writer');

// CAREER_OPS_PDF_INDEX must redirect the write, or every test that records a
// PDF would rewrite the user's live data/pdf-index.tsv.
{
  const work = mkdtempSync(join(tmpdir(), 'cops-manifest-'));
  const index = join(work, 'pdf-index.tsv');
  const live = join(ROOT, 'data', 'pdf-index.tsv');
  const liveBefore = existsSync(live) ? readFileSync(live, 'utf-8') : null;
  const prev = process.env.CAREER_OPS_PDF_INDEX;
  process.env.CAREER_OPS_PDF_INDEX = index;
  try {
    const rel = updatePDFManifest('042', join(ROOT, 'output', 'cv-acme-042.pdf'), join(ROOT, 'output', 'cv-acme-042.html'), 'letter');
    const rows = readFileSync(index, 'utf-8').split('\n').filter(l => l && !l.startsWith('#'));
    if (rel === 'output/cv-acme-042.pdf' && rows.length === 1 && rows[0].startsWith('042\toutput/cv-acme-042.pdf\toutput/cv-acme-042.html\tletter\t')) {
      pass('updatePDFManifest writes to CAREER_OPS_PDF_INDEX with repo-relative paths');
    } else {
      fail(`updatePDFManifest wrote an unexpected row: ${JSON.stringify(rows)} (returned ${rel})`);
    }
    const liveAfter = existsSync(live) ? readFileSync(live, 'utf-8') : null;
    if (liveAfter === liveBefore) {
      pass('updatePDFManifest leaves the live data/pdf-index.tsv untouched under the override');
    } else {
      fail('updatePDFManifest changed the live data/pdf-index.tsv despite CAREER_OPS_PDF_INDEX');
    }
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_PDF_INDEX; else process.env.CAREER_OPS_PDF_INDEX = prev;
    rmSync(work, { recursive: true, force: true });
  }
}

console.log('\nlib/pdf-manifest.mjs — shared pdf-index.tsv parser');

// Only the -cover.pdf suffix marks a cover letter; "cover" elsewhere in a
// name (a company called Covera, a role about coverage) is still a CV.
{
  const cases = [
    ['output/acme-staff-eng-042-cover.pdf', 'cover'],
    ['output/ACME-COVER.PDF', 'cover'],
    ['output/cv-covera-health-042.pdf', 'cv'],
    ['output/cv-acme-cover-team-042.pdf', 'cv'],
    ['output/cover.pdf', 'cv'],
    ['', 'cv'],
  ];
  const wrong = cases.filter(([p, k]) => inferPDFKind(p) !== k);
  if (wrong.length === 0) pass('inferPDFKind reads only the -cover.pdf suffix as a cover letter');
  else fail(`inferPDFKind misread: ${JSON.stringify(wrong.map(([p]) => [p, inferPDFKind(p)]))}`);
}

{
  if (normReportKey('008') === '8' && normReportKey(' 8 ') === '8' && normReportKey('0') === '0'
      && normReportKey(null) === '' && normReportKey(42) === '42') {
    pass('normReportKey keys "008" and "8" identically and tolerates null/numbers');
  } else {
    fail('normReportKey normalization is wrong');
  }
}

{
  const text = [
    '# report\tpdf\thtml\tformat\tdate\tkind — header',
    '041\toutput/cv-acme-041.pdf\toutput/cv-acme-041.html\tletter\t2026-11-01',
    '042\toutput/cv-acme-042.pdf\t\tletter\t2026-11-02\tcv',
    '042\toutput/acme-staff-042-cover.pdf\t\ta4\t2026-11-03',
    '043\toutput/x-043.pdf\t\t\t2026-11-03\tCOVER',
    '044\toutput/x-044.pdf\t\t\t2026-11-03\tresume',
    '\toutput/cv-nobody.pdf\t\tletter\t2026-11-03',
    '045\t\t\tletter\t2026-11-03',
    '',
  ].join('\r\n');
  const rows = parsePDFManifest(text);
  const kinds = Object.fromEntries(rows.map(r => [r.pdf, r.kind]));
  if (
    rows.length === 6 &&
    kinds['output/cv-acme-041.pdf'] === 'cv' &&
    kinds['output/cv-acme-042.pdf'] === 'cv' &&
    kinds['output/acme-staff-042-cover.pdf'] === 'cover' &&
    kinds['output/x-043.pdf'] === 'cover' &&
    kinds['output/x-044.pdf'] === 'resume' &&
    rows[0].html === 'output/cv-acme-041.html' && rows[0].format === 'letter' && rows[0].date === '2026-11-01'
  ) {
    pass('parsePDFManifest reads 5- and 6-column rows, infers a missing kind, keeps a written one');
  } else {
    fail(`parsePDFManifest returned ${JSON.stringify(rows)}`);
  }

  const cv = pdfPathsByReport(text);
  const cover = pdfPathsByReport(text, { kind: 'cover' });
  if (
    cv.get('41') === 'output/cv-acme-041.pdf' &&
    cv.get('42') === 'output/cv-acme-042.pdf' &&
    !cv.has('43') && !cv.has('44') && !cv.has('') && cv.size === 2 &&
    cover.get('42') === 'output/acme-staff-042-cover.pdf' && cover.get('43') === 'output/x-043.pdf'
  ) {
    pass('pdfPathsByReport keeps the CV when a cover row follows it, and skips unknown kinds');
  } else {
    fail(`pdfPathsByReport returned cv=${JSON.stringify([...cv])} cover=${JSON.stringify([...cover])}`);
  }
}

{
  const text = '008\toutput/cv-a-old.pdf\t\tletter\t2026-01-01\n8\toutput/cv-a-new.pdf\t\tletter\t2026-02-01\n';
  const map = pdfPathsByReport(text);
  if (map.size === 1 && map.get('8') === 'output/cv-a-new.pdf') {
    pass('pdfPathsByReport normalizes zero-padding and lets the later row win');
  } else {
    fail(`pdfPathsByReport padding/order wrong: ${JSON.stringify([...map])}`);
  }
}

if (pdfPathsByReport('').size === 0 && pdfPathsByReport(undefined).size === 0 && parsePDFManifest(null).length === 0) {
  pass('the parser returns empty results for a missing manifest');
} else {
  fail('the parser must tolerate empty/undefined manifest text');
}

console.log('\nlib/pdf-manifest.mjs — one row per (report, kind)');

const entry = (over) => ({ reportNum: '042', relPDF: 'output/cv-acme-042.pdf', relHTML: '', format: 'letter', date: '2026-11-16', ...over });

// #6: generate-cover-letter.mjs --report 042 used to evict report 042's CV row.
{
  const cvFirst = '042\toutput/cv-acme-042.pdf\toutput/cv-acme-042.html\tletter\t2026-11-01\tcv\n';
  const { lines, collisions } = reconcilePDFManifest(cvFirst, entry({ relPDF: 'output/acme-staff-042-cover.pdf', kind: 'cover' }));
  const cv = pdfPathsByReport(lines.join('\n'));
  const cover = pdfPathsByReport(lines.join('\n'), { kind: 'cover' });
  if (lines.length === 2 && collisions.length === 0 && cv.get('42') === 'output/cv-acme-042.pdf' && cover.get('42') === 'output/acme-staff-042-cover.pdf') {
    pass('recording a cover letter keeps the same report\'s CV row');
  } else {
    fail(`cover letter evicted the CV row: ${JSON.stringify(lines)}`);
  }
}

// The reverse order, with a legacy (5-column) cover row the kind is inferred for.
{
  const legacyCover = '42\toutput/acme-staff-042-cover.pdf\t\ta4\t2026-11-01\n';
  const { lines } = reconcilePDFManifest(legacyCover, entry({}));
  if (lines.length === 2 && lines[0] === '42\toutput/acme-staff-042-cover.pdf\t\ta4\t2026-11-01\tcover' && lines[1].endsWith('\tcv')) {
    pass('recording a CV keeps a legacy cover row and writes its inferred kind');
  } else {
    fail(`CV after legacy cover row: ${JSON.stringify(lines)}`);
  }
}

// A new CV still supersedes the report's old CV, and only that row.
{
  const before =
    '042\toutput/cv-acme-042-old.pdf\t\tletter\t2026-11-01\tcv\n' +
    '042\toutput/acme-staff-042-cover.pdf\t\ta4\t2026-11-01\tcover\n' +
    '043\toutput/cv-beta-043.pdf\t\tletter\t2026-11-01\tcv\n';
  const { lines } = reconcilePDFManifest(before, entry({ reportNum: '42' }));
  const text = lines.join('\n');
  if (
    lines.length === 3 &&
    !text.includes('cv-acme-042-old.pdf') &&
    pdfPathsByReport(text).get('42') === 'output/cv-acme-042.pdf' &&
    pdfPathsByReport(text, { kind: 'cover' }).get('42') === 'output/acme-staff-042-cover.pdf' &&
    pdfPathsByReport(text).get('43') === 'output/cv-beta-043.pdf'
  ) {
    pass('a regenerated CV replaces only its report\'s CV row (zero-padding aside)');
  } else {
    fail(`CV supersede by (report, kind) wrong: ${JSON.stringify(lines)}`);
  }
}

// The writer migrates: every surviving legacy row comes back with a kind.
{
  const legacy =
    '# report\tpdf\thtml\tformat\tdate — written by lib/pdf-manifest.mjs, do not edit\n' +
    '001\toutput/cv-a-001.pdf\toutput/cv-a-001.html\tletter\t2026-07-09\n' +
    '094\toutput/x-ai-native-cover.pdf\t\tletter\t2026-08-05\n' +
    '\toutput/cv-orphan.pdf\t\tletter\t2026-08-05\n';
  const { lines } = reconcilePDFManifest(legacy, entry({}));
  const cols = lines.map(l => l.split('\t').length);
  if (
    cols.every(n => n === 6) &&
    lines[0] === '001\toutput/cv-a-001.pdf\toutput/cv-a-001.html\tletter\t2026-07-09\tcv' &&
    lines[1].endsWith('\tcover') &&
    lines[2] === '\toutput/cv-orphan.pdf\t\tletter\t2026-08-05\tcv'
  ) {
    pass('every rewrite migrates legacy rows to an explicit kind column');
  } else {
    fail(`legacy rows not migrated: ${JSON.stringify(lines)}`);
  }
}

// Same path is still one row whatever the kind, and a cross-report path collision still warns.
{
  const before = '041\toutput/shared-cover.pdf\t\ta4\t2026-11-01\tcover\n';
  const { lines, collisions } = reconcilePDFManifest(before, entry({ relPDF: 'output/shared-cover.pdf', kind: 'cover' }));
  if (lines.length === 1 && lines[0].startsWith('042\t') && collisions.length === 1 && collisions[0].previousReport === '041') {
    pass('a cross-report path collision still drops the old row and is reported');
  } else {
    fail(`path collision handling regressed: ${JSON.stringify({ lines, collisions })}`);
  }
}

{
  let threw = null;
  try { reconcilePDFManifest('', entry({ kind: 'resume' })); } catch (e) { threw = e; }
  if (threw && /Unknown PDF kind "resume"/.test(threw.message)) {
    pass('the writer rejects a kind other than cv or cover');
  } else {
    fail('the writer accepted an unknown kind');
  }
}

// End to end through the file: CV then cover letter for the same report.
{
  const work = mkdtempSync(join(tmpdir(), 'cops-manifest-kind-'));
  const index = join(work, 'pdf-index.tsv');
  const prev = process.env.CAREER_OPS_PDF_INDEX;
  process.env.CAREER_OPS_PDF_INDEX = index;
  try {
    updatePDFManifest('042', join(ROOT, 'output', 'cv-acme-042.pdf'), '', 'letter');
    updatePDFManifest('042', join(ROOT, 'output', 'acme-staff-042-cover.pdf'), '', 'a4', 'cover');
    const text = readFileSync(index, 'utf-8');
    if (
      text.startsWith('# report\tpdf\thtml\tformat\tdate\tkind') &&
      pdfPathsByReport(text).get('42') === 'output/cv-acme-042.pdf' &&
      pdfPathsByReport(text, { kind: 'cover' }).get('42') === 'output/acme-staff-042-cover.pdf'
    ) {
      pass('updatePDFManifest keeps a report\'s CV and cover letter side by side on disk');
    } else {
      fail(`manifest file after CV + cover: ${JSON.stringify(text)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_PDF_INDEX; else process.env.CAREER_OPS_PDF_INDEX = prev;
    rmSync(work, { recursive: true, force: true });
  }
}
