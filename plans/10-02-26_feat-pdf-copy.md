# Copy a report's tailored CV PDF to a fixed upload path (`export-cv.mjs`)

> **Status: complete 2026-10-05** on `feat-export-cv` → one PR into `origin/main`. Commits 3 and 4 landed as
> one commit (tests plus implementation), as anticipated. Deviations are under "Implementation notes".

## Request (original notes)

1. A small script, `export-cv.mjs <report#>`. It looks up that report's PDF in `data/pdf-index.tsv` using the existing `parsePdfIndex` from `find.mjs`. It copies the file with `copyFileSync`, which never modifies the original, and prints which report and file it copied so I can check before uploading. If the report has no PDF, it stops with an error. For report 248 it would copy `output/cv-taher-jamali-runpod-248-2026-10-02.pdf` to `../Resume-Taher-Jamali.pdf`.
2. The destination in `config/profile.yml`, as a new setting like `cv.export_path: "../Resume-Taher-Jamali.pdf"`. The file name stays my setting, not hardcoded in a script.
3. An npm script in `package.json` like `"export-cv": "node export-cv.mjs"`. Then I can run `npm run export-cv 248` to copy the PDF to the destination specified in `config/profile.yml`.
    - The script should also be able to accept a outpath path override via command line argument. So, something like: `npm run export-cv {report#}` would use the path in `config/profile.yml`, but `npm run export-cv {report#} -- --out=/tmp/Resume-Taher-Jamali.pdf` would use the path specified in the command line argument.

## Context (investigation, 2026-10-05)

### What already exists

- `find.mjs:85` exports `parsePdfIndex(text)`. It returns a `Map` from a **normalized** report number to the
  root-relative PDF path. The key is normalized with `normNum` (`find.mjs:36`, strips leading zeros), which is
  **not exported**. A lookup for `"0248"` must use the same normalization or it misses.
- `data/pdf-index.tsv` is written only by `generate-pdf.mjs` (`reconcilePDFManifest`, `generate-pdf.mjs:439`).
  That function already keeps **one row per report**: a regenerated PDF replaces the report's previous row. So a
  report number maps to exactly one PDF, the latest one, and export-cv needs no "pick the newest" rule.
- Two index rows have an empty report column (PDFs generated without `--report`). `parsePdfIndex` skips them,
  so those PDFs can't be exported by number. That's correct.
- The index can point at a file that's no longer on disk. For example, `output/` gets cleaned and the index
  doesn't. That case needs its own error message.
- `config/profile.yml` already has a `cv:` block (`output_format`), so `cv.export_path` fits there. The file is
  gitignored (user layer). `config/profile.example.yml:125` is the shipped example (system layer) and should get
  a commented-out line.
- There's no general shared profile loader. `cv-templates.mjs:111` `loadProfileDefault` is specific to template
  kinds. Five scripts read the profile directly with `js-yaml` and honor the `CAREER_OPS_PROFILE` env override
  (`scan.mjs:65`, `followup-cadence.mjs:25`, `cv-templates.mjs:15`, ...). export-cv follows that same pattern.
- Registries a new script must join: `update-system.mjs` `SYSTEM_PATHS` (a repo test fails on unclaimed tracked
  files; `tests/` is already claimed as a prefix), the `docs/SCRIPTS.md` npm table plus a section, and the
  `DATA_CONTRACT.md:38` "read by" list for `pdf-index.tsv`.
- Tests: `tests/**/*.test.mjs` are auto-discovered by `test-all.mjs`. They use `pass`/`fail` from
  `tests/helpers.mjs` and must never call `process.exit`. `tests/mark-pdf-ready.test.mjs` shows the pattern for
  a sandboxed CLI run through env overrides.

### Things the original notes don't cover

1. **npm swallows `--out=` without the `--` separator (verified, npm 11.19.1).**
   `npm run export-cv 248 -- --out=/tmp/x.pdf` → argv `["248", "--out=/tmp/x.pdf"]` ✅
   `npm run export-cv 248 --out=/tmp/x.pdf` → argv `["248"]`. npm consumes the flag and exposes it only as
   `process.env.npm_config_out`. Unhandled, that typo **silently overwrites the profile destination** instead
   of writing to `/tmp`.
