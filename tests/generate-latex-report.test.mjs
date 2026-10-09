// tests/generate-latex-report.test.mjs — generate-latex.mjs --report records the
// LaTeX PDF in data/pdf-index.tsv, so export-cv.mjs and find.mjs see it.

import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';

console.log('\ngenerate-latex.mjs --report — pdf-index.tsv linkage');

// No real TeX engine is needed: a stand-in pdflatex writes a tiny PDF where the
// real one would, and a stand-in tectonic fails its --version probe so the
// stand-in pdflatex is chosen even on a machine that has tectonic installed.
const work = mkdtempSync(join(tmpdir(), 'cops-latex-report-'));
const sandbox = mkdtempSync(join(ROOT, 'output', 'latex-report-test-'));
try {
  const bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tectonic'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(bin, 'pdflatex'), [
    '#!/bin/sh',
    '[ "$1" = "--version" ] && { echo "pdfTeX stand-in"; exit 0; }',
    'for a in "$@"; do case "$a" in -output-directory=*) out="${a#-output-directory=}";; -*) ;; *) src="$a";; esac; done',
    'printf "%%PDF-1.4\\n%%%%EOF\\n" > "$out/$(basename "$src" .tex).pdf"',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'tectonic'), 0o755);
  chmodSync(join(bin, 'pdflatex'), 0o755);

  const tex = join(sandbox, 'cv-acme-042-latex.tex');
  const pdf = join(sandbox, 'cv-acme-042-latex.pdf');
  const index = join(work, 'pdf-index.tsv');
  writeFileSync(tex, '\\documentclass{article}\\begin{document}x\\end{document}\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAREER_OPS_PDF_INDEX: index };

  execFileSync(NODE, [join(ROOT, 'generate-latex.mjs'), tex, pdf, '--compile-only', '--report=042'], { env, encoding: 'utf-8' });
  const rows = readFileSync(index, 'utf-8').split('\n').filter(l => l && !l.startsWith('#'));
  const relPdf = pdf.slice(ROOT.length + 1).split('\\').join('/');
  const fields = (rows[0] || '').split('\t');
  if (rows.length === 1 && fields[0] === '042' && fields[1] === relPdf) {
    pass('--report=042 records the compiled LaTeX PDF for report 042');
  } else {
    fail(`--report did not record the LaTeX PDF: ${JSON.stringify(rows)}`);
  }
  // The dashboard's D key re-renders the html column with generate-pdf.mjs,
  // which cannot render a .tex source, so a LaTeX row leaves it blank.
  if (fields[2] === '') {
    pass('a LaTeX row leaves the html column blank');
  } else {
    fail(`a LaTeX row must leave the html column blank, got "${fields[2]}"`);
  }

  // Without --report nothing is recorded (one-off CVs stay out of the index).
  rmSync(index, { force: true });
  execFileSync(NODE, [join(ROOT, 'generate-latex.mjs'), tex, pdf, '--compile-only'], { env, encoding: 'utf-8' });
  let wrote = true;
  try { readFileSync(index); } catch { wrote = false; }
  if (!wrote) pass('without --report the index is not written');
  else fail('generate-latex.mjs wrote pdf-index.tsv without --report');

  let rejected = false;
  try {
    execFileSync(NODE, [join(ROOT, 'generate-latex.mjs'), tex, pdf, '--report=abc'], { env, encoding: 'utf-8', stdio: 'pipe' });
  } catch { rejected = true; }
  if (rejected) pass('a non-numeric --report is rejected');
  else fail('generate-latex.mjs accepted --report=abc');
} catch (e) {
  fail(`generate-latex --report test crashed: ${e.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
}
