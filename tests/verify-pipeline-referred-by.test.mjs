// tests/verify-pipeline-referred-by.test.mjs — verify-pipeline Check 15.
//
// referred_by feeds the sheet's Referral column and must hold only a name or
// relationship. Reports written before the key existed are not flagged.

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, ROOT, NODE } from './helpers.mjs';

const ok = (label, cond) => (cond ? pass(label) : fail(label));

const report = (role, keys) =>
  `# Evaluation: Acme — ${role}\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "Acme"\nrole: "${role}"\nscore: 4.2\nwork_mode: "remote"\njob_location: null\n${keys}\`\`\`\n`;

/** Run verify-pipeline against a fixture; returns { code, out }. */
function verify(env) {
  try {
    return { code: 0, out: execFileSync(NODE, ['verify-pipeline.mjs'], { cwd: ROOT, env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout ?? '') };
  }
}

console.log('\nverify-pipeline — referred_by (Check 15)');
const tmp = mkdtempSync(join(tmpdir(), 'career-ops-verify-referred-'));
try {
  const reports = join(tmp, 'reports');
  mkdirSync(reports, { recursive: true });
  const tracker = join(tmp, 'applications.md');
  const env = { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_REPORTS: reports };

  const roles = ['Referred Eng', 'Agency Eng', 'Legacy Eng'];
  writeFileSync(tracker,
    '# Applications Tracker\n\n' +
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
    '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
    roles.map((r, i) => `| ${i + 1} | 2026-10-01 | Acme | ${r} | 4.2/5 | Evaluated | ❌ | [${i + 1}](reports/00${i + 1}-acme-2026-10-01.md) | ok |\n`).join(''));

  writeFileSync(join(reports, '001-acme-2026-10-01.md'), report('Referred Eng', 'via: null\nreferred_by: "kai@example.com"\n'));
  writeFileSync(join(reports, '002-acme-2026-10-01.md'), report('Agency Eng', 'via: "Hays"\nreferred_by: null\n'));
  writeFileSync(join(reports, '003-acme-2026-10-01.md'), report('Legacy Eng', 'via: null\n'));

  const bad = verify(env);
  ok('contact details in referred_by fail the pipeline (exit 1)', bad.code === 1);
  ok('the error names the report and the rule',
    /❌ reports\/001-acme-2026-10-01\.md: referred_by holds contact details/.test(bad.out));
  ok('an agency report with referred_by: null is valid', !/002-acme-2026-10-01\.md:/.test(bad.out));
  ok('a report without the key is not flagged', !/003-acme-2026-10-01\.md:/.test(bad.out));

  writeFileSync(join(reports, '001-acme-2026-10-01.md'), report('Referred Eng', 'via: null\nreferred_by: "Kai"\n'));
  const clean = verify(env);
  ok('a named referrer passes the check', /✅ referred_by valid wherever it is set/.test(clean.out));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