2. **Relative paths and cwd.** `npm run` always sets cwd to the repo root (verified). `INIT_CWD` holds the
   directory the command was typed in. `"../Resume-Taher-Jamali.pdf"` in the profile has to resolve the same way
   no matter where it's run from.
3. **The destination already exists.** `../Resume-Taher-Jamali.pdf` is on disk now (230,085 B, Oct 4). Report
   248's PDF is a different file (245,227 B). `copyFileSync` overwrites by default.
4. **Bad destinations:** the parent directory doesn't exist, the destination is a directory, or the destination
   is the source PDF itself.

## Decisions

| # | Question | Recommendation |
|---|---|---|
| D1 | `--out=` swallowed by npm (no `--`) | **Fail loudly** when `npm_config_out` is set: "put `--` before `--out`". Never fall back to the profile path. |
| D2 | Base for relative paths | `cv.export_path` resolves against the **career-ops root**, so it's stable from anywhere. `--out` resolves against **`INIT_CWD`** (where you typed it), then `process.cwd()`. |
| D3 | Destination already exists | **Overwrite** without a prompt, and print `(replaced existing file)` so it's visible. |
| D4 | Bad destinations | Error on: missing parent directory (no `mkdir`), destination is a directory, destination is the source. |
| D5 | Report-number normalization | **Export `normNum` from `find.mjs`** and reuse it rather than copy it (shared logic). |
| D6 | No `cv.export_path` and no `--out` | Error that names both ways to set a destination. |
| D7 | Plan filename | Repo convention is `MM-DD-YY_<slug>.md`, and this file is `10-02-2026_…`. Rename to `10-02-26_feat-pdf-copy.md`? |

**Resolved 2026-10-05:** all recommendations accepted. D1 fail loudly · D2 profile→root, `--out`→`INIT_CWD` ·
D3 overwrite + say so · D4/D5/D6 as written · D7 renamed.

Out of scope: a general shared profile loader (only one more reader is being added, so the existing per-script
pattern stays) and exporting by company name (use `npm run find` first).

## Design

### `export-cv.mjs`

```
node export-cv.mjs <report#> [--out=<path>]
npm run export-cv <report#> [-- --out=<path>]
```

A pure core plus a thin CLI, so the rules can be tested without touching real files:

- `resolveExport({ report, pdfIndex, exportPath, out, root, cwd })` → `{ reportNum, src, dest, destSource: 'profile' | '--out' }`.
  It throws `ExportError` (with a message for the user) for: missing or non-numeric report#, report not in the
  index, and no destination (D6). It's pure: no fs, no env.
