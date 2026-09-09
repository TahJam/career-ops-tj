// @ts-check
// Local career-ops facts the export snapshot does not carry.
//
// plugins.mjs hands the export hook only { applications, pipeline } parsed from
// the markdown tables. Four of the sheet's eight columns need more than that, so
// this module reads them directly. That is ordinary for a bundled plugin:
// gmail/index.mjs, apify/index.mjs and notion/_notion.mjs all read files too —
// the "no file handle" note in _types.js describes what the engine HANDS a hook,
// not a prohibition.
//
// Everything here fails soft. A missing optional file degrades one cell, never
// the run.

import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (rel) => {
  const abs = path.join(ROOT, rel);
  try { return existsSync(abs) ? readFileSync(abs, 'utf8') : null; } catch { return null; }
};

/**
 * Apply dates from the status-log transition ledger: the date a row first
 * entered a state the sheet considers "applied".
 *
 * This is more accurate than the tracker's Date column, which is the EVALUATION
 * date. Proven by report #94: tracker 2026-08-05, sheet 05/21/2026.
 *
 * @returns {Map<number, string>} tracker row number -> YYYY-MM-DD
 */
export function applyDates() {
  const text = read('data/status-log.tsv');
  const out = new Map();
  if (!text) return out;
  for (const line of text.split('\n')) {
    const [num, date, , newStatus] = line.split('\t');
    if (!/^\d+$/.test(num ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) continue;
    if (newStatus !== 'Applied') continue;
    const n = parseInt(num, 10);
    // Earliest transition into Applied wins; a re-application must not move the
    // original apply date forward.
    if (!out.has(n) || date < out.get(n)) out.set(n, date);
  }
  return out;
}

/**
 * Résumé names from the PDF index: report number -> PDF basename without the
 * extension, e.g. "cv-taher-jamali-langchain-applied-ai".
 * @returns {Map<number, string>}
 */
export function resumeNames() {
  const text = read('data/pdf-index.tsv');
  const out = new Map();
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const [report, pdf] = line.split('\t');
    if (!/^\d+$/.test(report ?? '') || !pdf) continue;
    out.set(parseInt(report, 10), path.basename(pdf.trim()).replace(/\.pdf$/i, ''));
  }
  return out;
}

/**
 * Report IDs referenced by a tracker Report cell, e.g. "[123](../reports/123-x-2026-08-28.md)".
 *
 * Only the markdown label and the reports/ filename prefix are read. A naive
 * \\b\\d+\\b sweep also matches the date in the filename, which would make
 * "[123](../reports/123-perplexity-2026-08-28.md)" resolve to report 2026.
 */
export function reportNumsFromCell(cell) {
  const text = String(cell ?? '');
  const out = [];
  const add = (raw) => {
    const n = parseInt(raw, 10);
    if (n > 0 && !out.includes(n)) out.push(n);
  };
  for (const m of text.matchAll(/\[(\d{1,4})\]/g)) add(m[1]);
  for (const m of text.matchAll(/reports\/(\d{1,4})-/g)) add(m[1]);
  return out;
}

const reportCache = new Map();
let reportListing = null;

/** Report filenames, listed once per process. */
function listReports() {
  if (reportListing) return reportListing;
  const dir = path.join(ROOT, 'reports');
  try { reportListing = readdirSync(dir).filter(f => f.endsWith('.md')); }
  catch { reportListing = []; }
  return reportListing;
}

/**
 * Header + Machine Summary facts for one report number.
 *
 * Filenames are {###}-{slug}-{date}.md, but older rows use an unpadded number,
 * so both spellings are accepted.
 *
 * @param {number} num
 * @returns {{ url: string|null, pdf: string|null, via: string|null }}
 */
export function reportFacts(num) {
  const cached = reportCache.get(num);
  if (cached) return cached;

  const facts = { url: null, pdf: null, via: null };
  const padded = String(num).padStart(3, '0');
  const name = listReports().find(f => f.startsWith(`${padded}-`) || f.startsWith(`${num}-`));

  if (name) {
    let text = '';
    try { text = readFileSync(path.join(ROOT, 'reports', name), 'utf8'); } catch { text = ''; }
    const url = /^\*\*URL:\*\*\s*(\S+)\s*$/m.exec(text);
    const pdf = /^\*\*PDF:\*\*\s*(\S+)\s*$/m.exec(text);
    const via = /^via:\s*(.+)$/m.exec(text);
    if (url && /^https?:\/\//i.test(url[1])) facts.url = url[1];
    if (pdf) facts.pdf = path.basename(pdf[1]).replace(/\.pdf$/i, '');
    if (via) {
      const v = via[1].trim().replace(/^["']|["']$/g, '');
      if (v && !['null', '—', '-', ''].includes(v)) facts.via = v;
    }
  }
  reportCache.set(num, facts);
  return facts;
}

/**
 * The candidate's base location — column F, which the sheet's
 * COUNTIF(F:F,"* TX") formulas read, so the "City, ST" shape matters.
 *
 * config/profile.yml carries this as candidate.location ("Austin, TX"). The
 * separate top-level `location:` block holds city/country/timezone and has no
 * state field, so it is only a last resort.
 */
export function profileLocation(fallback = '') {
  const text = read('config/profile.yml');
  if (!text) return fallback;
  try {
    const doc = yaml.load(text);
    return doc?.candidate?.location || doc?.profile?.location || doc?.location?.city || fallback;
  } catch { return fallback; }
}

/** Test seam: forget cached report lookups. */
export function _clearCaches() { reportCache.clear(); reportListing = null; }
