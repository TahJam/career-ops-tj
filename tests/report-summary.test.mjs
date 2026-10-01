// tests/report-summary.test.mjs — the shared Machine Summary reader.
//
// The job-location cases live in tests/fixtures/report-location-cases.json and
// are also run by the Go dashboard (dashboard/internal/data/derive_test.go), so
// the two readers cannot drift apart without one of them failing.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  readMachineSummary, parseMachineSummary, yamlScalar, jobLocation, checkJobLocation, sheetLocation,
  MACHINE_SUMMARY_RE, US_STATES,
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
  ok('a json-tagged fence is accepted',
    readMachineSummary('## Machine Summary\n\n```json\n{"company": "Acme"}\n```\n')?.company === 'Acme');
  ok('MACHINE_SUMMARY_RE is exported for callers that only need presence',
    MACHINE_SUMMARY_RE.test('## Machine Summary\n\n```yaml\na: 1\n```'));
}

console.log('\nreport-summary — parse status and line-scan fallback (PR #4 review [1], [2])');
{
  const fence = (body) => `## Machine Summary\n\n\`\`\`yaml\n${body}\n\`\`\`\n`;
  ok('no fence → none', parseMachineSummary('# R\n\n## Skip note\n').status === 'none');
  ok('a valid fence → ok', parseMachineSummary(fence('company: "Acme"')).status === 'ok');

  // Regression: one unquoted "a: b: c" line made js-yaml throw, and the whole
  // fence read as null, so via, advertised_comp and job_location all vanished.
  const broken = parseMachineSummary(fence('company: "Acme"\nnotes: comp: base + equity\nvia: "Hays"\nadvertised_comp: "$150K"\njob_location: "Austin, TX"'));
  ok('a YAML error → partial, not a silent null', broken.status === 'partial' && /indentation/.test(broken.error ?? ''));
  ok('partial recovers every top-level scalar',
    broken.summary.via === 'Hays' && broken.summary.advertised_comp === '$150K' && broken.summary.job_location === 'Austin, TX');
  ok('readMachineSummary hands callers the recovered fields', readMachineSummary(fence('notes: a: b\nvia: "Hays"'))?.via === 'Hays');

  const garbage = parseMachineSummary(fence('{{{ not yaml'));
  ok('nothing recoverable → unparseable with a null summary', garbage.status === 'unparseable' && garbage.summary === null && garbage.error);
  ok('a list body is not a mapping → unparseable', parseMachineSummary(fence('- a\n- b')).status === 'unparseable');
  ok('a repeated key in a broken fence: the last one wins, as in json mode',
    readMachineSummary(fence('x: a: b\nvia: "One"\nvia: "Two"')).via === 'Two');
}

console.log('\nreport-summary — scalar rules shared with the Go reader');
{
  const cases = [
    [`"Austin, TX"`, 'Austin, TX'], [`'Austin, TX'`, 'Austin, TX'], ['Austin, TX', 'Austin, TX'],
    [`'O''Fallon, MO'`, "O'Fallon, MO"], [`"say \\"hi\\""`, 'say "hi"'],
    ['onsite  # five days', 'onsite'], [`"a # b"`, 'a # b'],
    ['null', null], ['Null', null], ['NULL', null], ['~', null], ['', null], ['nULL', 'nULL'],
    [`"unterminated`, null],
  ];
  for (const [raw, want] of cases) {
    const got = yamlScalar(raw);
    ok(`yamlScalar(${JSON.stringify(raw)}) → ${JSON.stringify(want)}`, got === want);
  }
}

console.log('\nreport-summary — job location (shared fixture)');
{
  const fixture = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'report-location-cases.json'), 'utf-8'));
  const { cases } = fixture;
  ok('the shared fixture has cases', Array.isArray(cases) && cases.length > 0);
  ok('the US state list matches the shared fixture (the Go reader checks the same list)',
    JSON.stringify([...US_STATES].sort()) === JSON.stringify(fixture.usStates));
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
