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

/**
 * Parse a report's Machine Summary.
 *
 * @param {string} text  full report markdown
 * @returns {Record<string, any>|null}  null when there is no fence, or its body
 *   is not a YAML mapping
 */
export function readMachineSummary(text) {
  const fence = String(text ?? '').match(MACHINE_SUMMARY_RE);
  if (!fence) return null;
  try {
    // json: a duplicated key overrides instead of throwing. Hand-merged reports
    // carry them (report 177 repeats top_strengths), and one bad key must not
    // hide every other field in the fence.
    const doc = yaml.load(fence[1], { json: true });
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

// ── job location ─────────────────────────────────────────────────────

export const WORK_MODES = ['remote', 'remote_flex', 'hybrid', 'onsite'];

/** Work modes with no attendance requirement — the only ones allowed a null job_location. */
const REMOTE_MODES = new Set(['remote', 'remote_flex']);

/** "City, ST" (US) or a bare city (elsewhere). Rejects "Austin, Texas" and "Berlin, Germany". */
const LOCATION_SHAPE_RE = /^[^,]+(?:, [A-Z]{2})?$/;

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
  if (!LOCATION_SHAPE_RE.test(location)) {
    return { state: 'invalid', reason: `job_location "${location}" is not "City, ST" or a bare city` };
  }
  return { state: 'ok', reason: null };
}

/**
 * The Google Sheet's column F value.
 *
 * Remote roles read "Remote" (the sheet counts them with COUNTIF(F:F,"Remote"));
 * everything else is the job's "City, ST", which the "* TX" counters read.
 *
 * @param {Record<string, any>|null} summary
 * @returns {string|null}  null when the location is unknown
 */
export function sheetLocation(summary) {
  const { workMode, location } = jobLocation(summary);
  if (workMode && REMOTE_MODES.has(workMode)) return 'Remote';
  return location;
}
