/**
 * pdf-paths.mjs — deterministic scratch + final paths for a web "pdf" run (#2172).
 *
 * Plain .mjs (same pattern as clean-chips.mjs / tracker-table.mjs) so this can
 * be unit-tested with `node --test`, no TypeScript build step. `careerOpsRoot`
 * and `findReportFile` are passed in rather than imported from career-ops.ts,
 * keeping this module free of TypeScript dependencies.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Lowercase, non-alphanumeric runs -> single hyphen, trimmed.
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * @typedef {Object} PdfPaths
 * @property {string} html - Backend-dictated path the agent must write the tailored HTML to.
 * @property {string} meta - Backend-dictated path the agent must write the {"format": ...} sidecar to.
 * @property {string} finalPdf - Where the backend renders the final PDF (output/cv-{company-slug}-{NNN}.pdf).
 */

/**
 * Precompute the scratch (HTML + format sidecar) and final PDF paths for a
 * "pdf" run, so the agent never chooses its own filenames — the backend owns
 * naming, and later, rendering. Resolves the report for the company slug and
 * the report number — cv-{company-slug}-{NNN}.pdf, the naming convention
 * modes/pdf.md documents, so web and CLI output stay byte-identical. The report
 * number keeps two roles at one company apart; no candidate name or date
 * (plans/10-07-26_report-number-as-id.md).
 *
 * Framework-agnostic: returns a result instead of constructing a Response, so
 * the caller (a Next.js route today) decides how to surface `ok: false`.
 *
 * Side effect: creates `.career-ops-web/pdf-tmp/` under `root` if it doesn't
 * exist yet (the agent needs it to exist before it can write there) — this is
 * NOT a pure path computation, despite the name.
 *
 * @param {string} input - The report number (e.g. "018").
 * @param {string} root - careerOpsRoot().
 * @param {(input: string) => string | null} findReportFile - career-ops.ts's findReportFile.
 * @returns {{ok: true, paths: PdfPaths} | {ok: false, error: string}}
 */
export function resolvePdfPaths(input, root, findReportFile) {
  // Reject anything but a bare report number before it ever reaches a path.
  // findReportFile()'s parseInt-based matching can still resolve a crafted
  // selector like "123/../../etc/passwd" to a legitimate report file, but the
  // raw string is also used verbatim below to build cv-web-${input}.html —
  // path.join would then honor those ".." segments and escape scratchDir.
  if (!/^\d+$/.test(input)) {
    return { ok: false, error: `Invalid report selector: "${input}"` };
  }
  const reportFile = findReportFile(input);
  if (!reportFile) {
    return { ok: false, error: `No report #${input} found — evaluate this posting first.` };
  }
  // The report filename carries both halves of the name, the number already
  // zero-padded the way every other artifact spells it (reports/018-acme-….md).
  const reportMatch = path.basename(reportFile).match(/^(\d+)-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  const reportNum = reportMatch ? reportMatch[1] : input;
  const companySlug = reportMatch ? reportMatch[2] : "company";
  const scratchDir = path.join(root, ".career-ops-web", "pdf-tmp");
  fs.mkdirSync(scratchDir, { recursive: true });
  return {
    ok: true,
    paths: {
      html: path.join(scratchDir, `cv-web-${input}.html`),
      meta: path.join(scratchDir, `cv-web-${input}.meta.json`),
      finalPdf: path.join(root, "output", `cv-${companySlug}-${reportNum}.pdf`),
    },
  };
}
