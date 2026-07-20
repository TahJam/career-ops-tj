#!/usr/bin/env node

/**
 * pipeline-to-batch-input.mjs — Bridge data/pipeline.md into batch/batch-input.tsv.
 *
 * `modes/pipeline.md`'s own documented workflow launches one Agent-tool subagent
 * per pending URL directly from pipeline.md. For large backlogs that fan-out has
 * no retry/resume handling and dies entirely on a Claude session/usage-limit hit
 * partway through. `batch/batch-runner.sh` (see modes/batch.md, Mode B) already
 * solves exactly that — automatic retry, `--resume-paused`, automatic end-of-run
 * merge-tracker.mjs -> reconcile-pipeline.mjs -> verify-pipeline.mjs — but it reads
 * from `batch/batch-input.tsv`, a different format than pipeline.md. This script
 * is the missing bridge between the two.
 *
 * Reads the "## Pending" (or Spanish "## Pendientes") section of data/pipeline.md,
 * skips already-processed (`- [x]`) and errored (`- [!]`) lines, and writes
 * batch/batch-input.tsv in the 4-column format batch-runner.sh expects:
 * `id\turl\tsource\tnotes`.
 *
 * `reconcile-pipeline.mjs` (run automatically by batch-runner.sh at the end of a
 * run) matches back to pipeline.md by exact URL string, so the URL written here
 * must be byte-identical to the one embedded in the pipeline.md line.
 *
 * Usage:
 *   node pipeline-to-batch-input.mjs                 # writes batch/batch-input.tsv
 *   node pipeline-to-batch-input.mjs --dry-run        # preview only, don't write
 *   node pipeline-to-batch-input.mjs --limit 20       # cap how many rows are written
 *   node pipeline-to-batch-input.mjs --pipeline <path> --out <path>   # override paths (testing)
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  console.log('Usage: node pipeline-to-batch-input.mjs [--dry-run] [--limit N] [--pipeline <path>] [--out <path>]');
  console.log('  Converts data/pipeline.md "## Pending" entries into batch/batch-input.tsv for batch-runner.sh.');
  process.exit(0);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const limitArg = argValue('--limit');
const LIMIT = limitArg ? Number(limitArg) : 0;
const PIPELINE_PATH = resolve(argValue('--pipeline') || join(CAREER_OPS, 'data', 'pipeline.md'));
const OUT_PATH = resolve(argValue('--out') || join(CAREER_OPS, 'batch', 'batch-input.tsv'));

const PENDING_RE = /^##\s+(Pendientes|Pending)\s*$/i;
const SECTION_RE = /^##\s/;
const PENDING_ITEM_RE = /^-\s\[\s\]\s+/;

function parsePending(text) {
  const lines = text.split('\n');
  let inPending = false;
  const rows = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (PENDING_RE.test(trimmed)) { inPending = true; continue; }
    if (inPending && SECTION_RE.test(trimmed)) { inPending = false; continue; }
    if (!inPending) continue;
    if (!PENDING_ITEM_RE.test(line)) continue; // blank lines, "- [x]", "- [!]" → skip
    const body = line.replace(PENDING_ITEM_RE, '');
    const cols = body.split('|').map((c) => c.trim());
    const url = cols[0];
    if (!url) continue;
    const company = cols[1] || '';
    const title = cols[2] || '';
    const noteCol = cols.find((c) => c.toLowerCase().startsWith('note:'));
    const notes = noteCol
      ? noteCol.slice(5).trim()
      : [company, title].filter(Boolean).join(' — ');
    rows.push({ url, notes });
  }
  return rows;
}

let text;
try {
  text = readFileSync(PIPELINE_PATH, 'utf8');
} catch {
  console.error(`Cannot read ${PIPELINE_PATH}`);
  process.exit(1);
}

let rows = parsePending(text);
if (LIMIT > 0) rows = rows.slice(0, LIMIT);

if (rows.length === 0) {
  console.log('No pending URLs found — nothing to write.');
  process.exit(0);
}

let out = 'id\turl\tsource\tnotes\n';
rows.forEach((r, i) => {
  out += `${i + 1}\t${r.url}\tpipeline\t${r.notes}\n`;
});

if (DRY_RUN) {
  console.log(`[dry-run] Would write ${rows.length} row(s) to ${OUT_PATH}:\n`);
  console.log(out);
} else {
  writeFileSync(OUT_PATH, out);
  console.log(`✅ Wrote ${rows.length} row(s) to ${OUT_PATH}`);
  console.log('   Next: ./batch/batch-runner.sh --dry-run   (preview), then ./batch/batch-runner.sh --parallel 3');
}
