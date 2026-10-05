#!/usr/bin/env node

/**
 * export-cv.mjs — copy a report's tailored CV PDF to a fixed upload path.
 *
 * Tailored CVs land in output/ under report-specific names
 * (output/cv-{candidate}-{company}-{NNN}-{date}.pdf). Application forms want
 * one clean file name. This copies the PDF that data/pdf-index.tsv records for
 * a report to the path in config/profile.yml `cv.export_path`, or to a
 * `--out` override, and prints what it copied so it can be checked before
 * uploading. The source PDF is never modified.
 *
 * Usage:
 *   node export-cv.mjs <report#> [--out=<path>]
 *   npm run export-cv <report#> [-- --out=<path>]
 *
 * Path rules: `cv.export_path` resolves against the career-ops root, so it
 * means the same thing wherever the command runs. `--out` resolves against the
 * directory the command was typed in (INIT_CWD under `npm run export-cv`, else
 * cwd; an INIT_CWD inherited by a direct `node` run is ignored). An
 * existing destination file is replaced, and the output says so.
 *
 * Env overrides (tests): CAREER_OPS_PROFILE, CAREER_OPS_PDF_INDEX.
 *
 * Plan: plans/10-02-26_feat-pdf-copy.md
 */

import { readFileSync, existsSync, statSync, realpathSync, copyFileSync } from 'fs';
import { basename, dirname, extname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { parsePdfIndex, normNum } from './find.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const USAGE = 'Usage: node export-cv.mjs <report#> [--out=<path>]\n' +
  '       npm run export-cv <report#> [-- --out=<path>]';

/** A user-facing failure: the CLI prints the message and exits 1. */
export class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * Resolve which PDF to copy and where. Pure: no fs, no env.
 *
 * @param {object} args
 * @param {string} args.report - Report number as typed ("248", "0248").
 * @param {Map<string,string>} args.pdfIndex - From parsePdfIndex().
 * @param {string} [args.exportPath] - `cv.export_path` from the profile.
 * @param {string} [args.out] - `--out` override.
 * @param {string} args.root - career-ops root (base for index paths and export_path).
 * @param {string} args.cwd - Invoking directory (base for --out).
 * @returns {{reportNum: string, pdfPath: string, src: string, dest: string, destSource: 'profile'|'--out'}}
 */
export function resolveExport({ report, pdfIndex, exportPath, out, root, cwd }) {
  const raw = String(report ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new ExportError(`"${raw}" is not a report number. ${USAGE.split('\n')[0]}`);
  }
  const reportNum = normNum(raw);

  const pdfPath = pdfIndex.get(reportNum);
  if (!pdfPath) {
    throw new ExportError(
      `Report ${reportNum} has no PDF in data/pdf-index.tsv. ` +
      `Generate one with \`node generate-pdf.mjs <cv.html> <cv.pdf> --report=${reportNum}\` (the pdf mode passes it), ` +
      `or check the number with \`npm run find ${reportNum}\`.`);
  }
  // generate-cover-letter.mjs --report NNN writes a report-keyed row too, and the
  // manifest keeps one row per report, so the cover letter can replace the CV's
  // row. Cover letters are always named *-cover.pdf (generator default and
  // modes/cover.md), so match that suffix, not any "cover" in a company name.
  if (/-cover\.pdf$/i.test(basename(pdfPath))) {
    throw new ExportError(
      `Report ${reportNum}'s indexed PDF is a cover letter (${pdfPath}), not the CV. ` +
      `Generating the cover letter with --report replaced the CV's row in data/pdf-index.tsv. ` +
      `Regenerate the CV with \`node generate-pdf.mjs <cv.html> <cv.pdf> --report=${reportNum}\`, then export again.`);
  }

  let dest;
  let destSource;
  if (out) {
    dest = resolve(cwd, out);
    destSource = '--out';
  } else if (typeof exportPath === 'string' && exportPath.trim()) {
    dest = resolve(root, exportPath.trim());
    destSource = 'profile';
  } else {
    throw new ExportError(
      'No destination: set `cv.export_path` in config/profile.yml ' +
      '(e.g. export_path: "../Resume.pdf"), or pass `-- --out=<path>`.');
  }
  // An existing destination gets replaced, so a typo like export_path: "cv.md"
  // would overwrite a user-layer file with PDF bytes. Only write .pdf paths.
  if (extname(dest).toLowerCase() !== '.pdf') {
    throw new ExportError(
      `Destination ${dest} (from ${destSource === '--out' ? '--out' : 'cv.export_path'}) must be a .pdf file path.`);
  }

  return { reportNum, pdfPath, src: resolve(root, pdfPath), dest, destSource };
}

/**
 * Parse CLI args into { report, out, help }. Throws ExportError on bad input.
 *
 * @param {string[]} args - process.argv.slice(2).
 */
export function parseArgs(args) {
  const positional = [];
  let out;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') help = true;
    else if (a.startsWith('--out=')) out = a.slice('--out='.length);
    else if (a === '--out') out = args[++i] ?? '';
    else if (a.startsWith('-')) throw new ExportError(`Unknown option "${a}".\n${USAGE}`);
    else positional.push(a);
  }
  if (help) return { help };
  if (out !== undefined && !out.trim()) throw new ExportError(`--out needs a path.\n${USAGE}`);
  if (positional.length !== 1) throw new ExportError(USAGE);
  return { report: positional[0], out, help };
}

