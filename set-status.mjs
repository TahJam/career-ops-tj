#!/usr/bin/env node

/**
 * set-status.mjs — canonical CLI to update a tracker row's status/note (#1428).
 *
 * data/applications.md is a shared surface with multiple readers and writers.
 * One canonical write path is safer than N agents hand-editing markdown, so
 * modes (apply Step 9, followup, batch) call this instead of editing the table.
 *
 * Usage:
 *   node set-status.mjs <report#> <state> [--note "..."] [--on YYYY-MM-DD] [--dry-run] [--json]
 *
 * Row resolution: the one selector is the report number — the NNN in
 * reports/NNN-{slug}-{date}.md — resolved by find.mjs resolveReportNumber().
 * verify-pipeline.mjs Check 14 keeps every row's # equal to its report number,
 * so there is one number space and nothing to disambiguate. Company names are
 * refused, not matched: with 20 rows for one company a name is a search, and a
 * writer must never pick a row from a search. Look the number up with
 * `node find.mjs "<company>"` (plans/10-07-26_report-number-as-id.md).
 *
 * State validation is strict against templates/states.yml (labels, ids, and
 * aliases resolve to the canonical label; anything else is rejected before the
 * tracker is touched). --note appends to the Notes cell with "; " and is
 * idempotent — re-running the same command is always safe.
 *
 * The read-modify-write runs under the shared tracker lock (tracker-utils.mjs,
 * same lock as merge-tracker.mjs) and the file is replaced atomically. Only the
 * Status and Notes cells of the matched row change; every other byte of the
 * tracker round-trips untouched.
 *
 * Exit codes: 0 success (including no-op re-runs) · 1 usage error,
 * non-canonical state, unreadable states.yml, or non-retryable lock/write failure ·
 * 2 row not found or unreadable tracker · 3 two rows link the same report
 * (a tracker data bug verify-pipeline flags) · 4 tracker lock timeout (busy —
 * retry later).
 *
 * When the new status is Applied, the JSON output carries
 * `"followupSeedCandidate": true` — the hook point for seeding
 * data/follow-ups.md with the default cadence (#1430, not implemented here).
 *
 * Every real status change also appends one line to the transition ledger
 * (status-log.tsv, sibling of the tracker file):
 *   {#}\t{date}\t{from}\t{to}\tset-status\t   (# = the row's report number)
 * Date defaults to today; pass --on YYYY-MM-DD when the transition actually
 * happened earlier ("they replied Tuesday"). The append is observation-only:
 * if it fails, a warning goes to stderr and the exit code is unchanged — the
 * tracker remains the source of truth for state. Read by funnel-velocity.mjs.
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { resolveReportNumber } from './find.mjs';
import {
  rebuildRow, resolveTrackerPath, writeFileAtomic, loadCanonicalStates, resolveCanonicalState,
  cell, CLI_EXIT, makeCliFailWith, acquireTrackerLockForCli,
} from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const STATES_FILE = join(CAREER_OPS, 'templates/states.yml');

// LOCK_TIMEOUT is not destructured here — that exit path is raised inside
// acquireTrackerLockForCli() itself (tracker-utils.mjs), via CLI_EXIT.LOCK_TIMEOUT.
const { OK: EXIT_OK, USAGE: EXIT_USAGE, NOT_FOUND: EXIT_NOT_FOUND, AMBIGUOUS: EXIT_AMBIGUOUS } = CLI_EXIT;

const USAGE = `Usage: node set-status.mjs <report#> <state> [--note "..."] [--on YYYY-MM-DD] [--dry-run] [--json]

  <report#>          Report number (the NNN in reports/NNN-...md). Company names are not
                     accepted — find the number with: node find.mjs "<company>"
  <state>            Canonical state from templates/states.yml (aliases accepted)
  --note "..."       Append to the Notes cell ("; "-separated, idempotent)
  --on YYYY-MM-DD    Real event date for the status-log entry (defaults to today —
                     pass it when the transition happened earlier than it's recorded)
  --dry-run          Resolve and validate, but write nothing
  --json             Machine-readable output on stdout (errors included)`;

// ── argument parsing ─────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const positional = [];
const flags = { note: null, on: null, dryRun: false, json: false };
const VALUE_FLAGS = { '--note': 'note', '--on': 'on' };

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a in VALUE_FLAGS) {
    // Never consume a following flag as the value: "--note --dry-run" would
    // silently disable dry-run and turn a preview into a real write.
    const value = rawArgs[i + 1];
    if (value === undefined || value.startsWith('--')) {
      failUsage(`Missing value for ${a}`);
    }
    flags[VALUE_FLAGS[a]] = value;
    i++;
  }
  else if (a === '--dry-run') { flags.dryRun = true; }
  else if (a === '--json') { flags.json = true; }
  else if (a.startsWith('--')) { failUsage(`Unknown flag: ${a}`); }
  else { positional.push(a); }
}

if (positional.length !== 2) {
  failUsage(positional.length === 0 ? null : `Expected 2 arguments (report#, state), got ${positional.length}`);
}

// --on must be a real, non-future calendar date — validated before anything
// touches the tracker, same as state validation below.
if (flags.on !== null) {
  const m = /^\d{4}-\d{2}-\d{2}$/.test(flags.on);
  const d = m ? new Date(`${flags.on}T00:00:00Z`) : null;
  const roundTrips = d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === flags.on;
  if (!roundTrips) failUsage(`--on expects a real date as YYYY-MM-DD, got "${flags.on}"`);
  if (flags.on > new Date().toISOString().slice(0, 10)) failUsage(`--on date is in the future: "${flags.on}"`);
}

const [selector, stateInput] = positional;

// Shared with every other canonical tracker-writer CLI (tracker-utils.mjs) so
// the JSON-vs-human error contract can't drift between them.
const failWith = makeCliFailWith(flags.json);

/**
 * Print usage (plus an optional specific complaint) and exit 1.
 *
 * With --json a structured usage-error payload goes to stdout (same shape as
 * failWith) so machine callers always parse one stream. failUsage can fire
 * mid-argv-parse — before flags.json is settled — so JSON mode is detected
 * from the raw argv directly.
 *
 * @param {string|null} message - What was wrong with the invocation, if known.
 * @returns {never}
 */
