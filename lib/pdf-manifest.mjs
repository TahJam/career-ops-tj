/**
 * pdf-manifest.mjs — the one writer and the shared reader of data/pdf-index.tsv.
 *
 * data/pdf-index.tsv maps a report number to the PDFs generated for it, one
 * row per (report, kind): its tailored CV (`cv`) and its cover letter
 * (`cover`). Every generator records through updatePDFManifest() instead of
 * writing its own rows: generate-pdf.mjs for HTML CVs, generate-latex.mjs for
 * LaTeX ones, mark-pdf-ready.mjs --pdf for Canva exports, and
 * generate-cover-letter.mjs for cover letters. Every JS reader (find.mjs,
 * export-cv.mjs, outcome.mjs, merge-tracker.mjs, sync-pdf-flags.mjs, the
 * sheets plugin) reads through pdfPathsByReport(); the Go dashboard mirrors
 * the parsing rules (dashboard/internal/data/pdf.go).
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

/** The kinds of PDF the manifest records. One row per (report, kind). */
export const PDF_KINDS = Object.freeze(['cv', 'cover']);

const MANIFEST_HEADER =
  '# report\tpdf\thtml\tformat\tdate\tkind — written by lib/pdf-manifest.mjs, do not edit';

const rowToLine = (r) => [r.report, r.pdf, r.html, r.format, r.date, r.kind].join('\t');

/**
 * Decide which data/pdf-index.tsv rows survive when a new PDF is recorded.
 *
 * Pure so the collision rules are testable without touching the real
 * manifest. Returns the surviving rows plus the incoming one, and any
 * path collisions worth warning about. Every returned line carries an
 * explicit kind -- rows written before the column existed get the inferred
 * one (inferPDFKind), so any write migrates the whole file.
 *
 * Two rows are dropped: one whose PDF path matches the incoming path (a
 * regenerated PDF supersedes its own stale row), and one carrying the same
 * report number AND the same kind (that report's previous CV, or previous
 * cover letter, is superseded). A report's CV and cover letter coexist.
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
 * @param {{reportNum?: string, relPDF: string, relHTML: string, format: string, date: string, kind?: string}} entry
 * @returns {{lines: string[], collisions: Array<{path: string, previousReport: string, incomingReport: string}>}}
 */
export function reconcilePDFManifest(existingText, entry) {
  const { reportNum = '', relPDF, relHTML, format, date, kind = 'cv' } = entry;
  if (!PDF_KINDS.includes(kind)) {
    throw new Error(`Unknown PDF kind "${kind}" -- expected one of: ${PDF_KINDS.join(', ')}`);
  }
  const incomingKey = normReportKey(reportNum);
  const collisions = [];

  const survivors = parsePDFManifest(existingText).filter((row) => {
    if (row.pdf === relPDF) {
      // Same path, different report: the PDFs collided on disk, so the file
      // this row points at was overwritten before we ever got here.
      if (incomingKey && row.report && normReportKey(row.report) !== incomingKey) {
        collisions.push({
          path: relPDF,
          previousReport: row.report,
          incomingReport: String(reportNum).trim(),
        });
      }
      return false;
    }
    if (incomingKey && normReportKey(row.report) === incomingKey && row.kind === kind) return false;
    return true;
  });

  const lines = survivors.map(rowToLine);
  lines.push(rowToLine({
    report: String(reportNum || '').trim(), pdf: relPDF, html: relHTML, format, date, kind,
  }));
  return { lines, collisions };
}

/**
 * Record a generated PDF in data/pdf-index.tsv so tools can map a tracker
 * report number to the exact PDF (and its source HTML for regeneration).
 *
 * Columns: report \t pdf \t html \t format \t date \t kind -- paths relative
 * to the career-ops root with forward slashes. `html` is the source the
 * dashboard's D key re-renders with generate-pdf.mjs (dashboard/main.go), so
 * it stays blank for a PDF that did not come from HTML. `kind` is `cv`
 * (default: generate-pdf.mjs, generate-latex.mjs, mark-pdf-ready.mjs --pdf) or
 * `cover` (generate-cover-letter.mjs). See reconcilePDFManifest above for the
 * row-replacement rules. The file is gitignored: it references gitignored
 * output/ artifacts and is meaningless on another machine.
 *
 * CAREER_OPS_PDF_INDEX overrides the manifest path, the same override its
 * readers (export-cv.mjs, sync-pdf-flags.mjs) honor, so a test can record a
 * PDF without touching the live data/pdf-index.tsv.
 *
 * @param {string} reportNum - Report number, or '' for a PDF with no report.
 * @param {string} pdfPath
 * @param {string} htmlPath - Source HTML, or '' when the PDF has none.
 * @param {string} format - 'letter' | 'a4' | ''.
 * @param {'cv'|'cover'} [kind='cv']
 * @returns {string} The repo-relative PDF path recorded.
 */
export function updatePDFManifest(reportNum, pdfPath, htmlPath, format, kind = 'cv') {
  const manifestPath = process.env.CAREER_OPS_PDF_INDEX || resolve(ROOT, 'data', 'pdf-index.tsv');
  const toRel = (p) => relative(ROOT, resolve(p)).split(sep).join('/');
  const relPDF = toRel(pdfPath);
  const relHTML = repoRelativeManifestPath(htmlPath);
  const date = new Date().toISOString().slice(0, 10);

  const existing = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8') : '';
  const { lines, collisions } = reconcilePDFManifest(existing, {
    reportNum, relPDF, relHTML, format, date, kind,
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
  writeFileSync(manifestPath, MANIFEST_HEADER + '\n' + lines.join('\n') + '\n');
  return relPDF;
}