- `main()`:
  1. Parse argv (`<report#>`, `--out=<path>` or `--out <path>`, `--help`). Unknown flags are an error.
  2. D1 guard: if `process.env.npm_config_out` is set → error.
  3. Read the index from `CAREER_OPS_PDF_INDEX` or `data/pdf-index.tsv`, and parse it with `parsePdfIndex`.
  4. Read the profile from `CAREER_OPS_PROFILE` or `config/profile.yml` with `js-yaml`, and take `cv.export_path`.
  5. Call `resolveExport` with `root` = the script dir and `cwd` = `INIT_CWD || process.cwd()`.
  6. fs checks: the source exists and is a file (otherwise "index points at a missing file, regenerate with
     `npm run pdf`"). Then the D4 destination checks.
  7. `copyFileSync(src, dest)` and print:
     ```
     Report 248 → copied
       from: output/cv-taher-jamali-runpod-248-2026-10-02.pdf (240 KB)
       to:   <absolute path>/Resumes-Claude/Resume-Taher-Jamali.pdf (replaced existing file)
     ```
  Errors go to stderr with exit code 1. Same `import.meta.url` main guard as `find.mjs`.

`CAREER_OPS_PDF_INDEX` is a new env override, used for tests. Index paths resolve with `resolve(root, p)`, so a
sandbox index can carry absolute tmp paths.

## Steps (test-first)

1. **Branch** `feat-export-cv` from `main`. (Rename the plan per D7, then commit the plan.)
2. **`find.mjs`:** add `export` to `normNum`. No behavior change.
3. **Tests, written first and failing:** `tests/export-cv.test.mjs`
   - Pure `resolveExport`:
     - resolves 248 → its PDF, with dest from the profile resolved against root
     - `"0248"` and `"248"` resolve the same
     - `--out` wins over the profile and resolves against cwd
     - absolute `--out` is kept as is
     - report not indexed → error that names the report
     - no destination → D6 error
     - non-numeric report → error
   - CLI in a tmp sandbox (`CAREER_OPS_PROFILE`, `CAREER_OPS_PDF_INDEX`, `INIT_CWD`):
     - happy path copies bytes identically, leaves the source unchanged (mtime and bytes), and stdout names the report and both paths
     - an existing destination is overwritten and stdout says "replaced"
     - `npm_config_out` set → exit 1 and nothing written
     - index row whose file is missing → exit 1
     - missing destination directory → exit 1
     - destination is a directory → exit 1
     - destination equals the source → exit 1
     - no args → usage and exit 1
4. **Implement** `export-cv.mjs` until the suite passes.
5. **Wire up:** `package.json` `"export-cv": "node export-cv.mjs"`; `update-system.mjs` SYSTEM_PATHS
   `'export-cv.mjs'`; `config/profile.example.yml` commented `# export_path: "../Resume.pdf"` under `cv:`.
6. **Docs:** `docs/SCRIPTS.md` table row plus a `## export-cv` section (covering the `--` gotcha);
   `DATA_CONTRACT.md:38` adds `export-cv.mjs` to the readers; `AGENTS.md` Main Files table row.
7. **User config (gitignored, no commit):** set `cv.export_path: "../Resume-Taher-Jamali.pdf"` in
   `config/profile.yml`.
8. **Verify:** `node test-all.mjs`. Then `npm run export-cv 248 -- --out=<scratch>/x.pdf` and `cmp` it against the
   source. Then the real `npm run export-cv 248` **only on your go-ahead**, since it replaces your current
   `../Resume-Taher-Jamali.pdf`.

## Suggested Commit Order

| # | Commit | Files |
|---|---|---|
| 1 `ef45b7e` | `docs(plans): plan export-cv for copying a report's CV PDF` | plan (user's file, no trailer) |
| 2 `63bfc44` | `refactor(find): export normNum for reuse` | `find.mjs` |
| 3 → 4 | `test(export-cv): cover report lookup, destination rules, and CLI guards` | `tests/export-cv.test.mjs` (fails until 4, so squash with 4 if every commit must stay green) |
| 4 `99ed3c3` | `feat(export-cv): copy a report's tailored CV PDF to a configured path` | `export-cv.mjs`, `package.json`, `update-system.mjs` |
| 5 `6683474` | `docs: document export-cv and cv.export_path` | `docs/SCRIPTS.md`, `DATA_CONTRACT.md`, `AGENTS.md`, `config/profile.example.yml` |
| 6 | `docs(plans): record export-cv implementation` | plan |

Since each commit has to leave `test-all.mjs` passing, commits 3 and 4 will most likely be **one commit** (tests
plus implementation).

## Implementation notes

- **The test-first step caught one gap the plan missed.** A trailing `--out` with no value parsed as
  `undefined`, so it silently fell back to the profile path, the same failure D1 guards against. A
  "valueless `--out`" test was added (it went red), then the fix: `args[++i] ?? ''` hits the empty-path error.
- **The source date was dropped from the output line.** `parsePdfIndex` returns only the path, and the date is
  already in the CV filename. The line prints size only.
- **Personal-data test:** the plan's sample output first contained a literal home-directory path, which
  `test-all.mjs` flags as an absolute path. It was replaced with `<absolute path>` and squashed into commit 1.
- **A pre-existing failure, unrelated to this branch:** `test-all.mjs:2730` ("batch prompt CV filenames must
  carry {{REPORT_NUM}}") fails on `main` too. `batch/batch-prompt.md` no longer contains the
  `output/cv-candidate-{company-slug}-{{REPORT_NUM}}.html` string the test asserts, most likely since `f0e76ac`.
  It's left for its own fix. The suite is otherwise green (2947 passed).
- **User config (gitignored):** `config/profile.yml` `cv.export_path: "../Resume-Taher-Jamali.pdf"` is set.
- **Verified live:** `npm run export-cv 248 -- --out=<scratch>/x.pdf` produced a file identical to the source
  (`cmp`). The no-`--` form refused with exit 1. Report 9999 refused with exit 1. The real
  `../Resume-Taher-Jamali.pdf` hasn't been overwritten yet: that's the user's call.

## Follow-up: user-facing and agent docs (2026-10-05)

| Commit | Files |
|---|---|
| `12686bd` docs: surface export-cv in the README, customization guide, and profile example | `README.md` (Features row and an "Upload-ready CV copy" block under Usage), `docs/CUSTOMIZATION.md`, `config/profile.example.yml` (the user's `{candidate-name}` example) |
| `3562eff` feat(modes): offer export-cv after PDF generation and on resume uploads | `modes/pdf.md` Post-generation, `modes/apply.md` upload fields, and an `AGENTS.md` Skill Modes routing row. Every path asks before running, since the copy replaces the destination |

- **Tilde gotcha:** neither zsh nor bash expands `~` in `--out=~/x.pdf`, though both expand it in `--out ~/x.pdf`.
  The docs use the space form for `~` paths. An unexpanded `~` fails loudly ("destination directory … does not
  exist") and never writes anywhere unexpected.
- **Left out on purpose:** the `.claude/skills/career-ops/SKILL.md` menu (it lists only `/career-ops` modes, and
  export-cv is an npm script) and `CHANGELOG.md` (generated by the release tool).

## PR #5 review round (2026-10-05)

The review (https://github.com/TahJam/career-ops-tj/pull/5#pullrequestreview-5418275529) left 9 comments.
Fixed in `87a94d7`, test-first (5 new checks, 25 total):

- **[1] Cover letter exported as the resume.** `generate-cover-letter.mjs --report NNN` writes a report-keyed
  manifest row, and `reconcilePDFManifest` keeps one row per report, so the cover letter replaces the CV's row.
  The local index already had one (report 094). export-cv now refuses an indexed `*-cover.pdf` (the naming both
  the generator and `modes/cover.md` use) and says to regenerate the CV with `--report=NNN`. It matches the
  suffix only, so a company like "Cover Genius" and un-prefixed CVs (reports 183/184) still export. **The root
  cause (cover letters taking the CV's manifest row) is unfixed** and also affects `find.mjs` and the dashboard.
  It's a candidate for its own PR.
- **[2] Non-PDF destination overwritten.** `resolveExport` now requires a `.pdf` extension (any case) for both
  `cv.export_path` and `--out`. The "destination is a directory" test now uses a directory named `folder.pdf`,
  since a plain directory name is refused earlier.

Fixed in `e652fe6`, test-first (2 new checks plus a tightened one, 27 total):

- **[3] Inherited npm env.** `INIT_CWD` and `npm_config_out` are now honored only when
  `npm_lifecycle_event === 'export-cv'`, so a direct `node export-cv.mjs` run resolves `--out` against its real
  cwd. The test helper simulates `npm run` by default (`npm_lifecycle_event` + `INIT_CWD`). Verified live: a
  relative `--out` from another directory under `npm --prefix … run export-cv` still lands in the typing
  directory.
- **[7] Hint syntax.** The no-indexed-PDF error now gives `node generate-pdf.mjs <cv.html> <cv.pdf> --report=N`.

Not fixed, by the user's call (low impact): [4] `~` not expanded, [5] raw stack trace on copy I/O errors,
[6] case-alias same-file guard, [8] `--out=true` message, [9] `normNum` duplicated in `generate-pdf.mjs` and
the spacing nit.