function failUsage(message) {
  const msg = message ?? 'Expected 2 arguments: <report#> <state>';
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify({ error: msg, code: 'usage' }));
    console.error(`❌ ${msg}`);
  } else {
    if (message) console.error(`❌ ${message}\n`);
    console.error(USAGE);
  }
  process.exit(EXIT_USAGE);
}

// ── state validation (before anything touches the tracker) ──────

let states;
try {
  states = loadCanonicalStates(STATES_FILE);
} catch (err) {
  failWith(EXIT_USAGE, 'states-error', `Cannot load canonical states from ${STATES_FILE}: ${err.message}`);
}
const newStatus = resolveCanonicalState(stateInput, states);
if (!newStatus) {
  const valid = states.map(s => s.label).join(' · ');
  failWith(EXIT_USAGE, 'invalid-state', `"${stateInput}" is not a canonical state. Valid states: ${valid}`);
}

// ── tracker access ───────────────────────────────────────────────

const APPS_FILE = resolveTrackerPath(CAREER_OPS);
if (!existsSync(APPS_FILE)) {
  failWith(EXIT_NOT_FOUND, 'no-tracker', `No tracker found at ${APPS_FILE}`);
}

/**
 * Find the tracker row for the report number on the command line.
 *
 * @param {object[]} rows - Parsed data rows (parseTrackerRow output + lineIdx).
 * @returns {object} The single matched row. Exits the process otherwise.
 */
function resolveRow(rows) {
  const result = resolveReportNumber(rows, selector);
  if (result.row) return result.row;
  if (result.error === 'usage') failUsage(result.message);
  if (result.error === 'not-found') failWith(EXIT_NOT_FOUND, 'not-found', result.message);
  failWith(EXIT_AMBIGUOUS, 'ambiguous', result.message, { candidates: result.candidates });
}

// ── locked read-modify-write ─────────────────────────────────────

// Shared with mark-pdf-ready.mjs (tracker-utils.mjs): dry-run never writes,
// so it must not hold the exclusive lock — a read-only preview should not
// block (or be blocked by) merge-tracker or another writer.
const lock = await acquireTrackerLockForCli(APPS_FILE, { dryRun: flags.dryRun, failWith });

let content;
try {
  content = readFileSync(APPS_FILE, 'utf-8');
} catch (err) {
  failWith(EXIT_NOT_FOUND, 'read-failure', `Cannot read tracker at ${APPS_FILE}: ${err.message}`);
}
const lines = content.split('\n');
const colmap = resolveColumns(lines);

const rows = [];
for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i], colmap);
  if (row) rows.push({ ...row, lineIdx: i });
}
if (rows.length === 0) {
  failWith(EXIT_NOT_FOUND, 'empty-tracker', `Tracker at ${APPS_FILE} has no data rows`);
}

const target = resolveRow(rows);

