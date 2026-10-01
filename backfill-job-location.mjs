#!/usr/bin/env node
// backfill-job-location.mjs — ONE-TIME: add work_mode / job_location to
// reports written before those Machine Summary keys existed.
//
// See plans/10-01-26_fix-sheets-job-location.md, Step 6. This script is
// deleted once the backfill has run; it is not a permanent code path.
//
//   node backfill-job-location.mjs            propose → data/job-location-backfill.tsv
//   node backfill-job-location.mjs --apply    write the reviewed TSV into reports/
//
// Propose is read-only. Every proposal carries a confidence:
//   high    the Block A location row is unambiguous and agrees with the Notes
//   review  anything else; resolve it by hand (set the value, and set
//           confidence to "resolved") before --apply will run
//
// --apply refuses to write anything while a row is still "review" or breaks
// the schema rule (lib/report-summary.mjs checkJobLocation). It inserts the
// two keys after `advertised_comp` inside the fence and touches nothing else.
// Re-running it skips reports that already have the keys.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readMachineSummary, checkJobLocation, MACHINE_SUMMARY_RE } from './lib/report-summary.mjs';
import { parseTrackerRow, resolveColumns, extractTrackerReportNumbers } from './tracker-parse.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(ROOT, 'reports');
const TSV = join(ROOT, 'data', 'job-location-backfill.tsv');
const COLUMNS = ['report', 'file', 'status', 'company', 'role', 'work_mode', 'job_location', 'confidence', 'block_a', 'notes'];

// ── location vocabulary ──────────────────────────────────────────────
// The candidate's base wins on a multi-location posting (batch-prompt rule).
const BASE = 'Austin, TX';

const STATES = {
  alabama: 'AL', arizona: 'AZ', california: 'CA', colorado: 'CO', connecticut: 'CT', florida: 'FL',
  georgia: 'GA', illinois: 'IL', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  'new jersey': 'NJ', 'new york': 'NY', 'north carolina': 'NC', ohio: 'OH', oregon: 'OR',
  pennsylvania: 'PA', tennessee: 'TN', texas: 'TX', utah: 'UT', virginia: 'VA', washington: 'WA',
};
const STATE_CODES = new Set(Object.values(STATES).concat(['DC']));

// Bare city names (and shorthands) the reports use without a state.
const CITIES = [
  ['new york city', 'New York, NY'], ['nyc', 'New York, NY'], ['new york', 'New York, NY'],
  ['san francisco bay area', 'San Francisco, CA'], ['sf bay area', 'San Francisco, CA'], ['bay area', 'San Francisco, CA'],
  ['san francisco', 'San Francisco, CA'], ['sf', 'San Francisco, CA'],
  ['palo alto', 'Palo Alto, CA'], ['menlo park', 'Menlo Park, CA'], ['mountain view', 'Mountain View, CA'],
  ['sunnyvale', 'Sunnyvale, CA'], ['santa clara', 'Santa Clara, CA'], ['san jose', 'San Jose, CA'],
  ['los angeles', 'Los Angeles, CA'], ['san diego', 'San Diego, CA'], ['seattle', 'Seattle, WA'],
  ['bellevue', 'Bellevue, WA'], ['austin', 'Austin, TX'], ['dallas', 'Dallas, TX'], ['houston', 'Houston, TX'],
  ['atlanta', 'Atlanta, GA'], ['boston', 'Boston, MA'], ['chicago', 'Chicago, IL'], ['denver', 'Denver, CO'],
  ['boulder', 'Boulder, CO'], ['washington, dc', 'Washington, DC'], ['charlotte', 'Charlotte, NC'],
  ['london', 'London'], ['berlin', 'Berlin'], ['dublin', 'Dublin'], ['toronto', 'Toronto'], ['paris', 'Paris'],
  ['amsterdam', 'Amsterdam'], ['madrid', 'Madrid'], ['barcelona', 'Barcelona'], ['lisbon', 'Lisbon'],
  ['bengaluru', 'Bengaluru'], ['bangalore', 'Bengaluru'], ['singapore', 'Singapore'], ['tel aviv', 'Tel Aviv'],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CITY_RE = new RegExp(`\\b(${CITIES.map(([k]) => esc(k)).join('|')})\\b`, 'gi');
const CITY_STATE_RE = /\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),? ([A-Z]{2})\b/g;
const CITY_STATENAME_RE = new RegExp(`\\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}), (${Object.keys(STATES).join('|')})\\b`, 'gi');

