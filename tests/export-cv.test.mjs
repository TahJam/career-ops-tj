// tests/export-cv.test.mjs — coverage for export-cv.mjs (plans/10-02-26_feat-pdf-copy.md).
//
// export-cv.mjs copies a report's tailored CV PDF (looked up in
// data/pdf-index.tsv) to a fixed upload path from config/profile.yml
// `cv.export_path`, or to a `--out` override. The pure resolver is tested
// in-process; the CLI runs in a tmp sandbox via the CAREER_OPS_PROFILE /
// CAREER_OPS_PDF_INDEX / INIT_CWD overrides, so the real profile, index, and
// destination are never touched.
//
// Auto-discovered by test-all.mjs (tests/**/*.test.mjs, #1440) — imported
// in-process alongside every other discovered suite, so this file must NEVER
// exit the process itself; only pass()/fail() from ./helpers.mjs.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nexport-cv.mjs — copy a report\'s CV PDF to the upload path');

let mod = null;
try {
  mod = await import(pathToFileURL(join(ROOT, 'export-cv.mjs')).href);
} catch (err) {
  fail(`export-cv.mjs could not be imported: ${err.message}`);
}

// ── Pure resolver ────────────────────────────────────────────────────
if (mod) {
  const { resolveExport, ExportError } = mod;
  const pdfIndex = new Map([['248', 'output/cv-runpod-248.pdf'], ['7', 'output/cv-acme-007.pdf']]);
  const root = '/repo/career-ops';
  const cwd = '/home/me/somewhere';

  // Run resolveExport and return { result } or { error } so each case is one line.
  const attempt = (args) => {
    try { return { result: resolveExport({ pdfIndex, root, cwd, ...args }) }; }
    catch (error) { return { error }; }
  };

  {
    // Given a profile export_path relative to the career-ops root
    const { result, error } = attempt({ report: '248', exportPath: '../Resume.pdf' });
    // Then the source is the indexed PDF and the dest resolves against root, not cwd
    if (!error && result.reportNum === '248'
        && result.src === resolve(root, 'output/cv-runpod-248.pdf')
        && result.dest === resolve(root, '../Resume.pdf')
        && result.destSource === 'profile') {
      pass('resolves a report# to its indexed PDF and the profile path (root-relative)');
    } else {
      fail(`profile resolution wrong: ${JSON.stringify(result ?? error?.message)}`);
    }
  }

  {
    // Given zero-padded and unpadded forms of the same report number
    const padded = attempt({ report: '0007', exportPath: '/x.pdf' }).result;
    const bare = attempt({ report: '7', exportPath: '/x.pdf' }).result;
    if (padded && bare && padded.src === bare.src && padded.reportNum === '7') {
      pass('normalizes "0007" and "7" to the same report');
    } else {
      fail(`report normalization wrong: ${JSON.stringify({ padded, bare })}`);
    }
  }

  {
    // Given both a profile path and a relative --out
    const { result } = attempt({ report: '248', exportPath: '../Resume.pdf', out: 'mine.pdf' });
    // Then --out wins and resolves against the invoking cwd
    if (result && result.dest === resolve(cwd, 'mine.pdf') && result.destSource === '--out') {
      pass('--out overrides the profile path and resolves against the invoking cwd');
    } else {
      fail(`--out override wrong: ${JSON.stringify(result)}`);
    }
  }

  {
    const { result } = attempt({ report: '248', exportPath: '../Resume.pdf', out: '/tmp/abs.pdf' });
    if (result && result.dest === '/tmp/abs.pdf') pass('keeps an absolute --out as given');
    else fail(`absolute --out wrong: ${JSON.stringify(result)}`);
  }

  {
    const { error } = attempt({ report: '999', exportPath: '/x.pdf' });
    if (error instanceof ExportError && /999/.test(error.message) && /--report=999/.test(error.message)) {
      pass('errors when the report has no indexed PDF, naming the report and the --report= form');
    } else {
      fail(`unindexed report should throw ExportError naming 999: ${error?.message}`);
    }
  }

  {
    const { error } = attempt({ report: '248', exportPath: undefined });
    if (error instanceof ExportError && /export_path/.test(error.message) && /--out/.test(error.message)) {
      pass('errors when no destination is configured, naming both ways to set one');
    } else {
      fail(`missing destination should throw naming cv.export_path and --out: ${error?.message}`);
    }
  }

  for (const bad of ['', 'runpod', '24a']) {
    const { error } = attempt({ report: bad, exportPath: '/x.pdf' });
    if (error instanceof ExportError) pass(`rejects non-numeric report "${bad}"`);
    else fail(`non-numeric report "${bad}" should throw ExportError`);
  }

  {
    // Given a report whose index row was taken over by its cover letter
    // (generate-cover-letter.mjs --report NNN replaces the CV's row)
    const coverIndex = new Map([['94', 'output/lightspeed-systems-software-engineer-cover.pdf']]);
    const { error } = attempt({ report: '94', pdfIndex: coverIndex, exportPath: '/x.pdf' });
    // Then it refuses instead of uploading a cover letter as the resume
    if (error instanceof ExportError && /cover letter/i.test(error.message) && /--report=94/.test(error.message)) {
      pass('refuses when the indexed PDF is a cover letter, with the --report= regenerate hint');
    } else {
      fail(`cover-letter row should throw naming the cover letter and --report=94: ${error?.message}`);
    }
  }

  {
    // Given CVs whose names merely contain "cover" (company "Cover Genius") or skip the cv- prefix
    const cvIndex = new Map([
      ['12', 'output/cv-jane-cover-genius-12-2026-10-01.pdf'],
      ['183', 'output/taherjamali-vercel-183-2026-09-11.pdf'],
    ]);
    const a = attempt({ report: '12', pdfIndex: cvIndex, exportPath: '/x.pdf' });
    const b = attempt({ report: '183', pdfIndex: cvIndex, exportPath: '/x.pdf' });
    if (a.result && b.result) pass('accepts CVs named after a "Cover…" company or without a cv- prefix');
    else fail(`CV names wrongly refused: ${a.error?.message} / ${b.error?.message}`);
  }

  {
    // Given destinations that aren't .pdf files (a profile typo could name cv.md)
    const bad = ['notes.md', 'config/profile.yml', '../Resume'];
    const errors = bad.map((p) => attempt({ report: '248', exportPath: p }).error);
    const outErr = attempt({ report: '248', exportPath: '/x.pdf', out: 'cv.md' }).error;
    if (errors.every((e) => e instanceof ExportError && /\.pdf/.test(e.message)) && outErr instanceof ExportError) {
      pass('refuses non-.pdf destinations from cv.export_path and --out');
    } else {
      fail(`non-.pdf destination should throw: ${JSON.stringify(errors.map((e) => e?.message))} / ${outErr?.message}`);
    }
    const upper = attempt({ report: '248', exportPath: '../Resume.PDF' });
    if (upper.result) pass('accepts an upper-case .PDF extension');
    else fail(`upper-case .PDF wrongly refused: ${upper.error?.message}`);
  }
}

