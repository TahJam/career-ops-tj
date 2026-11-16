// tests/cover-letter-manifest.test.mjs — a cover letter gets its own
// data/pdf-index.tsv row instead of replacing the report's CV row (#6,
// plans/11-16-26_pdf-index-kind.md).
//
// renderHtmlToPdf runs in-process with a fake browser (its launchBrowser seam),
// so no Chromium starts; CAREER_OPS_PDF_INDEX keeps the live manifest untouched.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';
import { renderHtmlToPdf } from '../generate-pdf.mjs';
import { pdfPathsByReport } from '../lib/pdf-manifest.mjs';

console.log('\nrenderHtmlToPdf — records the PDF kind in pdf-index.tsv');

const onePagePdf = Buffer.from(`%PDF-1.7
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 1 /Kids [3 0 R] >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R >>
endobj
%%EOF`, 'latin1');

const fakeBrowser = async () => ({
  newPage: async () => ({
    goto: async () => {},
    evaluate: async () => {},
    pdf: async () => onePagePdf,
  }),
  close: async () => {},
});

mkdirSync(join(ROOT, 'output'), { recursive: true });
const sandbox = mkdtempSync(join(ROOT, 'output', 'cover-kind-test-'));
const index = join(sandbox, 'pdf-index.tsv');
const live = join(ROOT, 'data', 'pdf-index.tsv');
const liveBefore = existsSync(live) ? readFileSync(live, 'utf-8') : null;
const prev = process.env.CAREER_OPS_PDF_INDEX;
process.env.CAREER_OPS_PDF_INDEX = index;

// renderHtmlToPdf logs its progress; keep the suite output readable.
const { log } = console;
const quiet = (fn) => async (...a) => { console.log = () => {}; try { return await fn(...a); } finally { console.log = log; } };
const render = quiet(renderHtmlToPdf);

try {
  const html = '<html><head></head><body><p>x</p></body></html>';
  const common = { baseDir: sandbox, reportNum: '042', launchBrowser: fakeBrowser, styleTokens: {} };
  const cvPath = join(sandbox, 'cv-acme-042.pdf');
  const coverPath = join(sandbox, 'acme-staff-042-cover.pdf');

  // Given report 042's CV, when its cover letter is rendered with kind cover
  await render(html, cvPath, { ...common, format: 'letter' });
  await render(html, coverPath, { ...common, format: 'a4', kind: 'cover' });

  // Then both rows are in the index, each under its own kind
  const text = readFileSync(index, 'utf-8');
  const cv = pdfPathsByReport(text).get('42') || '';
  const cover = pdfPathsByReport(text, { kind: 'cover' }).get('42') || '';
  if (cv.endsWith('/cv-acme-042.pdf') && cover.endsWith('/acme-staff-042-cover.pdf')) {
    pass('a cover letter rendered with kind cover keeps the report\'s CV row');
  } else {
    fail(`index after CV + cover render: ${JSON.stringify(text)}`);
  }

  // When the CV is rendered again with no kind, it defaults to cv
  await render(html, cvPath, { ...common, format: 'letter' });
  const rows = readFileSync(index, 'utf-8').split('\n').filter(l => l && !l.startsWith('#'));
  if (rows.length === 2 && rows.filter(r => r.endsWith('\tcv')).length === 1 && rows.filter(r => r.endsWith('\tcover')).length === 1) {
    pass('renderHtmlToPdf defaults kind to cv and replaces only the CV row');
  } else {
    fail(`index after CV re-render: ${JSON.stringify(rows)}`);
  }

  const liveAfter = existsSync(live) ? readFileSync(live, 'utf-8') : null;
  if (liveAfter === liveBefore) pass('the live data/pdf-index.tsv is untouched');
  else fail('rendering under CAREER_OPS_PDF_INDEX changed the live data/pdf-index.tsv');
} catch (err) {
  fail(`renderHtmlToPdf threw: ${err.stack || err.message}`);
} finally {
  if (prev === undefined) delete process.env.CAREER_OPS_PDF_INDEX; else process.env.CAREER_OPS_PDF_INDEX = prev;
  rmSync(sandbox, { recursive: true, force: true });
}

// generate-cover-letter.mjs is a CLI that launches a real browser, so check
// the one line that matters at the source: it must record its PDF as a cover.
{
  const src = readFileSync(join(ROOT, 'generate-cover-letter.mjs'), 'utf-8');
  const call = src.slice(src.indexOf('await renderHtmlToPdf('));
  const opts = call.slice(0, call.indexOf('});') + 3);
  if (/\bkind:\s*["']cover["']/.test(opts)) {
    pass('generate-cover-letter.mjs records its PDF with kind cover');
  } else {
    fail('generate-cover-letter.mjs must pass kind: "cover" to renderHtmlToPdf');
  }
}
