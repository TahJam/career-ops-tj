// tests/verify-pipeline-job-location.test.mjs — verify-pipeline Check 13.
//
// A hybrid or onsite report without a normalized job_location reaches the
// Google Sheet as a blank Location, so verify-pipeline must fail on it. Reports
// written before the keys existed are a backfill gap, reported as one warning.

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, ROOT, NODE } from './helpers.mjs';

const ok = (label, cond) => (cond ? pass(label) : fail(label));

const report = (role, keys) =>
  `# Evaluation: Acme — ${role}\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "Acme"\nrole: "${role}"\nscore: 4.2\n${keys}\`\`\`\n`;

/** Run verify-pipeline against a fixture; returns { code, out }. */
function verify(env) {
  try {
    return { code: 0, out: execFileSync(NODE, ['verify-pipeline.mjs'], { cwd: ROOT, env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout ?? '') };
  }
}

console.log('\nverify-pipeline — job location keys (Check 13)');
const tmp = mkdtempSync(join(tmpdir(), 'career-ops-verify-jobloc-'));
try {
  const reports = join(tmp, 'reports');
  mkdirSync(reports, { recursive: true });
  const tracker = join(tmp, 'applications.md');
  const env = { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: reports };

  const roles = ['Remote Eng', 'Onsite Eng', 'Legacy Eng'];
  writeFileSync(tracker,
    '# Applications Tracker\n\n' +
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
    '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
    roles.map((r, i) => `| ${i + 1} | 2026-10-01 | Acme | ${r} | 4.2/5 | Evaluated | ❌ | [${i + 1}](reports/00${i + 1}-acme-2026-10-01.md) | ok |\n`).join(''));

  writeFileSync(join(reports, '001-acme-2026-10-01.md'), report('Remote Eng', 'work_mode: "remote"\njob_location: null\n'));
  writeFileSync(join(reports, '002-acme-2026-10-01.md'), report('Onsite Eng', 'work_mode: "onsite"\njob_location: null\n'));
  writeFileSync(join(reports, '003-acme-2026-10-01.md'), report('Legacy Eng', ''));
  // A gate-skip note has no Machine Summary at all — never flagged.
  writeFileSync(join(reports, '004-acme-2026-10-01.md'), '# Evaluation: Acme — Skipped\n\n## Skip note\n\nonsite\n');

  const bad = verify(env);
  ok('an onsite report with no job_location fails the pipeline (exit 1)', bad.code === 1);
  ok('the error names the report and the broken rule',
    /❌ reports\/002-acme-2026-10-01\.md: onsite role has no job_location/.test(bad.out));
  ok('a remote report with a null job_location is valid', !/001-acme-2026-10-01\.md:/.test(bad.out));
  ok('a pre-key report is one aggregated warning, not an error',
    /⚠️ +1 report\(s\) have no work_mode \/ job_location yet: 003\b/.test(bad.out));
  ok('a report with no Machine Summary is out of scope', !/004/.test(bad.out.split('job_location yet:')[1] ?? ''));

  writeFileSync(join(reports, '002-acme-2026-10-01.md'), report('Onsite Eng', 'work_mode: "onsite"\njob_location: "Austin, TX"\n'));
  writeFileSync(join(reports, '003-acme-2026-10-01.md'), report('Legacy Eng', 'work_mode: "hybrid"\njob_location: "Berlin"\n'));
  const clean = verify(env);
  ok('once every report carries valid keys the check is green',
    clean.code === 0 && clean.out.includes('Job location keys valid in every report'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