// ── CLI (sandboxed) ──────────────────────────────────────────────────

const PDF_BYTES = Buffer.from('%PDF-1.7 fake tailored cv for report 248\n');

// Build a sandbox with a source PDF, an index pointing at it (absolute path),
// and a profile whose export_path is `exportPath` (omitted when null).
function makeSandbox({ exportPath = 'dest/Resume.pdf', indexPdf = 'src/cv-248.pdf' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'co-exportcv-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'dest'));
  const src = join(dir, 'src', 'cv-248.pdf');
  writeFileSync(src, PDF_BYTES);
  const index = join(dir, 'pdf-index.tsv');
  writeFileSync(index, `# report\tpdf\thtml\tformat\tdate\n248\t${join(dir, indexPdf)}\tx.html\tletter\t2026-10-02\n`);
  const profile = join(dir, 'profile.yml');
  writeFileSync(profile, exportPath === null
    ? 'cv:\n  output_format: "html"\n'
    : `cv:\n  output_format: "html"\n  export_path: "${join(dir, exportPath)}"\n`);
  return { dir, src, index, profile };
}

// Run export-cv.mjs against a sandbox. Returns { code, stdout, stderr }.
// By default it looks like `npm run export-cv` typed in the sandbox dir
// (npm_lifecycle_event + INIT_CWD). An extraEnv value of undefined removes
// that variable, e.g. to simulate a direct `node export-cv.mjs` run.
function runExport(args, sb, extraEnv = {}, { cwd = ROOT } = {}) {
  const env = {
    ...process.env,
    CAREER_OPS_PROFILE: sb.profile, CAREER_OPS_PDF_INDEX: sb.index,
    INIT_CWD: sb.dir, npm_lifecycle_event: 'export-cv',
  };
  delete env.npm_config_out; // test-all may itself run under npm
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    const stdout = execFileSync(NODE, [join(ROOT, 'export-cv.mjs'), ...args], {
      cwd, env, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// Run one sandboxed case and always clean up.
function withSandbox(opts, fn) {
  const sb = makeSandbox(opts);
  try { fn(sb); } finally { rmSync(sb.dir, { recursive: true, force: true }); }
}

if (mod) {
  withSandbox({}, (sb) => {
    // Given an indexed PDF and a profile export_path
    const before = statSync(sb.src).mtimeMs;
    const r = runExport(['248'], sb);
    const dest = join(sb.dir, 'dest', 'Resume.pdf');
    // Then the bytes are copied, the source is untouched, and stdout names report + both paths
    const copied = existsSync(dest) && readFileSync(dest).equals(PDF_BYTES);
    const srcIntact = readFileSync(sb.src).equals(PDF_BYTES) && statSync(sb.src).mtimeMs === before;
    if (r.code === 0 && copied && srcIntact
        && /248/.test(r.stdout) && r.stdout.includes(sb.src) && r.stdout.includes(dest)
        && !/replaced/i.test(r.stdout)) {
      pass('CLI copies the PDF byte-for-byte, leaves the source untouched, and prints report + paths');
    } else {
      fail(`CLI happy path wrong: code=${r.code} copied=${copied} srcIntact=${srcIntact}\n${r.stdout}${r.stderr}`);
    }
  });

  withSandbox({}, (sb) => {
    // Given the destination already exists with other content
    const dest = join(sb.dir, 'dest', 'Resume.pdf');
    writeFileSync(dest, 'old resume');
    const r = runExport(['248'], sb);
    if (r.code === 0 && readFileSync(dest).equals(PDF_BYTES) && /replaced/i.test(r.stdout)) {
      pass('CLI overwrites an existing destination and says it replaced it');
    } else {
      fail(`CLI overwrite wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
    }
  });

  withSandbox({}, (sb) => {
    // Given --out relative to the invoking directory, in both flag forms
    const a = runExport(['248', '--out=a.pdf'], sb);
    const b = runExport(['248', '--out', 'b.pdf'], sb);
    const profileDest = join(sb.dir, 'dest', 'Resume.pdf');
    if (a.code === 0 && b.code === 0
        && readFileSync(join(sb.dir, 'a.pdf')).equals(PDF_BYTES)
        && readFileSync(join(sb.dir, 'b.pdf')).equals(PDF_BYTES)
        && !existsSync(profileDest)) {
      pass('CLI --out=<p> and --out <p> write to INIT_CWD-relative paths, not the profile path');
    } else {
      fail(`CLI --out wrong: a=${a.code} b=${b.code}\n${a.stderr}${b.stderr}`);
    }
  });

  withSandbox({}, (sb) => {
    // Given a direct `node export-cv.mjs` run (not via npm) that inherited a
    // stale INIT_CWD from some npm/npx parent process
    const here = join(sb.dir, 'dest');
    const r = runExport(['248', '--out=direct.pdf'], sb, { npm_lifecycle_event: undefined }, { cwd: here });
    // Then --out resolves against the real cwd, not the stale INIT_CWD
    if (r.code === 0 && existsSync(join(here, 'direct.pdf')) && !existsSync(join(sb.dir, 'direct.pdf'))) {
      pass('direct node run resolves --out against cwd, ignoring an inherited INIT_CWD');
    } else {
      fail(`direct-run INIT_CWD wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
    }
  });

  withSandbox({}, (sb) => {
    // Given a direct run that inherited npm_config_out from an unrelated npm parent
    const r = runExport(['248'], sb, { npm_lifecycle_event: undefined, npm_config_out: '/tmp/stale.pdf' });
    if (r.code === 0 && existsSync(join(sb.dir, 'dest', 'Resume.pdf'))) {
      pass('direct node run ignores an inherited npm_config_out');
    } else {
      fail(`direct-run npm_config_out wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
    }
  });

  withSandbox({}, (sb) => {
    // Given npm swallowed `--out=` (typed without the `--` separator)
    const r = runExport(['248'], sb, { npm_config_out: '/tmp/x.pdf' });
    if (r.code !== 0 && /--/.test(r.stderr) && !existsSync(join(sb.dir, 'dest', 'Resume.pdf'))) {
      pass('CLI refuses when npm swallowed --out (no `--`) and writes nothing');
    } else {
      fail(`CLI npm_config_out guard wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
    }
  });

  withSandbox({}, (sb) => {
    // Given --out with no value (trailing flag, or an empty `--out=`)
    const trailing = runExport(['248', '--out'], sb);
    const empty = runExport(['248', '--out='], sb);
    if (trailing.code !== 0 && empty.code !== 0 && !existsSync(join(sb.dir, 'dest', 'Resume.pdf'))) {
      pass('CLI refuses a valueless --out instead of falling back to the profile path');
    } else {
      fail(`CLI valueless --out wrong: trailing=${trailing.code} empty=${empty.code}`);
    }
  });

  withSandbox({ indexPdf: 'src/gone.pdf' }, (sb) => {
    const r = runExport(['248'], sb);
    if (r.code !== 0 && /gone\.pdf/.test(r.stderr)) pass('CLI errors when the indexed PDF is missing on disk');
    else fail(`CLI missing-source wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
  });

  withSandbox({ exportPath: 'no-such-dir/Resume.pdf' }, (sb) => {
    const r = runExport(['248'], sb);
    if (r.code !== 0 && /no-such-dir/.test(r.stderr)) pass('CLI errors when the destination directory does not exist');
    else fail(`CLI missing-dest-dir wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
  });

  withSandbox({ exportPath: 'folder.pdf' }, (sb) => {
    // A directory that happens to end in .pdf gets past the extension check
    mkdirSync(join(sb.dir, 'folder.pdf'));
    const r = runExport(['248'], sb);
    if (r.code !== 0 && /director/i.test(r.stderr)) pass('CLI errors when the destination is a directory');
    else fail(`CLI dest-is-dir wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
  });

  withSandbox({ exportPath: 'dest/notes.md' }, (sb) => {
    // Given a profile typo pointing at an existing non-PDF file
    const notes = join(sb.dir, 'dest', 'notes.md');
    writeFileSync(notes, '# my notes\n');
    const r = runExport(['248'], sb);
    if (r.code !== 0 && readFileSync(notes, 'utf-8') === '# my notes\n') {
      pass('CLI refuses a non-.pdf destination and leaves that file untouched');
    } else {
      fail(`CLI non-.pdf destination wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
    }
  });

  withSandbox({ exportPath: 'src/cv-248.pdf' }, (sb) => {
    const r = runExport(['248'], sb);
    if (r.code !== 0 && readFileSync(sb.src).equals(PDF_BYTES)) pass('CLI refuses to copy the PDF onto itself');
    else fail(`CLI dest-is-src wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
  });

  withSandbox({ exportPath: null }, (sb) => {
    const r = runExport(['248'], sb);
    if (r.code !== 0 && /export_path/.test(r.stderr)) pass('CLI errors when no destination is configured');
    else fail(`CLI no-destination wrong: code=${r.code}\n${r.stdout}${r.stderr}`);
  });

  withSandbox({}, (sb) => {
    const none = runExport([], sb);
    const unknown = runExport(['248', '--force'], sb);
    if (none.code !== 0 && /Usage/.test(none.stdout + none.stderr) && unknown.code !== 0) {
      pass('CLI prints usage with no args and rejects unknown flags');
    } else {
      fail(`CLI usage/unknown-flag wrong: none=${none.code} unknown=${unknown.code}`);
    }
  });
}
