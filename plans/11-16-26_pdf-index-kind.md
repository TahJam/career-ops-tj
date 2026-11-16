# Keep one `data/pdf-index.tsv` row per (report, kind) so a cover letter stops replacing the CV row

> **Status: implemented 2026-11-16** on `fix/pdf-report-kind` → PR #9 into `origin/main` (hashes in
> "Suggested Commit Order"). Tracks [TahJam/career-ops-tj#6](https://github.com/TahJam/career-ops-tj/issues/6).
> `node test-all.mjs` 3036 passed / 1 failed (baseline 3015 / 1; the failure is the pre-existing
> `tests/company-funded.test.mjs` date window). `go test ./...` passes. Live index migrated (116 rows,
> all with `kind`); 094 has its `cv` and `cover` rows. `npm run sheets:sync:dry`: 124 existing, 0 added,
> 0 row updates. No real sheet write.

## Context

`data/pdf-index.tsv` maps a report number to the PDF generated for it. `reconcilePDFManifest`
(`lib/pdf-manifest.mjs`, moved out of `generate-pdf.mjs` by `plans/10-07-26_report-number-as-id.md`)
keeps **one row per report**: when a new PDF is recorded, any row with the same normalized report number
is dropped. A report can have two PDFs, the tailored CV and a cover letter, so whichever is recorded last
replaces the other.

`generate-cover-letter.mjs --report NNN` renders through `renderHtmlToPdf` (`generate-pdf.mjs`), which
calls `updatePDFManifest(reportNum, ...)`, so a cover letter takes over the CV's row. After that:

- `export-cv.mjs NNN` refuses to export (`export-cv.mjs:73-82`). It detects the `-cover.pdf` suffix and
  tells the user to regenerate the CV. This is a workaround, not a fix.
- `find.mjs`, `outcome.mjs`, `merge-tracker.mjs`, `sync-pdf-flags.mjs`, the sheets plugin's résumé
  column, and the dashboard all treat the cover letter as the report's PDF.

**Live instance:** report **094** (Lightspeed Systems). Its only row is
`output/lightspeed-systems-software-engineer-ai-native-cover.pdf`. The CV,
`output/cv-taher-jamali-lightspeed-systems-2026-08-05.pdf`, is still on disk but no row points to it.
This is the only affected row (1 of 115). Every current row has 5 columns.

### Every reader and writer of the index

| Component | Role | How it parses today | Change |
|---|---|---|---|
| `lib/pdf-manifest.mjs` `reconcilePDFManifest` / `updatePDFManifest` | **the one writer** | own `split('\t')` | add `kind`; replace by (report, kind) instead of report; write every row with `kind` |
| `generate-pdf.mjs` `renderHtmlToPdf` | calls the writer | — | pass `opts.kind` through (default `cv`) |
| `generate-cover-letter.mjs` | calls `renderHtmlToPdf` | — | pass `kind: 'cover'` |
| `generate-latex.mjs` `--report` | calls the writer | — | none: the default `cv` applies |
| `mark-pdf-ready.mjs --pdf` (Canva path) | calls the writer | — | none: the default `cv` applies |
| `find.mjs` `parsePdfIndex` | reader; also used by `export-cv.mjs`, `outcome.mjs`, `merge-tracker.mjs` | own parser, keyed by report only | removed; all four read CV rows through the shared parser |
| `export-cv.mjs` | reader | via `parsePdfIndex` | reads the CV row; the `-cover.pdf` refusal is deleted |
| `outcome.mjs` | reader | via `parsePdfIndex` | reads the CV row |
| `merge-tracker.mjs` | reader (PDF ✅ sync) | via `parsePdfIndex` | reads the CV row |
| `sync-pdf-flags.mjs` | reader | own `split('\t')` | shared parser, CV rows |
| `plugins/sheets/_sources.mjs` `resumeNames` | reader | own `split('\t')` | shared parser, CV rows |
| `dashboard/internal/data/pdf.go` `LoadPDFManifest` / `Lookup` | Go reader, by report | own Go parser | reads `kind` (same inference rule); indexes only `cv` rows |
| `dashboard/internal/data/pdf.go` `LoadPDFEntriesByPath` | Go reader, by path (HTML regen lookup) | own Go parser | gains a `Kind` field; still indexes every row |
| `modes/email.md` | the agent reads the TSV by hand | — | doc: the CV is the `cv` row; a `cover` row is a cover-letter attachment |

The dashboard's glob fallback (`ResolvePDFs`) globs `output/cv-*.pdf`, so it never picks up a cover
letter. It needs no change.

## Decisions

### D1. Column: `kind` is appended as column 6

New layout: `report \t pdf \t html \t format \t date \t kind`. Readers that select columns by position
(the Go parser, and the JS parsers until they are replaced) keep working. Values are `cv` or `cover`.

### D2. Legacy rows: read-time default **and** a migrate-on-write

- **Read time.** An empty or missing column 6 is inferred from the path: a basename ending in
  `-cover.pdf` (case-insensitive) is `cover`, and anything else is `cv`. This is the same suffix
  `export-cv.mjs` checks today. `modes/cover.md` names every cover letter `…-cover.pdf`, and the
  generator's default name does too. A non-empty value is lowercased and kept as written. An unknown
  value (a hand edit) is not a CV, so CV readers skip it.
- **Migration.** The writer already rewrites the whole file on every write. It now writes every
  surviving row with an explicit `kind`, using the stored value or the inferred one. The first write after
  this lands migrates the file. No separate migration script is needed. For the live file, that first write
  is the 094 re-record (D6).

### D3. One shared JS parser in `lib/pdf-manifest.mjs`

`lib/pdf-manifest.mjs` is already "the one writer". It becomes the one JS reader as well:

- `normReportKey(s)`: the "008" ≡ "8" rule, which exists today as `normKey` in the writer and `normNum`
  in `find.mjs`. `find.mjs` re-exports it as `normNum`, so tracker callers stay unchanged and the two can't
  drift.
- `inferPDFKind(pdfPath)`: the D2 suffix rule.
- `parsePDFManifest(text)`: returns `[{ report, pdf, html, format, date, kind }]`. It skips blank and
  comment lines and fills `kind` per D2.
- `pdfPathsByReport(text, { kind = 'cv' } = {})`: a `Map` from normalized report number to PDF path, for
  one kind. Rows without a report are skipped, and a later row wins (matching today's `Map.set` and Go
  behavior). This replaces `find.mjs`'s `parsePdfIndex`. Every JS reader calls it: `find.mjs`,
  `export-cv.mjs`, `outcome.mjs`, `merge-tracker.mjs`, `sync-pdf-flags.mjs`, and the sheets plugin.

The Go dashboard can't import JS. It copies the inference rule (`inferPDFKind` in `pdf.go`), and a Go
test pins the same cases the JS test pins.

### D4. `kind` is an optional parameter that defaults to `cv`

- `updatePDFManifest(reportNum, pdfPath, htmlPath, format, kind = 'cv')`
- `reconcilePDFManifest(existingText, { …, kind = 'cv' })`
- `renderHtmlToPdf(html, outputPath, { …, kind = 'cv' })`

Only `generate-cover-letter.mjs` passes a non-default value (`'cover'`). The writer throws on any value
other than `cv` or `cover`, so a typo can't create a row that no reader selects. No CLI flag is added.
`generate-pdf.mjs`, `generate-latex.mjs`, and `mark-pdf-ready.mjs --pdf` only ever record CVs.

### D5. Replacement rules

When an incoming row (report R, kind K, path P) is recorded, an existing row is dropped if:

1. its path is P, whatever its report or kind. The path-collision warning is unchanged and still fires
   when the dropped row belonged to a different report; or
2. its normalized report is R **and** its kind is K. Previously the rule was report R alone.

Rows with no report number are never dropped by rule 2. That is unchanged.

### D6. Report 094 is repaired by re-recording its CV (user data, not committed)

`node mark-pdf-ready.mjs 094 --pdf output/cv-taher-jamali-lightspeed-systems-2026-08-05.pdf`

The command runs with `--dry-run` first. 094's tracker cell is already ✅, so only the index changes. That
write also performs the D2 migration on the live file. The result is two rows for 094: the existing
`cover` row and the re-recorded `cv` row. 094 is Rejected; this repair just keeps the record accurate.

## Steps

1. **Shared parser** (`lib/pdf-manifest.mjs`). Add `normReportKey`, `inferPDFKind`, `parsePDFManifest`,
   and `pdfPathsByReport` (D3). The writer's private `normKey` is replaced by `normReportKey`. Tests in
   `tests/pdf-manifest.test.mjs` cover these cases:
   - a 5-column legacy row and a 6-column row
   - a `-cover.pdf` row inferred as `cover`, and a company name containing "cover" that is not a cover letter
   - zero-padded keys
   - a later row winning
   - an unknown kind excluded from `cv`
2. **Writer keyed by (report, kind)** (`lib/pdf-manifest.mjs`). Add the `kind` parameter (D4), the D5
   rules, 6-column output with every row normalized (D2), and the new header comment. Tests:
   - recording a cover after a CV keeps both
   - re-recording a CV replaces only the CV row
   - legacy rows gain `kind` on rewrite
   - an invalid kind throws
   - the path-collision warning still fires

   Update the `test-all.mjs` manifest fixtures (around line 1424) if they assert exact line contents.
3. **Cover letters are recorded as `cover`.** `renderHtmlToPdf` takes `opts.kind` and passes it to
   `updatePDFManifest`. `generate-cover-letter.mjs` passes `kind: 'cover'`. Test: run
   `generate-cover-letter`, or `renderHtmlToPdf` with its writer seam, against `CAREER_OPS_PDF_INDEX`, and
   check that a `cover` row lands next to an existing `cv` row.
4. **JS readers use the shared parser.** Remove `parsePdfIndex` from `find.mjs` and change `normNum` to a
   re-export of `normReportKey`. Point `find.mjs`, `export-cv.mjs`, `outcome.mjs`, and `merge-tracker.mjs`
   at `pdfPathsByReport(text)`. Update their tests' fixtures. Readers that already pass a `Map` into a pure
   function (`exportCv({ pdfIndex })`, `findMatches`) keep that signature.
5. **Delete the `export-cv.mjs` cover workaround.** Remove the `-cover.pdf` refusal and the `basename`
   import if nothing else uses it. In `tests/export-cv.test.mjs`, the "refuses a cover letter" case
   becomes "exports the CV when a cover row was recorded after it". That case is built from manifest text
   through `pdfPathsByReport`, not from a hand-built `Map`.
6. **`sync-pdf-flags.mjs` and the sheets plugin use the shared parser.** In `sync-pdf-flags.mjs`, the
   `manifestReports` set is built from `pdfPathsByReport` keys, converted to ints as now. In
   `plugins/sheets/_sources.mjs`, `resumeNames()` reads `pdfPathsByReport` and keeps its basename-without-
   `.pdf` output. Tests: a fixture with a `cover` row leaves the report's résumé name and PDF flag as the CV.
7. **Go dashboard.** In `pdf.go`:
   - add `Kind` to `PDFManifestEntry`
   - add `inferPDFKind`
   - one shared line parser for `LoadPDFManifest` and `LoadPDFEntriesByPath`, so the two Go parsers stop
     duplicating each other
   - `LoadPDFManifest` indexes only `cv` rows

   Tests in `pdf_test.go`:
   - a `cover` row after a `cv` row leaves `Lookup` on the CV
   - a legacy `-cover.pdf` row is not returned by `Lookup`
   - `LoadPDFEntriesByPath` returns both rows with their kinds

   Run `go test ./...`.
8. **Docs.**
   - `DATA_CONTRACT.md:38`: list the actual writers and readers, and the (report, kind) rule
   - `modes/pdf.md:312`: "replaces the report's previous **CV**"
   - `modes/email.md:27,75`: the CV attachment is the `cv` row; a `cover` row is a cover-letter attachment
   - `docs/SCRIPTS.md` (export-cv, mark-pdf-ready entries) where they say "the report's PDF"
   - the `lib/pdf-manifest.mjs` header comment

   Keep the `test-all.mjs:2030` assertion that `modes/email.md` mentions `data/pdf-index.tsv` passing.
9. **Repair 094 and migrate the live file** (D6, no commit). Back up `data/pdf-index.tsv` to the job
   scratchpad first. After the write, confirm every row has 6 columns, 094 has one `cv` and one `cover`
   row, and `node find.mjs 094` and `npm run export-cv 094 -- --out=<scratch path>` both resolve the CV.
10. **Sheets dry run** (no commit). Run `npm run sheets:sync:dry` and show you the output. The expected
    result is 0 row updates. No real sheet write.

## Verification

- Baseline: run `node test-all.mjs` on the branch before step 1 and record the counts, including any
  pre-existing failure such as `tests/company-funded.test.mjs` from the referred_by plan.
- Each commit leaves `node test-all.mjs` passing (no new failures against the baseline), and also
  `cd dashboard && go test ./...` for the Go commit.
- End-to-end in a temp `CAREER_OPS_PDF_INDEX`: record a CV for report N, then a cover letter for N.
  Both rows survive, and `export-cv.mjs N` copies the CV.
- Issue "done when" checks:
  - a cover letter with `--report NNN` leaves NNN's CV row in place (steps 2–3)
  - `export-cv.mjs NNN` exports the CV whether or not a cover letter came after it (step 5)
  - every listed reader passes its tests, including Go (steps 4–7)
  - the sheets dry run shows no changes (step 10)
- `node verify-pipeline.mjs`: 0 errors after the live migration.

## Suggested Commit Order

| # | Commit | Step | Files |
|---|---|---|---|
| 0 | `docs(plans): plan per-(report, kind) rows in pdf-index.tsv` ✅ `42ff398` | — | this plan |
| 1 | `feat(lib): add a shared pdf-index parser with kind inference` ✅ `bea975b` | 1 | `lib/pdf-manifest.mjs`, `tests/pdf-manifest.test.mjs` |
| 2 | `fix(lib): keep one pdf-index row per (report, kind)` ✅ `bae4b60` | 2 | `lib/pdf-manifest.mjs`, `tests/pdf-manifest.test.mjs` |
| 3 | `fix(cover-letter): record cover letters as kind cover` ✅ `c58a4bc` | 3 | `generate-pdf.mjs`, `generate-cover-letter.mjs`, `tests/cover-letter-manifest.test.mjs` |
| 4 | `refactor(find): read CV rows through the shared pdf-index parser` ✅ `a6e9859` | 4 | `find.mjs`, `export-cv.mjs`, `outcome.mjs`, `merge-tracker.mjs`, `test-all.mjs`, `tests/outcome.test.mjs` |
| 5 | `fix(export-cv): drop the -cover.pdf workaround` ✅ `7a378ec` | 5 | `export-cv.mjs`, `tests/export-cv.test.mjs` |
| 6 | `refactor(sheets,sync-pdf-flags): use the shared pdf-index parser` ✅ `025eb2c` | 6 | `sync-pdf-flags.mjs`, `plugins/sheets/_sources.mjs`, `tests/sync-pdf-flags.test.mjs`, `tests/sheets-resume-names.test.mjs` |
| 7 | `fix(dashboard): select the CV row by kind in the manifest reader` ✅ `082b5f4` | 7 | `dashboard/internal/data/pdf.go`, `dashboard/internal/data/pdf_test.go` |
| 8 | `docs: describe the pdf-index kind column` ✅ `79fe568` | 8 | `DATA_CONTRACT.md`, `modes/pdf.md`, `modes/email.md`, `modes/cover.md`, `docs/SCRIPTS.md`, `lib/pdf-manifest.mjs` |
| — | *(no commit)* re-record 094's CV, migrate the live index ✅ | 9 | `data/pdf-index.tsv` (gitignored) |
| — | *(no commit)* `npm run sheets:sync:dry` → shown to the user ✅ | 10 | — |
| 9 | `docs(plans): mark the pdf-index kind plan complete` | — | this plan |

## Implementation notes

- **`test-all.mjs` manifest fixtures needed no change in commit 2.** They match on line prefixes
  (`startsWith('144\t')`), so the sixth column didn't break them. `test-all.mjs` changed in commit 4
  instead: the `find.mjs` fixture moved to `pdfPathsByReport` and gained a cover row, and a
  merge-tracker case covers a report whose only indexed PDF is a cover letter.
- **Behaviour change for readers:** a report whose only indexed PDF is a cover letter now has no PDF
  for `find.mjs`, `export-cv.mjs`, `outcome.mjs`, the dashboard, and the sheets résumé column. It also
  gets no ✅ from `merge-tracker.mjs` / `sync-pdf-flags.mjs`. This is intentional, because the PDF column
  means the tailored CV. After the 094 repair, no live report is in that state.
- **Dashboard D key.** A cover row's `html` column holds the cover letter's JSON payload
  (`renderHtmlToPdf`'s `inputPath`), when that payload is inside the repo. Before this change, a cover
  row could reach `LoadPDFManifest`, and the D key would have re-rendered the JSON as CV HTML. Indexing
  only `cv` rows closes that path too.
- **`resumeNames()` gained the `CAREER_OPS_PDF_INDEX` override**, the same one the other readers honor,
  so it can be tested against a fixture. It still skips non-numeric report cells, as before.
- **`outcome.mjs` lookup simplified.** It looked up `padStart(3, '0')` and then the bare number. The
  first lookup could never hit, because keys are normalized. It now does one `normReportKey(num)` lookup.
- **`modes/cover.md` now passes `--report {NNN}` in report mode.** This wasn't in the plan. Before, the
  cover mode never indexed its PDF, so the email mode's new "a `cover` row is the cover-letter attachment"
  line would have had nothing to find. Paste mode drops the flag.
- **Removed export-cv test.** "Accepts CVs named after a Cover… company" guarded the deleted
  `-cover.pdf` refusal. The same rule is now pinned at `inferPDFKind` in both JS and Go.
- **094 repair.** `mark-pdf-ready.mjs 094 --pdf …` recorded the CV with blank `format`, which is
  existing `--pdf` behaviour. The tracker cell was already ✅ and wasn't touched. A diff against the
  backup showed the other 115 rows unchanged apart from the added `kind`.
- **Flaky test seen once.** During commit 4, one run of `test-all.mjs` failed "Check 14 did not pass
  a matching row" (verify-pipeline). `verify-pipeline.mjs` imports nothing this change touches, and the
  next three runs passed. It was not reproduced, so it is not filed.

## Out of scope

- `--report` indexing for LaTeX and Canva CVs, which is already done by `plans/10-07-26_report-number-as-id.md`.
- A `--kind` CLI flag on any generator (D4).
- Surfacing cover letters in the dashboard or `find.mjs` output. The `cover` rows are now kept, so a
  later change can add that.