/** Every distinct normalized city in the text, in order of first mention. */
function citiesIn(text) {
  const found = [];
  const add = (index, value) => found.push({ index, value });
  for (const m of text.matchAll(CITY_STATE_RE)) if (STATE_CODES.has(m[2])) add(m.index, `${m[1]}, ${m[2]}`);
  for (const m of text.matchAll(CITY_STATENAME_RE)) add(m.index, `${m[1]}, ${STATES[m[2].toLowerCase()]}`);
  for (const m of text.matchAll(CITY_RE)) {
    // "SF" is only a city in caps; "sf" inside prose is noise.
    if (m[1].toLowerCase() === 'sf' && m[1] !== 'SF') continue;
    add(m.index, CITIES.find(([k]) => k === m[1].toLowerCase())[1]);
  }
  found.sort((a, b) => a.index - b.index);
  const out = [];
  for (const { value } of found) {
    // "New York City, NY" / "Austin, Texas" both collapse onto the lookup form.
    const canon = CITIES.find(([k]) => k === value.split(',')[0].toLowerCase())?.[1] ?? value;
    if (!out.includes(canon)) out.push(canon);
  }
  return out;
}

// ── work mode ────────────────────────────────────────────────────────
/** Every work mode the text signals. */
function modesIn(text) {
  const t = text.toLowerCase();
  const modes = new Set();
  const structured = /(?:workplacetype|location type)\W+(remote|hybrid|on-?site|in-?office)/.exec(t);
  if (structured) modes.add(structured[1].startsWith('remote') ? 'remote' : structured[1] === 'hybrid' ? 'hybrid' : 'onsite');
  if (/\bhybrid\b/.test(t)) modes.add('hybrid');
  if (/\b(on-?site|in-?office|in office|in-person|in person|office-based)\b/.test(t) && !/\bno (on-?site|in-?office)/.test(t)) modes.add('onsite');
  if (/\bremote\b/.test(t)) {
    if (/remote[- ](friendly|first)|\bflex|travel|anchor|optional office|site visits?/.test(t)) modes.add('remote_flex');
    else modes.add('remote');
  }
  return modes;
}

