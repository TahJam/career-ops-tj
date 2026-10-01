// tests/report-summary.test.mjs — the shared Machine Summary reader.
//
// The job-location cases live in tests/fixtures/report-location-cases.json and
// are also run by the Go dashboard (dashboard/internal/data/derive_test.go), so
// the two readers cannot drift apart without one of them failing.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  readMachineSummary, jobLocation, checkJobLocation, sheetLocation, MACHINE_SUMMARY_RE,
} from '../lib/report-summary.mjs';
import { pass, fail, ROOT } from './helpers.mjs';

const ok = (label, cond) => (cond ? pass(label) : fail(label));

console.log('\nreport-summary — fence parsing');
{
  const report = '# R\n\n## Machine Summary\n\n```yaml\ncompany: "Acme"\nscore: 4.2\nvia: null\n```\n';
  const s = readMachineSummary(report);
  ok('parses the fence into typed values', s?.company === 'Acme' && s?.score === 4.2 && s?.via === null);
  ok('no fence → null', readMachineSummary('# R\n\nno summary here') === null);
  ok('null / undefined input → null', readMachineSummary(null) === null && readMachineSummary(undefined) === null);
  ok('a fence that is not a mapping → null',
    readMachineSummary('## Machine Summary\n\n```yaml\n- a\n- b\n```\n') === null);
  ok('unparseable YAML → null, never a throw',
    readMachineSummary('## Machine Summary\n\n```yaml\ncompany: "unterminated\n```\n') === null);
  ok('a json-tagged fence is accepted',
    readMachineSummary('## Machine Summary\n\n```json\n{"company": "Acme"}\n```\n')?.company === 'Acme');
  ok('MACHINE_SUMMARY_RE is exported for callers that only need presence',
    MACHINE_SUMMARY_RE.test('## Machine Summary\n\n```yaml\na: 1\n```'));
}

console.log('\nreport-summary — job location (shared fixture)');
{
  const { cases } = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'report-location-cases.json'), 'utf-8'));
  ok('the shared fixture has cases', Array.isArray(cases) && cases.length > 0);
  for (const c of cases) {
    const summary = readMachineSummary(c.report);
    const got = jobLocation(summary);
    const sheet = sheetLocation(summary);
    const check = checkJobLocation(summary).state;
    const diffs = [];
    if (got.workMode !== c.workMode) diffs.push(`workMode ${JSON.stringify(got.workMode)} ≠ ${JSON.stringify(c.workMode)}`);
    if (got.location !== c.location) diffs.push(`location ${JSON.stringify(got.location)} ≠ ${JSON.stringify(c.location)}`);
    if (sheet !== c.sheetLocation) diffs.push(`sheetLocation ${JSON.stringify(sheet)} ≠ ${JSON.stringify(c.sheetLocation)}`);
    if (check !== c.check) diffs.push(`check ${check} ≠ ${c.check}`);
    diffs.length ? fail(`${c.name}: ${diffs.join('; ')}`) : pass(c.name);
  }
}

console.log('\nreport-summary — validation messages');
{
  const { reason } = checkJobLocation({ work_mode: 'onsite', job_location: null });
  ok('an invalid report says which rule it broke', /onsite role has no job_location/.test(reason ?? ''));
  ok('a report with only one of the two keys is checked, not treated as missing',
    checkJobLocation({ work_mode: 'remote' }).state === 'ok'
    && checkJobLocation({ job_location: 'Austin, TX' }).state === 'invalid');
}
