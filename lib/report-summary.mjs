// @ts-check
/**
 * Shared reader for a report's `## Machine Summary` YAML fence.
 *
 * Every script that needs a structured fact from a report reads it through
 * here, so the fence format and each field's rules live in one place. The
 * schema itself is defined in batch/batch-prompt.md ("Machine Summary").
 *
 * The Go dashboard cannot import this module; it re-implements the job-location
 * read in dashboard/internal/data. Both sides are pinned to the same cases in
 * tests/fixtures/report-location-cases.json, so a rule changed in one language
 * and not the other fails the suite.
 */

import yaml from 'js-yaml';

/** The fence, directly under its heading. Group 1 is the YAML body. */
export const MACHINE_SUMMARY_RE = /##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i;

/** js-yaml's core-schema null spellings. Anything else is a string. */
const NULL_SCALARS = new Set(['', '~', 'null', 'Null', 'NULL']);

/**
 * One top-level YAML scalar, read from the text after `key:`.
 *
 * This is the fallback reader for a fence js-yaml rejects, and the Go dashboard
 * (yamlScalar in dashboard/internal/data/derive.go) reads every fence this way,
 * so the two must apply the same rules: '' and \" escapes, a " #" comment
 * dropped from a bare value, the core-schema null spellings.
 *
 * @param {string} raw
 * @returns {string|null}  null for a null value or an unterminated quote
 */
export function yamlScalar(raw) {
  const v = raw.trim();
  if (v[0] === '"' || v[0] === "'") {
    const q = v[0];
    let out = '';
    for (let i = 1; i < v.length; i++) {
      const ch = v[i];
      if (q === "'" && ch === "'") {
        if (v[i + 1] === "'") { out += "'"; i++; continue; }
        return out;
      }
      if (q === '"' && ch === '\\' && (v[i + 1] === '"' || v[i + 1] === '\\')) { out += v[++i]; continue; }
      if (q === '"' && ch === '"') return out;
      out += ch;
    }
    return null;
  }
  const bare = v.replace(/\s#.*$/, '').trim();
  return NULL_SCALARS.has(bare) ? null : bare;
}

/** Top-level `key: scalar` lines; a repeated key overrides, as in js-yaml's json mode. */
function scanTopLevel(body) {
  const out = {};
  for (const m of body.matchAll(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/gm)) out[m[1]] = yamlScalar(m[2]);
  return out;
}

/**
 * Parse a report's Machine Summary, saying how well it went.
 *
 *   ok           the fence is a YAML mapping
 *   partial      js-yaml rejected the fence (e.g. an unquoted "a: b: c" line);
 *                its top-level scalars were recovered line by line, so one bad
 *                line does not hide every other field. Nested values are lost.
 *   unparseable  js-yaml rejected it and no top-level key could be recovered
 *   none         the report has no Machine Summary (e.g. a gate-skip note)
 *
 * `partial` and `unparseable` are evaluator errors; verify-pipeline reports them.
 *
 * @param {string} text  full report markdown
 * @returns {{ status: 'ok'|'partial'|'unparseable'|'none', summary: Record<string, any>|null, error: string|null }}
 */
export function parseMachineSummary(text) {
  const fence = String(text ?? '').match(MACHINE_SUMMARY_RE);
  if (!fence) return { status: 'none', summary: null, error: null };
  let error;
  try {
    // json: a duplicated key overrides instead of throwing. Hand-merged reports
    // carry them (report 177 repeats top_strengths).
    const doc = yaml.load(fence[1], { json: true });
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) return { status: 'ok', summary: doc, error: null };
    error = 'the fence is not a key: value mapping';
  } catch (e) {
    error = String(e?.reason ?? e?.message ?? e).split('\n')[0];
  }
  const scanned = scanTopLevel(fence[1]);
  return Object.keys(scanned).length
    ? { status: 'partial', summary: scanned, error }
    : { status: 'unparseable', summary: null, error };
}

/**
 * A report's Machine Summary, including fields recovered from a fence that
 * js-yaml rejected. Use parseMachineSummary() to find out whether it parsed.
 *
 * @param {string} text  full report markdown
 * @returns {Record<string, any>|null}  null when there is no fence or nothing
 *   could be read from it
 */
export function readMachineSummary(text) {
  return parseMachineSummary(text).summary;
}

// ── job location ─────────────────────────────────────────────────────

