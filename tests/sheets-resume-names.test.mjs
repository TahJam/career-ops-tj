// tests/sheets-resume-names.test.mjs — the sheets plugin's résumé column comes
// from the report's CV row in data/pdf-index.tsv, never its cover letter (#6,
// plans/11-16-26_pdf-index-kind.md). CAREER_OPS_PDF_INDEX points resumeNames()
// at a fixture so the live index is never read.

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';
import { resumeNames } from '../plugins/sheets/_sources.mjs';

console.log('\nsheets plugin — résumé names from pdf-index.tsv');

const work = mkdtempSync(join(tmpdir(), 'cops-sheets-resume-'));
const index = join(work, 'pdf-index.tsv');
const prev = process.env.CAREER_OPS_PDF_INDEX;
process.env.CAREER_OPS_PDF_INDEX = index;
try {
  writeFileSync(index, [
    '# report\tpdf\thtml\tformat\tdate\tkind',
    // Report 94: CV, then its cover letter recorded after it.
    '094\toutput/cv-lightspeed-094.pdf\t\tletter\t2026-08-05\tcv',
    '094\toutput/lightspeed-systems-se-094-cover.pdf\t\tletter\t2026-08-06\tcover',
    // Report 95: a legacy row (no kind column) for a cover letter only.
    '095\toutput/initech-se-095-cover.pdf\t\tletter\t2026-08-06',
    // Report 96: a legacy CV row.
    '96\toutput/cv-hooli-096.pdf\toutput/cv-hooli-096.html\tletter\t2026-08-07',
    // Not a report number: skipped, as before.
    'abc\toutput/cv-junk.pdf\t\tletter\t2026-08-07',
    '',
  ].join('\n'));
  const names = resumeNames();
  if (
    names.get(94) === 'cv-lightspeed-094' &&
    !names.has(95) &&
    names.get(96) === 'cv-hooli-096' &&
    names.size === 2
  ) {
    pass('resumeNames() takes each report\'s CV row and ignores cover-letter rows');
  } else {
    fail(`resumeNames() returned ${JSON.stringify([...names])}`);
  }
} finally {
  if (prev === undefined) delete process.env.CAREER_OPS_PDF_INDEX; else process.env.CAREER_OPS_PDF_INDEX = prev;
  rmSync(work, { recursive: true, force: true });
}