const oldStatus = target.status;
const note = flags.note != null ? cell(flags.note) : null;

// Rebuild only the matched line: change the Status cell, append the note, keep
// every other cell exactly as parsed.
const parts = lines[target.lineIdx].split('|').map(s => s.trim());
while (parts.length <= Math.max(colmap.status, colmap.notes ?? 0)) parts.push('');

const statusChanged = parts[colmap.status] !== newStatus;
parts[colmap.status] = newStatus;

let noteChanged = false;
if (note) {
  if (colmap.notes == null) {
    failWith(EXIT_USAGE, 'no-notes-column', 'Tracker has no Notes column — cannot apply --note');
  }
  const existing = parts[colmap.notes] ?? '';
  // Delimiter-aware idempotency: the note counts as already present only when
  // it appears as a whole "; "-delimited entry (or as the entire field) — a
  // bare substring of a longer entry ("sent" inside "sent CV") must not
  // suppress a genuinely new note. Matching the full note text at entry
  // boundaries (instead of splitting the field into segments) keeps retries
  // idempotent even when the note itself contains "; ".
  const hasNote = existing === note
    || existing.startsWith(`${note}; `)
    || existing.endsWith(`; ${note}`)
    || existing.includes(`; ${note}; `);
  if (!hasNote) {
    parts[colmap.notes] = existing && existing !== '—' && existing !== '-' ? `${existing}; ${note}` : note;
    noteChanged = true;
  }
}

const changed = statusChanged || noteChanged;

if (changed && !flags.dryRun) {
  lines[target.lineIdx] = rebuildRow(parts);
  try {
    writeFileAtomic(APPS_FILE, lines.join('\n'));
  } catch (err) {
    // Same structured error contract as every other failure path — a raw
    // stack trace on stdout/stderr would break --json consumers.
    failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${APPS_FILE}: ${err.message}`);
  }
}

// ── status-log append (transition ledger, read by funnel-velocity.mjs) ──
// Observation trail only: the tracker stays the source of truth for STATE,
// the ledger records WHEN transitions happened. A failed append is a warning,
// never a failure — the status write above already succeeded. Sibling of the
// tracker file so CAREER_OPS_TRACKER redirects (tests, custom layouts) keep
// the ledger next to the tracker it describes. Inside the lock window, so
// concurrent writers can't interleave lines.
let statusLogged = false;
if (statusChanged && !flags.dryRun) {
  const logPath = join(dirname(APPS_FILE), 'status-log.tsv');
  const eventDate = flags.on ?? new Date().toISOString().slice(0, 10);
  try {
    appendFileSync(logPath, `${target.num}\t${eventDate}\t${oldStatus}\t${newStatus}\tset-status\t\n`);
    statusLogged = true;
  } catch (err) {
    console.error(`⚠ status-log append failed (status change itself succeeded): ${err.message}`);
  }
}
lock?.release();

// ── report ───────────────────────────────────────────────────────

const result = {
  changed,
  num: target.num,
  company: target.company,
  role: target.role,
  oldStatus,
  newStatus,
  ...(note != null ? { note } : {}),
  ...(flags.dryRun ? { dryRun: true } : {}),
  // Fire the #1430 hook only on an actual transition INTO Applied — an
  // idempotent re-run of an already-Applied row must not invite a consumer
  // to seed a duplicate follow-up.
  ...(statusChanged && newStatus === 'Applied' ? { followupSeedCandidate: true } : {}),
  // Sibling of the hook above, for the sheets plugin. Fires on ANY real status
  // change (not just into Applied) because a mirror has to track the whole
  // lifecycle. Like followupSeedCandidate it is reported on --dry-run too, so a
  // preview says whether a sync would follow.
  //
  // Signal only: the sheet write happens after this process exits, never inside
  // the tracker lock, where network latency would hold the lock and a network
  // failure could fail the status write itself.
  ...(statusChanged ? { sheetSyncCandidate: true } : {}),
  ...(statusChanged && !flags.dryRun ? { statusLogged } : {}),
  tracker: APPS_FILE,
};

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const verb = flags.dryRun ? 'would set' : changed ? 'set' : 'already';
  console.log(`✅ #${target.num} ${target.company} — ${target.role}: ${verb} ${oldStatus} → ${newStatus}${note ? ` (note: ${note})` : ''}`);
  if (statusChanged && !flags.dryRun && newStatus === 'Applied') {
    console.error('ℹ️  Status is Applied — consider seeding follow-ups in data/follow-ups.md (#1430: node followup-cadence.mjs)');
  }
}
process.exit(EXIT_OK);