/** The headline mode: what the row says before its first qualifier. */
function headlineMode(text) {
  const head = text.split(/[—;(]| - | -- /)[0];
  const modes = modesIn(head);
  if (modes.size === 1) return [...modes][0];
  // "Full remote" / "Fully remote" headlines often trail into "anchor days" etc.
  if (/^\s*full(y)? remote/i.test(head)) return 'remote';
  return null;
}

const family = (m) => (m === 'remote' || m === 'remote_flex' ? 'remote' : m);

/** Propose work_mode / job_location for one report. */
function propose(blockA, notes) {
  const modes = modesIn(blockA);
  const head = headlineMode(blockA);
  let workMode = head ?? (modes.size === 1 ? [...modes][0] : '');
  // "Remote — 25% travel": the headline says remote, the qualifier makes it flex.
  if (workMode === 'remote' && modes.has('remote_flex')) workMode = 'remote_flex';
  const cities = citiesIn(blockA);
  const location = cities.includes(BASE) ? BASE : (cities[0] ?? '');

  const notesFamilies = new Set([...modesIn(notes)].map(family));
  const clear =
    workMode &&
    // The evaluator itself flagged doubt about the location.
    !/not stated|geo-?mismatch|geographically restricted|ambigu|verify/i.test(blockA) &&
    [...modes].every(m => family(m) === family(workMode)) &&
    (notesFamilies.size === 0 || (notesFamilies.size === 1 && notesFamilies.has(family(workMode)))) &&
    (family(workMode) === 'remote' ? cities.length === 0 : cities.length === 1);

  return {
    work_mode: workMode,
    job_location: family(workMode) === 'remote' && cities.length === 0 ? '' : location,
    confidence: clear ? 'high' : 'review',
  };
}

// ── inputs ───────────────────────────────────────────────────────────
function blockALocationRow(text) {
  const a = text.split(/^## A\)/m)[1]?.split(/^## B\)/m)[0] ?? '';
  const row = a.split('\n').find(l => /^\|\s*\**\s*(remote|location|work ?mode)/i.test(l));
  return row ? row.split('|').slice(2, -1).join('|').trim() : '';
}

function trackerByReport() {
  const path = join(ROOT, 'data', 'applications.md');
  const out = new Map();
  if (!existsSync(path)) return out;
  const lines = readFileSync(path, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    for (const n of extractTrackerReportNumbers(row.report)) out.set(n, row);
  }
  return out;
}

const cell = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();

// ── propose ──────────────────────────────────────────────────────────
function cmdPropose() {
  const tracker = trackerByReport();
  const rows = [];
  for (const file of readdirSync(REPORTS).filter(f => /^\d+-.+\.md$/.test(f)).sort()) {
    const text = readFileSync(join(REPORTS, file), 'utf-8');
    const summary = readMachineSummary(text);
    if (!summary || checkJobLocation(summary).state !== 'missing') continue;
    const num = parseInt(file, 10);
    const t = tracker.get(num);
    const blockA = blockALocationRow(text);
    const p = propose(blockA, t?.notes ?? '');
    rows.push({
      report: String(num).padStart(3, '0'), file, status: t?.status ?? '', company: summary.company ?? '',
      role: summary.role ?? '', ...p, block_a: blockA, notes: t?.notes ?? '',
    });
  }
  writeFileSync(TSV, [COLUMNS.join('\t'), ...rows.map(r => COLUMNS.map(c => cell(r[c])).join('\t'))].join('\n') + '\n');
  const high = rows.filter(r => r.confidence === 'high').length;
  console.log(`${rows.length} report(s) need keys → ${TSV.slice(ROOT.length + 1)}`);
  console.log(`  ${high} high confidence, ${rows.length - high} to review`);
}

// ── apply ────────────────────────────────────────────────────────────
function insertKeys(text, workMode, location) {
  const fence = text.match(MACHINE_SUMMARY_RE);
  const lines = fence[1].split('\n');
  const at = lines.findIndex(l => /^advertised_comp:/.test(l));
  if (at < 0) throw new Error('no advertised_comp line in the Machine Summary');
  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++; // block-scalar continuation
  lines.splice(end, 0, `work_mode: "${workMode}"`, `job_location: ${location ? JSON.stringify(location) : 'null'}`);
  const body = lines.join('\n');
  const start = fence.index + fence[0].indexOf(fence[1]);
  return text.slice(0, start) + body + text.slice(start + fence[1].length);
}

function cmdApply() {
  if (!existsSync(TSV)) { console.error(`no ${TSV.slice(ROOT.length + 1)} — run without --apply first`); process.exit(1); }
  const [header, ...body] = readFileSync(TSV, 'utf-8').split('\n').filter(Boolean);
  const cols = header.split('\t');
  const rows = body.map(l => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));

  const problems = [];
  for (const r of rows) {
    if (r.confidence === 'review') problems.push(`${r.report} ${r.company}: still marked review`);
    const { state, reason } = checkJobLocation({ work_mode: r.work_mode, job_location: r.job_location || null });
    if (state !== 'ok') problems.push(`${r.report} ${r.company}: ${reason}`);
  }
  if (problems.length) {
    console.error(`refusing to write — ${problems.length} row(s) need attention:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  let written = 0;
  for (const r of rows) {
    const path = join(REPORTS, r.file);
    const text = readFileSync(path, 'utf-8');
    if (checkJobLocation(readMachineSummary(text)).state !== 'missing') continue;
    const next = insertKeys(text, r.work_mode, r.job_location);
    const after = checkJobLocation(readMachineSummary(next));
    if (after.state !== 'ok') throw new Error(`${r.file}: write would not validate (${after.reason})`);
    writeFileSync(path, next);
    written++;
  }
  console.log(`wrote work_mode / job_location into ${written} report(s); ${rows.length - written} already had them`);
}

process.argv.includes('--apply') ? cmdApply() : cmdPropose();
