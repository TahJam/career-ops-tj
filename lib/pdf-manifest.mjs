/**
 * pdf-manifest.mjs — the one writer of data/pdf-index.tsv.
 *
 * data/pdf-index.tsv maps a report number to the PDF generated for it. Every
 * reader (find.mjs, export-cv.mjs, outcome.mjs, sync-pdf-flags.mjs, the Go
 * dashboard, the sheets plugin) trusts it, so every generator records through
 * these functions instead of writing its own rows.
 *
 * Kept out of generate-pdf.mjs so a generator can record a PDF without
 * importing Playwright (plans/10-07-26_report-number-as-id.md).
 */

import { resolve, dirname, relative, sep, isAbsolute } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

// The career-ops root: manifest paths are relative to it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Convert a path to a repo-relative manifest entry, or blank if it is unknown
 * or outside the career-ops repository.
 *
 * @param {string} pathValue - Absolute or cwd-relative filesystem path.
 * @returns {string} Repo-relative path using forward slashes, or an empty string.
 */
export function repoRelativeManifestPath(pathValue) {
  if (!pathValue) return '';
  const rel = relative(ROOT, resolve(pathValue));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return '';
  return rel.split(sep).join('/');
}

/**
 * Decide which data/pdf-index.tsv rows survive when a new PDF is recorded.
 *
 * Pure so the collision rules are testable without touching the real
 * manifest. Returns the surviving rows plus the incoming one, and any
 * path collisions worth warning about.
 *
 * Two rows are dropped: one whose PDF path matches the incoming path (a
 * regenerated CV supersedes its own stale row), and one carrying the same
 * report number (that report's previous PDF is superseded).
 *
 * The one-row-per-path rule assumes a PDF path belongs to a single report,
 * which holds only while CV filenames carry their report number. If two
 * reports ever write the same path again, dropping the other report's row
 * would be silent data loss -- the tracker keeps its PDF checkmark while
 * every lookup (find.mjs, outcome.mjs, sync-pdf-flags.mjs, the dashboard)
 * reports "no PDF". Those cases come back in `collisions` so the caller can
 * say so out loud.
 *
 * @param {string} existingText - Current manifest contents ('' when absent).
 * @param {{reportNum?: string, relPDF: string, relHTML: string, format: string, date: string}} entry
 * @returns {{lines: string[], collisions: Array<{path: string, previousReport: string, incomingReport: string}>}}
 */
export function reconcilePDFManifest(existingText, entry) {
  const { reportNum = '', relPDF, relHTML, format, date } = entry;
  // "008" and "8" are the same report -- zero-padded report-link form vs
  // unpadded tracker-# form. Normalize so replacement rows match.
  const normKey = (s) => (s || '').trim().replace(/^0+(?=\d)/, '');
  const collisions = [];

  const lines = String(existingText || '').split('\n').filter((line) => {
    if (!line.trim() || line.startsWith('#')) return false;
    const fields = line.split('\t');
    if (fields[1] === relPDF) {
      // Same path, different report: the CVs collided on disk, so the PDF
      // this row points at was overwritten before we ever got here.
      if (reportNum && fields[0] && normKey(fields[0]) !== normKey(reportNum)) {
        collisions.push({
          path: relPDF,
          previousReport: fields[0].trim(),
          incomingReport: String(reportNum).trim(),
        });
      }
      return false;
    }
    if (reportNum && normKey(fields[0]) === normKey(reportNum)) return false;
    return true;
  });

  lines.push([reportNum || '', relPDF, relHTML, format, date].join('\t'));
  return { lines, collisions };
}

/**
 * Record a generated PDF in data/pdf-index.tsv so tools can map a tracker
 * report number to the exact PDF (and its source HTML for regeneration).
 *
 * Columns: report \t pdf \t html \t format \t date -- paths relative to the
 * career-ops root with forward slashes. See reconcilePDFManifest above for
 * the row-replacement rules. The file is gitignored: it references
 * gitignored output/ artifacts and is meaningless on another machine.
 */
export function updatePDFManifest(reportNum, pdfPath, htmlPath, format) {
  const manifestPath = resolve(ROOT, 'data', 'pdf-index.tsv');
  const toRel = (p) => relative(ROOT, resolve(p)).split(sep).join('/');
  const relPDF = toRel(pdfPath);
  const relHTML = repoRelativeManifestPath(htmlPath);
  const date = new Date().toISOString().slice(0, 10);

  const existing = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8') : '';
  const { lines, collisions } = reconcilePDFManifest(existing, {
    reportNum, relPDF, relHTML, format, date,
  });

  for (const c of collisions) {
    console.warn(
      `\n⚠️  PDF path collision: ${c.path}\n` +
      `   was indexed for report ${c.previousReport}, now claimed by report ${c.incomingReport}.\n` +
      `   Report ${c.previousReport}'s tailored CV was overwritten on disk and its manifest\n` +
      `   row is being dropped. Give each report its own filename\n` +
      `   (output/cv-{candidate}-{company}-{NNN}...) and regenerate both.\n`
    );
  }

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    '# report\tpdf\thtml\tformat\tdate — written by generate-pdf.mjs, do not edit\n' +
      lines.join('\n') + '\n'
  );
  return relPDF;
}