/**
 * Read `cv.export_path` from the profile. A missing profile means "not set".
 *
 * @param {string} profilePath
 * @returns {string|undefined}
 */
function readExportPath(profilePath) {
  if (!existsSync(profilePath)) return undefined;
  let doc;
  try {
    doc = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch (err) {
    throw new ExportError(`Could not parse ${profilePath}: ${err.message}`);
  }
  return doc?.cv?.export_path;
}

// The filesystem checks resolveExport can't make: the source must exist, and
// the destination must be a file path in an existing directory, not the source.
function checkPaths({ pdfPath, src, dest }) {
  if (!existsSync(src) || !statSync(src).isFile()) {
    throw new ExportError(
      `data/pdf-index.tsv points at ${pdfPath}, which is not on disk. Regenerate it with \`npm run pdf\`.`);
  }
  const parent = dirname(dest);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new ExportError(`Destination directory ${parent} does not exist.`);
  }
  if (existsSync(dest)) {
    if (statSync(dest).isDirectory()) {
      throw new ExportError(`Destination ${dest} is a directory; give a file path ending in .pdf.`);
    }
    if (realpathSync(dest) === realpathSync(src)) {
      throw new ExportError(`Destination ${dest} is the source PDF itself.`);
    }
  }
}

function main() {
  // INIT_CWD and npm_config_* are inherited by every child process, so trust
  // them only when npm is running this script, not a direct `node export-cv.mjs`
  // from a shell that some unrelated npm/npx process started elsewhere.
  const viaNpm = process.env.npm_lifecycle_event === 'export-cv';

  // `npm run export-cv 248 --out=x` (no `--`) hands --out to npm, which drops it
  // from argv and exposes it only as npm_config_out. Falling back to the profile
  // path would silently overwrite the wrong file, so refuse.
  if (viaNpm && process.env.npm_config_out) {
    throw new ExportError(
      `npm swallowed --out=${process.env.npm_config_out}: put \`--\` before it, ` +
      'e.g. `npm run export-cv 248 -- --out=<path>`. Nothing was copied.');
  }

  const { report, out, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }

  const indexPath = process.env.CAREER_OPS_PDF_INDEX || resolve(ROOT, 'data', 'pdf-index.tsv');
  const pdfIndex = existsSync(indexPath) ? parsePdfIndex(readFileSync(indexPath, 'utf-8')) : new Map();
  const profilePath = process.env.CAREER_OPS_PROFILE || resolve(ROOT, 'config', 'profile.yml');

  const plan = resolveExport({
    report,
    pdfIndex,
    exportPath: out ? undefined : readExportPath(profilePath),
    out,
    root: ROOT,
    cwd: (viaNpm && process.env.INIT_CWD) || process.cwd(),
  });
  checkPaths(plan);

  const replaced = existsSync(plan.dest);
  copyFileSync(plan.src, plan.dest);

  const kb = Math.round(statSync(plan.src).size / 1024);
  console.log(`Report ${plan.reportNum} → copied`);
  console.log(`  from: ${plan.pdfPath} (${kb} KB)`);
  console.log(`  to:   ${plan.dest}${replaced ? ' (replaced existing file)' : ''}` +
    `${plan.destSource === '--out' ? ' [--out]' : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (err) {
    if (!(err instanceof ExportError)) throw err;
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
