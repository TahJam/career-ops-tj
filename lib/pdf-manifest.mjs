/**
 * pdf-manifest.mjs — the one writer of data/pdf-index.tsv.
 *
 * data/pdf-index.tsv maps a report number to the PDF generated for it. Every
 * reader (find.mjs, export-cv.mjs, outcome.mjs, sync-pdf-flags.mjs, the Go
 * dashboard, the sheets plugin) trusts it, so every generator records through
 * these functions instead of writing its own rows: generate-pdf.mjs for HTML
 * CVs, generate-latex.mjs for LaTeX ones.
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
 * Normalize a report number so "008" and "8" key identically -- the
 * zero-padded report-link form vs the unpadded tracker-# form. find.mjs
 * re-exports this as normNum so tracker lookups and manifest keys share it.
 *
 * @param {unknown} s
 * @returns {string}
 */
export const normReportKey = (s) => String(s ?? '').trim().replace(/^0+(?=\d)/, '');

/**
 * Infer a row's kind from its PDF path when the kind column is missing
 * (rows written before the column existed). Cover letters are always named
 * *-cover.pdf (generate-cover-letter.mjs default and modes/cover.md); only
 * that suffix counts, so a company name containing "cover" stays a CV. The
 * Go dashboard mirrors this rule (dashboard/internal/data/pdf.go).
 *
 * @param {string} pdfPath
 * @returns {'cv'|'cover'}
 */
export function inferPDFKind(pdfPath) {
  const base = String(pdfPath ?? '').trim().split('/').pop();
  return /-cover\.pdf$/i.test(base) ? 'cover' : 'cv';
}

/**
 * Parse data/pdf-index.tsv into rows. Columns: report \t pdf \t html \t
 * format \t date \t kind. A blank or missing kind is inferred from the path
 * (inferPDFKind); a written one is lowercased and kept as is, so an unknown
 * value is simply not a `cv` row. Comment, blank, and pathless lines are
 * skipped.
 *
 * @param {string} text - Full manifest contents ('' when absent).
 * @returns {Array<{report: string, pdf: string, html: string, format: string, date: string, kind: string}>}
 */
export function parsePDFManifest(text) {
  const rows = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t').map((s) => s.trim());
    const pdf = f[1] || '';
    if (!pdf) continue;
    rows.push({
      report: f[0] || '',
      pdf,
      html: f[2] || '',
      format: f[3] || '',
      date: f[4] || '',
      kind: (f[5] || '').toLowerCase() || inferPDFKind(pdf),
    });
  }
  return rows;
}

/**
 * Map normalized report number -> PDF path for one kind of PDF. Rows with no
 * report number are skipped, and a later row wins over an earlier one for the
 * same report (the Go dashboard reader does the same). Every JS reader that
 * means "the report's CV" calls this with the default kind.
 *
 * @param {string} text - Full manifest contents.
 * @param {{kind?: string}} [opts]
 * @returns {Map<string, string>}
 */
export function pdfPathsByReport(text, { kind = 'cv' } = {}) {
  const map = new Map();
  for (const row of parsePDFManifest(text)) {
    if (!row.report || row.kind !== kind) continue;
    map.set(normReportKey(row.report), row.pdf);
  }
  return map;
}

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
  const normKey = normReportKey;
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
 * career-ops root with forward slashes. `html` is the source the dashboard's D
 * key re-renders with generate-pdf.mjs (dashboard/main.go), so it stays blank
 * for a PDF that did not come from HTML. See reconcilePDFManifest above for
 * the row-replacement rules. The file is gitignored: it references
 * gitignored output/ artifacts and is meaningless on another machine.
 *
 * CAREER_OPS_PDF_INDEX overrides the manifest path, the same override its
 * readers (export-cv.mjs, sync-pdf-flags.mjs) honor, so a test can record a
 * PDF without touching the live data/pdf-index.tsv.
 */
export function updatePDFManifest(reportNum, pdfPath, htmlPath, format) {
  const manifestPath = process.env.CAREER_OPS_PDF_INDEX || resolve(ROOT, 'data', 'pdf-index.tsv');
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
      `   (output/cv-{company-slug}-{NNN}.pdf) and regenerate both.\n`
    );
  }

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    '# report\tpdf\thtml\tformat\tdate — written by lib/pdf-manifest.mjs, do not edit\n' +
      lines.join('\n') + '\n'
  );
  return relPDF;
}
