// tests/pdf-manifest.test.mjs — lib/pdf-manifest.mjs, the shared data/pdf-index.tsv writer.

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { updatePDFManifest } from '../lib/pdf-manifest.mjs';

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
