// tests/sheets-referral.test.mjs — the sheet's column G (Referral).
//
// Report #293 (an agency posting) synced as Referral = Yes because the sync
// read the Machine Summary `via` key, which names an agency, not a referral.
// Column G now comes from `referred_by` or a referral in the tracker note.
// See plans/10-19-26_referred-by-field.md.

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isReferral, reportFacts, _clearCaches } from '../plugins/sheets/_sources.mjs';
import { buildDesiredRows } from '../plugins/sheets/_reconcile.mjs';
import { readMachineSummary, referredBy } from '../lib/report-summary.mjs';
import { pass, fail } from './helpers.mjs';

const ok = (label, cond) => (cond ? pass(label) : fail(label));

/** reportFacts()'s referral fact for a report whose fence holds `keys`. */
const factsFor = (keys) => ({
  referredBy: referredBy(readMachineSummary(`# R\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "?"\n${keys}\`\`\`\n`)),
});

console.log('\nsheets referral — column G sources');
ok('an agency posting (via set, no referred_by, no note) is not a referral',
  isReferral({ notes: 'Unnamed startup via UMATR; remote' }, factsFor('via: "UMATR"\n')) === false);
ok('an agency posting with referred_by: null is not a referral',
  isReferral({ notes: '' }, factsFor('via: "NJF Global Holdings Ltd"\nreferred_by: null\n')) === false);
ok('referred_by set is a referral', isReferral({ notes: '' }, factsFor('via: null\nreferred_by: "Khuzaima"\n')) === true);
ok('referred_by set on an agency posting is still a referral',
  isReferral({ notes: '' }, factsFor('via: "Hays"\nreferred_by: "former manager"\n')) === true);
ok('a referral noted after evaluation counts even though referred_by is null',
  isReferral({ notes: 'job id 102641; Referred by Mustansir' }, factsFor('via: null\nreferred_by: null\n')) === true);
ok('a report written before the key: the note decides',
  isReferral({ notes: 'Applying via friend referral at Oura' }, factsFor('via: null\n')) === true
  && isReferral({ notes: 'remote; comp unstated' }, factsFor('via: null\n')) === false);
ok('"preferred" in a note is not a referral', isReferral({ notes: 'Go preferred, TX preferred-state' }, factsFor('')) === false);
ok('a missing report (no facts) falls back to the note', isReferral({ notes: 'Referred by Kai' }, { referredBy: null }) === true);

console.log('\nsheets referral — written to new rows');
{
  const trackerRows = [
    { num: 293, company: '?', role: 'Software Engineer - AI & Automation', date: '2026-10-19', status: 'Applied', notes: 'via UMATR' },
    { num: 275, company: '1Password', role: 'Software Engineer', date: '2026-10-06', status: 'Applied', notes: '' },
  ];
  const keys = { 293: 'via: "UMATR"\nreferred_by: null\n', 275: 'via: null\nreferred_by: "Khuzaima"\n' };
  const { rows } = buildDesiredRows({
    sheetRows: [],
    trackerRows,
    facts: (t) => ({ applyDate: null, resume: null, url: null, location: 'Remote', referral: isReferral(t, factsFor(keys[t.num])) }),
    statusMap: { Applied: 'Submitted - Waiting' },
    year: 2026,
  });
  // Rows are A:H cell arrays; G (Referral) is index 6.
  const g = Object.fromEntries(rows.map(r => [r[0], r[6]]));
  ok('the agency row lands with Referral = No', g['?'] === 'No');
  ok('the referred row lands with Referral = Yes', g['1Password'] === 'Yes');
}

console.log('\nsheets referral — reportFacts() wiring (PR #8 review [5])');
{
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-sheets-referral-'));
  const prev = process.env.CAREER_OPS_REPORTS;
  const write = (file, keys) => writeFileSync(join(dir, file),
    `# Evaluation: ? — Eng\n\n**URL:** https://x.test/job\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "?"\n${keys}\`\`\`\n`);
  try {
    write('901-confidential-umatr-2026-10-19.md', 'via: "UMATR"\nreferred_by: null\n');
    write('902-acme-2026-10-19.md', 'via: null\nreferred_by: "Khuzaima"\n');
    write('903-acme-2026-10-19.md', 'via: "Hays"\n');
    process.env.CAREER_OPS_REPORTS = dir;
    _clearCaches();
    const agency = reportFacts(901);
    const referred = reportFacts(902);
    const legacy = reportFacts(903);
    ok('reportFacts reads referred_by from the report', referred.referredBy === 'Khuzaima');
    ok('reportFacts never exposes via, and an agency report has no referrer',
      !('via' in agency) && agency.referredBy === null && legacy.referredBy === null);
    ok('end to end: agency → No, referred → Yes',
      isReferral({ notes: '' }, agency) === false && isReferral({ notes: '' }, referred) === true
      && isReferral({ notes: '' }, legacy) === false);
  } finally {
    if (prev === undefined) delete process.env.CAREER_OPS_REPORTS; else process.env.CAREER_OPS_REPORTS = prev;
    _clearCaches();
    rmSync(dir, { recursive: true, force: true });
  }
}