export const WORK_MODES = ['remote', 'remote_flex', 'hybrid', 'onsite'];

/** Work modes with no attendance requirement — the only ones allowed a null job_location. */
const REMOTE_MODES = new Set(['remote', 'remote_flex']);

/** The 50 states and DC. Mirrored by the Go reader; both are checked against the shared fixture. */
export const US_STATES = new Set([
  'AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS',
  'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV',
  'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
]);

/** Words that mean the evaluator wrote a placeholder or a work mode, not a place. */
const PLACEHOLDER_RE = /\b(remote|hybrid|on-?site|tbd|tba|n\/a|none|unknown|various|anywhere|multiple)\b/i;

/** A city name: letters, spaces and the punctuation real names use ("St. Louis", "O'Fallon"). */
const CITY_RE = /^\p{L}[\p{L}\p{M} .'’-]*$/u;

/**
 * Why a job_location is not a normalized place, or null when it is one.
 *
 * Accepts "City, ST" with a US state code, or a bare city outside the US. A US
 * code is all it can check: "Berlin, DE" passes, because DE is Delaware; the
 * schema writes non-US cities bare ("Berlin").
 */
function locationProblem(location) {
  if (PLACEHOLDER_RE.test(location)) return `job_location "${location}" is a placeholder, not a place`;
  let city = location;
  if (location.includes(',')) {
    const m = /^([^,]+), ([A-Z]{2})$/.exec(location);
    if (!m) return `job_location "${location}" is not "City, ST" or a bare city`;
    if (!US_STATES.has(m[2])) return `job_location "${location}": ${m[2]} is not a US state code (write a non-US city without a suffix)`;
    city = m[1];
  } else if (/\s[A-Z]{2}$/.test(location)) {
    return `job_location "${location}" is missing the comma in "City, ST"`;
  }
  return CITY_RE.test(city) ? null : `job_location "${location}" is not a city name`;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The job's work mode and location, as written by the evaluator.
 *
 * @param {Record<string, any>|null} summary  from readMachineSummary()
 * @returns {{ workMode: string|null, location: string|null }}  an unknown
 *   work_mode reads as null
 */
export function jobLocation(summary) {
  const mode = str(summary?.work_mode)?.toLowerCase() ?? null;
  return {
    workMode: mode && WORK_MODES.includes(mode) ? mode : null,
    location: str(summary?.job_location),
  };
}

/**
 * Validate the job-location keys against the schema rule: a hybrid or onsite
 * role must carry a normalized location.
 *
 * `missing` is reported separately from `invalid` because reports written
 * before the keys existed have neither, and that is a backfill gap rather than
 * an evaluator error.
 *
 * @param {Record<string, any>|null} summary
 * @returns {{ state: 'ok'|'missing'|'invalid', reason: string|null }}
 */
export function checkJobLocation(summary) {
  if (!summary || (!('work_mode' in summary) && !('job_location' in summary))) {
    return { state: 'missing', reason: 'no work_mode / job_location keys' };
  }
  const { workMode, location } = jobLocation(summary);
  if (!workMode) {
    return { state: 'invalid', reason: `work_mode must be one of ${WORK_MODES.join(' | ')} (got ${JSON.stringify(summary.work_mode ?? null)})` };
  }
  if (!location) {
    return REMOTE_MODES.has(workMode)
      ? { state: 'ok', reason: null }
      : { state: 'invalid', reason: `${workMode} role has no job_location` };
  }
  const problem = locationProblem(location);
  return problem ? { state: 'invalid', reason: problem } : { state: 'ok', reason: null };
}

/**
 * The Google Sheet's column F value.
 *
 * Remote roles read "Remote" (the sheet counts them with COUNTIF(F:F,"Remote"));
 * everything else is the job's "City, ST", which the "* TX" counters read.
 *
 * Only a report that passes checkJobLocation() yields a value. Anything else
 * returns null, which leaves the sheet's current cell alone: column F is owned
 * by career-ops, so a bad value would otherwise overwrite it on every sync. The
 * Go dashboard applies the same rule (applyReportLocation).
 *
 * @param {Record<string, any>|null} summary
 * @returns {string|null}  null when the location is unknown or invalid
 */
export function sheetLocation(summary) {
  if (checkJobLocation(summary).state !== 'ok') return null;
  const { workMode, location } = jobLocation(summary);
  return workMode && REMOTE_MODES.has(workMode) ? 'Remote' : location;
}
