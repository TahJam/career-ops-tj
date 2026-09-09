// tests/cv-empty-section-guard.test.mjs — a CV must never render a section
// heading with nothing under it.
//
// build-cv-html.mjs already strips empty optional sections before filling the
// template (cv-sections-core.mjs), so a bare header can only reach the PDF
// renderer when the HTML skipped that builder — an agent hand-writing the
// markup, which modes/pdf.md forbids. Three shipped CVs in output/ carried a
// bare "Certifications" header for exactly that reason before this guard
// existed, so the check lives in generate-pdf.mjs: every CV passes through the
// renderer regardless of how its HTML was authored, which makes it the only
// place the rule can be enforced instead of merely restated.
import { pass, fail } from './helpers.mjs';
import { validateNoEmptySections } from '../generate-pdf.mjs';
import { isEmptySection } from '../cv-sections-core.mjs';

console.log('\ngenerate-pdf.mjs — no CV section heading may render empty');

function rejects(label, html, expected) {
  try {
    validateNoEmptySections(html);
    fail(`${label} — expected a rejection, got none`);
  } catch (err) {
    if (err.message.includes(expected)) pass(label);
    else fail(`${label} — rejected for the wrong reason: ${err.message}`);
  }
}

function accepts(label, html) {
  try {
    validateNoEmptySections(html);
    pass(label);
  } catch (err) {
    fail(`${label} — expected no rejection, got: ${err.message}`);
  }
}

const section = (title, body) =>
  `<div class="section"><div class="section-title">${title}</div>${body}</div>`;

// --- The shipped bug: a header over an empty container --------------------
rejects(
  'a bare Certifications header over an empty .cert-table is rejected',
  section('Summary', '<div class="summary-text">Text.</div>') +
    section('Certifications', '<div class="cert-table"></div>'),
  'certifications'
);

rejects(
  'a section title followed by nothing at all is rejected',
  section('Experience', '<div class="job">Role</div>') + section('Projects', ''),
  'projects'
);

rejects(
  'whitespace and comments do not count as content',
  section('Education', '<div class="edu-item">BS</div>') +
    section('Certifications', '\n  <!-- nothing here -->\n  '),
  'certifications'
);

// The message must point at the fix, not just name the problem — an agent
// reading it has to learn that the builder is the way out.
rejects(
  'the rejection names build-cv-html.mjs as the fix',
  section('Certifications', '<div class="cert-table"></div>'),
  'build-cv-html.mjs'
);

// Every bare section is reported, not just the first one found.
try {
  validateNoEmptySections(section('Projects', '') + section('Certifications', ''));
  fail('multiple bare sections — expected a rejection, got none');
} catch (err) {
  if (err.message.includes('projects') && err.message.includes('certifications')) {
    pass('every bare section is named, not only the first');
  } else {
    fail(`multiple bare sections — message named only some of them: ${err.message}`);
  }
}

// --- Content that must NOT be mistaken for empty --------------------------
accepts(
  'a populated section passes',
  section('Summary', '<div class="summary-text">Backend engineer.</div>')
);

accepts(
  'a section whose only content is list items passes',
  section('Experience', '<div class="job"><ul><li>Shipped it</li></ul></div>')
);

accepts(
  'a section whose only content is an image passes',
  section('Signature', '<div><img src="data:image/png;base64,iVBOR" alt=""></div>')
);

accepts(
  'a document with no section titles at all passes (nothing to judge)',
  '<html><body><p>Not a CV.</p></body></html>'
);

// A trailing section is the easy one to miss: its body runs to end-of-input
// rather than up to the next heading.
rejects(
  'a bare section in final position is still caught',
  section('Summary', '<div>Text.</div>') + '<div class="section"><div class="section-title">Certifications</div></div>',
  'certifications'
);

// --- isEmptySection agrees with what the builders actually render ---------
// Every buildX() opens with entries.filter(Boolean), so an all-falsy array
// renders exactly as [] does and must be stripped the same way.
console.log('\ncv-sections-core.mjs — isEmptySection matches what buildX() renders');

const cases = [
  ['[] is empty', [], true],
  ['a missing key is empty', undefined, true],
  ['a non-array is empty', 'nope', true],
  ['[null] is empty (filter(Boolean) drops it)', [null], true],
  ['[""] is empty', [''], true],
  ['[null, undefined] is empty', [null, undefined], true],
  ['[{...}] is not empty', [{ title: 'CKA' }], false],
  ['[null, {...}] is not empty', [null, { title: 'CKA' }], false],
];

for (const [label, value, expected] of cases) {
  const actual = isEmptySection({ certifications: value }, 'certifications');
  if (actual === expected) pass(`isEmptySection: ${label}`);
  else fail(`isEmptySection: ${label} — expected ${expected}, got ${actual}`);
}
