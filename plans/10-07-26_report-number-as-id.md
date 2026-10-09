# Use the report number as the application ID everywhere a name is accepted today

> **Status: implemented 2026-10-09** on `feat/report-number-as-id` (25 commits plus this record; hashes in "Suggested
> Commit Order"). `node test-all.mjs` 2979 passed / 0 failed (was 2954 / 1 on `main`), `go test ./...`
> clean, `verify-pipeline.mjs` 0 errors on a copy of the real data. Not yet pushed or opened as a PR.
> The Snorkel prep-file rename is a user-data step for after the merge. Deviations from the plan as
> written are recorded under "Implementation notes".

## Context

Many career-ops entry points identify an application by **company name**, **role title**, or a
**company slug**, for example `/career-ops cover {slug}`, `set-status.mjs <company>`, and
`interview-prep/{company-slug}-{role-slug}.md`. That worked when each company had one or two rows. It
doesn't anymore:

| Company | Tracker rows |
|---|---|
| Vercel | 20 |
| Perplexity | 18 |
| Deepgram | 18 |
| Sierra | 16 |
| Hightouch | 11 |
| Anthropic, Airtable | 8 each |
| Microsoft, Meta | 6 each |
| Amazon | 5 |

Report filenames are `{NNN}-{company-slug}-{YYYY-MM-DD}.md`, and the slug is **company only**. So
"find the report by slug" matches all 20 Vercel reports. A name used as a selector is a search query,
not an identifier.

**The report number already works as a unique ID.** I checked `data/applications.md` (243 rows):

- Every row links a report. No row lacks one.
- For every row, tracker `#` equals report number. No mismatches.
- No two rows share the same company and role.

`reserve-report-num.mjs` allocates report numbers atomically, and the CV collision fix
(`plans/09-08-26_fix-cv-filename-collisions.md`) already keys CV filenames on it. This plan finds every
remaining place that takes a name instead.

> **One number space (decided).** Upstream treats tracker `#` and report `#` as two counters that drift
> apart once a row exists without a report (`set-status.mjs:25-41`). This fork collapses them: a bare
> number means the report number everywhere, and `verify-pipeline.mjs` / `merge-tracker.mjs` enforce
> `# == report #` on every row (Step 1). With that rule enforced, data files keyed on the tracker `#`
> (`data/follow-ups.md` `appNum`, `data/status-log.tsv`, `data/salary-observations.tsv`,
> `data/contacts.tsv`) are already keyed on the report number and need no migration.

### How to read the tables

The fourth column starts with a verdict:

- **CHANGE**: a name is used to select an application, or a name-keyed path can collide. It moves to the
  report number.
- **ALREADY-ID**: it already takes a number. At most a label or doc tweak.
- **KEEP**: the name is the actual input (an email, a live form, a pasted JD, a per-company aggregate),
  so no report number exists at the point of entry, or none is wanted.
- **LOW**: name-based, but a collision is unlikely or harmless. Optional.

**The selector rule (decided):** any argument that *selects an existing application* must be a report
number. A name is never resolved to a row, not even as a fallback. When the user gives a name, the agent
may run `node find.mjs "<name>"` and show the matching rows, then waits for the user to give the number.
It never acts on the name itself. Inputs that are inherently names (KEEP rows) are not selectors and are
unaffected.

---

## 1. User-facing commands (modes)

| Function / command | Location | What it does | Keep / what it takes to change |
|---|---|---|---|
| `/career-ops cover {slug}` | `modes/cover.md:5`, `:344-350`; menu `.claude/skills/career-ops/SKILL.md:126` | Loads the report's `## Cover Letter Draft` as a starting point, then finishes the letter and PDF | **CHANGE.** "Find the matching report by slug" (`:346`) matches every report for the company. Becomes `/career-ops cover {NNN}`, which loads `reports/{NNN}-*.md`. A slug or name gets the selector rule (show `find.mjs` matches, wait for the number). The pasted-JD form (no report) is unchanged. Update every hint that tells the user to run it: `modes/oferta.md:441`, `:457`, `:489`, `modes/pdf.md:320`, `SKILL.md:126`. |
| `/career-ops pdf {company-slug}` | Not defined in `modes/pdf.md`. Only appears as a hint in `modes/pipeline.md:40`, `:42` and `batch/batch-prompt.md:337`, `:401` | The text written into every sub-threshold report's `**PDF:**` header, telling the user how to generate the CV on demand | **CHANGE.** `pdf.md` has no invocation section, so the agent guesses which report `{company-slug}` means. Add an invocation contract (`/career-ops pdf {NNN}`) to `pdf.md`, and change the four hint sites to `/career-ops pdf {{REPORT_NUM}}` / `{NNN}`. The step-20 `--report` value then comes straight from the argument. Existing reports keep the old hint text (user layer; leave them). |
| `/career-ops email {report-number-or-slug}` (plus the `stuck` / `noshow` variants) | `modes/email.md:24`, `:43`, `:51`; hint `:29` | Drafts an application email from a report | **CHANGE (small).** Drop the slug form: `/career-ops email {NNN}`. A slug or name gets the selector rule. The pasted-JD form (`:31`) is unchanged. Change the `:29` hint `/career-ops pdf {slug}` to `{NNN}`. |
| `interview-prep`: input "Company name and role title (required)" | `modes/interview-prep.md:19` | Builds the company+role interview intel kit | **CHANGE.** **Report #** is the required input when a report exists; company, role, archetype, and gaps are read from it. Company+role stays only for the "URL entry, never evaluated" path (`:49-56`), since no report exists there. That path's "no matching report exists for that company+role" check (`:56`) becomes: run `find.mjs`, and if rows match, show them and ask whether one of them is this role. |
| `interview-prep` auto-trigger: "heard back from {company}" | `modes/interview-prep.md:7-11` | When a reply arrives, matches it to a tracker row, sets `Interview`, and offers prep | **KEEP for the input; CHANGE the write.** The user's message names a company, and `invite-match.mjs` returns ranked row numbers that the user confirms. That is the selector rule, not a name fallback. Step 2 becomes `set-status.mjs N Interview` with the confirmed number, and step 3 passes the same number into the prep run. |
| `interview-prep` output file `interview-prep/{company-slug}-{role-slug}.md` | Written at `modes/interview-prep.md:317`; read at `:35`, `modes/apply.md:174`, `modes/interview/plan.md:77`, `:154`, `:166`, `modes/interview/practice.md:28`, `modes/interview/debrief.md:163`, `modes/interview-redflag.md:16`, `modes/interview/README.md:32` | The per-application prep file every interview mode reads and appends to | **CHANGE.** Rename to `interview-prep/{NNN}-{company-slug}-{role-slug}.md` and have readers glob `{NNN}-*`. Nine reference sites. The one existing file is renamed in Step 6. Prep for a never-evaluated role (no report) keeps the unnumbered name until it is evaluated. |
| `interview/plan`, `interview/practice`, `interview/debrief` | Inputs at `modes/interview/plan.md:7-13`, `practice.md:7-11`, `debrief.md:15-18` | Prep plan, mock interview, and post-round debrief | **CHANGE (input only).** These take a JD or round type and never identify the application. Add a **report #** input: when the session is for a tracked application, it is required (ask for it under the selector rule), and the mode opens the prep file by `{NNN}-*` and reads the report for JD and context. Practice with no application, and prep for a never-evaluated role, keep working without one. |
| Session transcripts `interview-prep/sessions/{company-slug}-{role-slug}-{round}-{YYYY-MM-DD}.md` | Written at `modes/interview/debrief.md:196`, `practice.md:136`; contract in `interview-prep/sessions/README.md:13-25`; parsed by `modes/interview-redflag.md:23`, `:40`, `:81` | One machine-readable file per interview round | **CHANGE (additive).** Add a `report: NNN` front-matter field and an `{NNN}-` filename prefix when a report exists (practice-only sessions keep `practice`). `weekly-digest.mjs:123-146` reads front matter, not the filename, so it isn't affected. `interview-redflag`'s Step 2b role gate (`:81`) compares `report:` instead of role slugs parsed from filenames, which removes the "ambiguous slug → skip" case. No existing session files, so nothing to rename. |
| `interview-redflag` company-level output `interview-prep/{company-slug}-redflags.md` | `modes/interview-redflag.md:135`; linked from `modes/oferta.md:418` | Aggregates interviewer-side red flags across all rounds at a company | **KEEP.** Aggregating per company is the point ("is this company safe to join?"). One file per company is correct. |
| `apply` Step 2: "Search in `reports/` by company name" | `modes/apply.md:128-131` | Matches a live application form to its evaluation report | **CHANGE.** The input is a live form, so the agent still reads company and role off the page, but no longer greps reports by name. First match the form or page URL against each report's `**URL:**` header (an exact key, unique per posting). If that finds nothing, run `find.mjs "<company>"`, show the rows, and ask for the number before loading Section H answers. |
| `apply` Step 9: `set-status.mjs <report#> Applied` | `modes/apply.md:229` | Marks the row Applied | **ALREADY-ID once Step 2 lands.** A bare number becomes the report number, so this call is correct as written. Only the `<report#>` placeholder wording stays. `:230` (`followup-seed.mjs {num}`) is the same number. |
| `/career-ops outcome` (mode wrapper) | `modes/outcome.md:22`, `:41`, `:46` | Records an outcome and archives artifacts | **CHANGE.** Mirrors `outcome.mjs`: selector becomes `<NNN>` only. Update together with it (section 2). |
| `/career-ops offer-prep` and `offer-prep reply {company-slug}` | `modes/offer-prep.md:51-56`; storage `data/offers/{company-slug}/` at `:69`, `:89`, `:287`, `:340`, `:366` | Reads an offer or contract and drafts a negotiation reply | **CHANGE.** `offer-prep reply {company-slug}` selects an existing application, so under the selector rule it becomes `offer-prep reply {NNN}`, and storage moves to `data/offers/{NNN}-{company-slug}/` to match. The first-run inputs (pasted contract or file path) are unchanged; the mode asks for the report number before writing `data/offers/`. `data/offers/` is empty, so nothing to rename. |
| `reply-watch` Step 3: "interview-prep kit for {company}" | `modes/reply-watch.md:77` | After an `→ Interview` update, offers prep | **CHANGE (doc only).** `reply-watch.mjs` already writes by row number (`:149-201`). Pass that number into the interview-prep offer instead of the company name. |
| `followup` → `/career-ops contacto {company}` | `modes/followup.md:111` | Suggests finding a contact before following up | **KEEP.** Contacts belong to a company or team, not an application. A row ID can go in contacto's `tracker#` column (`modes/contacto.md:68`). |
| `followup` / `oferta` → `company-history.mjs --company <company>` | `modes/followup.md:130`, `modes/oferta.md:386` | Pulls the per-company responsiveness card | **KEEP.** The card aggregates every application at that company. Company is the right key. |
| `deep` prompt `[Company] — [Role]` | `modes/deep.md:8-10` | Builds a research prompt | **KEEP.** It produces prompt text, touches no files, and selects nothing. Optional: accept `{NNN}` and fill in company and role from the report. |
| `contacto` | `modes/contacto.md:19-25` | Finds people at a company via web search | **KEEP.** It searches the outside world, so it needs a company name. |
| `prep <company>` | `modes/_custom.md:50`, `_custom.template.md:40` | — | **Not active.** It's an example inside an HTML comment. Ignore. |

## 2. Scripts (CLIs)

| Function / command | Location | What it does | Keep / what it takes to change |
|---|---|---|---|
| `set-status.mjs <report#\|company> <state> [--role]` | Usage `set-status.mjs:11`, `:87-106`; company path `:282-298`; numeric path `:254-280`; mismatch guard `:331-380` | Canonical tracker status and notes write | **CHANGE.** New usage: `set-status.mjs <NNN> <state> [--note] [--on] [--dry-run] [--json]`. A bare number is the report number (Step 2's shared resolver). Remove the company selector, `--role`, `--row`, `--report`, the report-link mismatch guard, and `--force`: they exist only because names were accepted and the two counters could diverge, and Step 1's rule makes divergence impossible. About 28 assertions in `set-status-tests.mjs` cover the guard and `--force`; rewrite or delete them. Update every caller and doc: `AGENTS.md:94`, `:338`, `docs/SCRIPTS.md:841`, `:862`, `modes/tracker.md:32`, `modes/interview-prep.md:10`, `modes/apply.md:229`, `modes/patterns.md:107`, `outcome.mjs:385-395`. |
| `outcome.mjs <report#\|company> <type> [--role]` | Usage `outcome.mjs:7`, `:70-73`; selector `:166-193`; set-status call `:385-395` | Records an outcome, archives CV, cover letter, and posting, then calls set-status | **CHANGE.** The most collision-prone script today: the company fallback is a two-way **substring** match (`:176`, so "AI" matches many companies), and it calls set-status with **`--force`** (`:385-392`). New usage: `outcome.mjs <NNN> <type> [...]` through the shared resolver. Remove the company path, the substring fallback, and `--role`. Call `set-status.mjs N <state>` without `--force`. |
| `find.mjs <query>` | `find.mjs:4-19`; examples `docs/SCRIPTS.md:634-637` | Read-only lookup: resolves a number, company, or role fragment to report #, tracker #, and PDF | **KEEP (and promote).** The one sanctioned way to turn a name into a number. It shows every match and picks none. The selector rule points to it. Also home of the shared resolver (Step 2). Its numeric query matches both the `#` column and the report link, which is the same number under Step 1. |
| `tracker.mjs query --company --role` | `tracker.mjs:27`, `:399-402`; docs `docs/SCRIPTS.md:611` | `LIKE` filter over the SQLite index | **KEEP.** A read-only search that is supposed to return several rows, so it is not a selector. It already has `--id N`. (`delete --num N` at `:502` is already an ID.) |
| `invite-match.mjs` | `invite-match.mjs:1-21` | Pulls the company out of a pasted invite email and ranks tracker rows | **KEEP.** The input is an email, which contains no report #. It returns ranked row numbers for the user to confirm. |
| `reply-matcher.mjs` `checkCompanyMatch` | `reply-matcher.mjs:24-45` | Matches reply emails to rows by company, role, and domain | **KEEP.** Email input. Its output is already keyed by row number (`reply-watch.mjs:149`, `:243-269`), and updates need user confirmation. |
| `company-history.mjs --company "<name>"` | `company-history.mjs:38`, `:83-93`, `:163` | Per-company evidence card (responsiveness, reposts, follow-ups) | **KEEP.** Company is the aggregation key, not a row selector. Optional: `--report N` that looks up the company itself. |
| `assessment-log.mjs add --company <name> [--report <num>]` | `assessment-log.mjs:21`, `:146`; docs `docs/SCRIPTS.md:309` | Logs a skills-assessment event | **CHANGE (small).** `--report N` becomes the way to tie an assessment to an application; the company is read from the tracker. `--company` stays only for an assessment with no application (it is a data field there, not a selector). Passing both is an error. |
| `archive-posting.mjs <url> --company --role` | `archive-posting.mjs:11`, `:42-49`, `:81-88`; filename `:237`, `:294` | Saves a posting as a PDF to `jds/{date}_{company}_{role}.pdf` | **LOW.** `--company`/`--role` only override the saved filename; they select nothing. Optional `--report N` that prefixes `{NNN}_`, so `outcome.mjs:321` can pass the ID it already has instead of rebuilding the filename (`:327`). |
| `application-artifacts.mjs --report N --company --role` (`npm run application:init`) | `application-artifacts.mjs:37`, `:105-126`; `modes/pdf.md:7`; `docs/SCRIPTS.md:37` | Creates the versioned per-application artifact bundle | **CHANGE (small).** Already collision-proof (key `{NNN}-{company}-{role}`), but a caller can pass names that don't match the report. Drop `--company`/`--role` and read both from the tracker row for `--report N`. Update `modes/pdf.md:7` and `docs/SCRIPTS.md:37`. |
| `match-star.mjs "<question>" --jd <path>`, `jd-skill-gap.mjs <jd-path>` | `match-star.mjs:10-14`, `jd-skill-gap.mjs:23-26` | STAR-story matching and JD skill-gap check | **KEEP.** They take a file path, not a name. |
| `salary-gap.mjs --stated-for <tracker#>`, `followup-seed.mjs <appNum>` | `salary-gap.mjs:26`, `:673`; `followup-seed.mjs:31` | — | **ALREADY-ID.** Relabel `<tracker#>` / `<appNum>` to the report number in usage text. Same number under Step 1, so no logic or data change. |
| `export-cv.mjs <report#>`, `mark-pdf-ready.mjs <report#>`, `generate-pdf.mjs --report=NNN`, `generate-cover-letter.mjs --report NNN` | `export-cv.mjs:14`; `mark-pdf-ready.mjs:14`; `generate-pdf.mjs:7`; `generate-cover-letter.mjs:195` | — | **ALREADY-ID.** |
| `process-quality.mjs`, `weekly-digest.mjs`, `analyze-patterns.mjs` | `process-quality.mjs:20-23`, `weekly-digest.mjs:123`, `:191` | Per-company aggregate reports | **KEEP.** Aggregation by company is the purpose. They take no selector. |

## 3. Internal lookups and joins keyed on names (no user argument, same collision class)

| Function / command | Location | What it does | Keep / what it takes to change |
|---|---|---|---|
| Dashboard PDF fallback `matchesCompanySlug` | `dashboard/internal/data/pdf.go:186-219` | When `pdf-index.tsv` has no row for an application, globs `output/cv-*.pdf` by company slug | **CHANGE.** For a multi-role company it attaches the same newest CV to every row that has no manifest entry. Match the `-{NNN}` segment first. That works for both the new `cv-{company-slug}-{NNN}` names and the current `cv-{candidate}-{company}-{NNN}-{date}` names. Keep the company-slug match as the fallback for legacy files without a number, so old CVs still resolve (decision: they stay as they are). The `cv-*` glob already matches the new convention (section 5). The two `taherjamali-vercel-183/184-…` files don't match it, but both have `pdf-index.tsv` rows, which are checked first. New names carry no date, so `sortPDFsNewestFirst` falls back to file mtime for them; that's fine. |
| Dashboard `ResolveHTML` (the `D` regenerate hotkey) | `dashboard/internal/data/pdf.go:267-290` | Finds the HTML to regenerate a PDF from | **CHANGE.** Same company-slug glob, newest file wins, so for Vercel it can regenerate **another role's** CV. Same fix as above, with the same legacy fallback. |
| Dashboard `enrichAppURLsByCompany` | `dashboard/internal/data/career.go:385-460` | Fills in a missing job URL from `batch/batch-input.tsv` by company, choosing the best word-overlap role | **CHANGE.** With several rows at one company and no role overlap, it falls back to `matches[0]`: a wrong URL, shown silently. Every report has a `**URL:**` header, so read it by report number and drop this fallback. |
| Sheets plugin `joinKey(company, role)` | `plugins/sheets/_reconcile.mjs:19-27`, `:100`, `:117` | Joins tracker rows to Google Sheet rows | **KEEP, no changes (decided).** Investigated against the switch; nothing breaks. Rows are joined by company + role, not by number. Report facts come from the Report cell, falling back to the row number (`index.mjs:118`), and both give the same report. Apply dates are read from `status-log.tsv` by tracker `#` (`_sources.mjs:35`), which is the report number under Step 1. Only status and location are rewritten on existing rows (`_reconcile.mjs:51`); the resume column is written once, when a row is added, so leaving old CV files alone keeps the sheet's resume cells valid. A role-title edit in the tracker would add a duplicate sheet row, but that is rare and usually means a different role that deserves its own row anyway (decided: not a concern). |

## 4. Artifact paths keyed on names (looked up by name later)

| Function / command | Location | What it does | Keep / what it takes to change |
|---|---|---|---|
| Cover letter payload `/tmp/cover-payload-{company-slug}.json` | `modes/cover.md:321`, `:325` | Temporary render payload, written in one step and read in the next | **CHANGE.** The same defect the CV plan fixed for `/tmp/cv-*.json`: two cover letters at one company within a session overwrite each other, and the second render can carry the **other role's content**. Use `/tmp/cover-payload-{company-slug}-{NNN}.json`. |
| Cover letter PDF `output/{company-slug}-{role-slug}-cover.pdf` | `modes/cover.md:315` | Final cover letter | **CHANGE (low cost).** The one CV-like artifact without `{NNN}`. Use `output/{company-slug}-{role-slug}-{NNN}-cover.pdf`. The existing `lightspeed-systems-…-cover.pdf` stays as is. |
| JD scratch file `jds/{slug}.md` | `modes/pdf.md:14` | JD saved for `jd-skill-gap.mjs` | **LOW.** A same-title repost would overwrite. Optional: the post-evaluation write in `pdf.md` becomes `jds/{NNN}-{company}-{role}.md`. `pipeline.md` writes JDs before a report number exists, so that path can't change. Existing files stay (they are referenced as `local:jds/…`). |
| Legacy CV files in `output/` without `{NNN}` (~50, e.g. `cv-candidate-perplexity-2026-09-02.pdf`) | `output/`; referenced from report `**PDF:**` headers, `data/pdf-index.tsv`, one tracker note (row 275) | Tailored CVs generated before the CV collision fix | **KEEP (decided).** Not renamed. They don't collide with new `{NNN}` names and stay reachable through `pdf-index.tsv` and the dashboard's legacy fallback (section 3). The Perplexity file is shared by reports 141, 144, and 145 and couldn't take one number anyway. |
| Reports, outcomes | `reports/{NNN}-…`, `data/outcomes/{num}_…` (`outcome.mjs:12`) | — | **ALREADY-ID.** |
| Tailored CVs | `output/cv-{candidate}-{company}-{NNN}…` today | — | **ALREADY-ID**, and renamed by section 5. |

## 5. CV filename convention (decided 2026-10-09)

**One format everywhere: `output/cv-{company-slug}-{NNN}.{html,pdf}`.** The `{candidate}` segment goes:
a career-ops instance belongs to one person, so it tells files apart from nothing. The date goes too:
the report number already makes the name unique, and the date is in the report. A clean
application-ready name is `export-cv.mjs`'s job (`cv.export_path` / `--out`), not the working
filename's.

Derived names:

| Artifact | Name |
|---|---|
| HTML CV | `output/cv-{company-slug}-{NNN}.html` |
| PDF CV | `output/cv-{company-slug}-{NNN}.pdf` |
| Render payload | `/tmp/cv-{company-slug}-{NNN}.json` |
| LaTeX source and PDF | `output/cv-{company-slug}-{NNN}-latex.{tex,pdf}`. The suffix is needed: without it, a LaTeX PDF for a report would overwrite that report's HTML-pipeline PDF. |
| Canva export | `output/cv-{company-slug}-{NNN}-canva.pdf` |
| One-off CV with no report | `output/cv-{company-slug}.{html,pdf}` (unchanged rule: only when there is no report and no tracker row) |
| Bundle paths (`cv/tailored/vNNN/cv.{html,pdf}`) | Unchanged. Already keyed on the report number. |

Dropping the date means regenerating a report's CV replaces the previous PDF instead of adding a
second, dated one. That matches "one CV per report", and `pdf-index.tsv` already keeps one row per
report. If a CV has already been sent and a changed version is needed, the bundle path
(`application-artifacts.mjs`, versioned `v001`, `v002`, …) is the place for that.

Every site that spells the CV filename today:

| Function / command | Location | What it does | Keep / what it takes to change |
|---|---|---|---|
| Batch worker CV paths | `batch/batch-prompt.md:417`, `:422-423`, `:427` | Where batch workers write the HTML and PDF | **CHANGE.** `{candidate-name}-{company-slug}-{{REPORT_NUM}}` → `cv-{company-slug}-{{REPORT_NUM}}`. Delete the `{candidate-name}` note at `:427`. |
| Batch report `**PDF:**` header template | `batch/batch-prompt.md:337` | The path recorded in each batch report | **CHANGE.** It still says `cv-candidate-{company-slug}-{{REPORT_NUM}}-{{DATE}}.pdf`, which no longer matches what step 11 writes (since `f0e76ac`). Workers have been writing the real path anyway: reports 183, 265, 270, and 278 all agree with `pdf-index.tsv`. Make the template say `cv-{company-slug}-{{REPORT_NUM}}.pdf` so the two match by construction. |
| pdf mode | `modes/pdf.md:39`, `:40`, `:44`, `:49-53`, `:223`, `:294`, `:299` | Interactive and `batch-tailor.mjs` CV generation | **CHANGE.** Payload, HTML, PDF, preview, and Canva paths to the table above. Keep the "never drop `{NNN}`" warning. |
| latex / latex-tex modes | `modes/latex.md:17-20`; `modes/latex-tex.md:38`, `:57-58`, `:61` | LaTeX CV generation | **CHANGE.** To `cv-{company-slug}-{NNN}-latex.{tex,pdf}`. `latex-tex.md:38`'s `/tmp/cv-slots-{company}-{NNN}.json` is already in the right shape. Both modes pass `--report={NNN}` to `generate-latex.mjs` (row below). |
| `generate-latex.mjs` has no `--report` | `generate-latex.mjs` (no manifest write anywhere in the file) | Validates and compiles a `.tex` CV to PDF | **CHANGE.** LaTeX PDFs never reach `data/pdf-index.tsv`, so `export-cv.mjs <NNN>` fails with "no PDF" for a LaTeX-only report, and for a report that also has an HTML CV it silently exports the HTML one. Add `--report=NNN`, which records the PDF through the same manifest function `generate-pdf.mjs` uses (`reconcilePDFManifest` / `updatePDFManifest`, `generate-pdf.mjs:439`) so the collision warning applies too. With one row per report, "the CV for a report" is the last one generated, whichever tool made it. That is the intended meaning, and `export-cv.mjs` needs no change. |
| Canva export has no manifest write | `modes/pdf.md:294-299` | `curl` download of the Canva-rendered PDF | **CHANGE.** Same gap as LaTeX. After the download, record the PDF for the report. Use whichever entry point Step 7 settles on (a small `--record-only` path in `generate-pdf.mjs`, or reusing `generate-latex.mjs`'s new code), so it isn't a third copy of the manifest logic. |
| `generate-pdf.mjs` collision warning | `generate-pdf.mjs:496` | Tells the user how to name files after a manifest collision | **CHANGE (text).** `cv-{candidate}-{company}-{NNN}...` → `cv-{company-slug}-{NNN}`. |
| `export-cv.mjs` header comment | `export-cv.mjs:6-8` | Explains where tailored CVs live | **CHANGE (comment).** It reads the source path from `pdf-index.tsv`, never from a name pattern, so its logic works with old and new names, and with `-latex` / `-canva` once those are indexed (rows above). A cover letter generated with `--report` still replaces the CV's index row, and `export-cv.mjs:73-81` refuses to export it. A type column in the index would fix that; it is out of scope here and tracked in [TahJam/career-ops-tj#6](https://github.com/TahJam/career-ops-tj/issues/6). |
| Web backend PDF path | `web/src/lib/pdf-paths.mjs:26`, `:64-87`; tests `web/tests/lib/pdf-paths.test.mjs:96`, `:112`, `:144` | Where the web UI renders the final PDF | **CHANGE.** Today `output/cv-{candidate}-{company}-{date}.pdf`, built from `profile.candidate.full_name`. It also has **no report number**: the same collision class the CV plan fixed. Drop the candidate slug. Whether the web flow has a report number to use needs checking at implementation time; if it doesn't, it is a one-off and gets `cv-{company-slug}.pdf`, which still collides across same-company runs, so it should be given one. |
| CV path regression tests | `test-all.mjs:2722-2731`, `:2737-2747`, `:2750-2760` | Prompt-shape guards from the CV collision fix | **CHANGE.** Update the expected strings to the new format and keep the "must contain `{NNN}`" intent. From reading it, the batch-prompt assertion at `:2723-2724` looks for `output/cv-candidate-{company-slug}-{{REPORT_NUM}}.html`, which `batch-prompt.md` no longer contains since `f0e76ac`, so that test probably fails today (not run). Add a guard that no system file spells `{candidate}` or `{candidate-name}` in a CV path. |
| Docs and examples | `docs/ARCHITECTURE.md:92`, `docs/RUNNING_ON_A_BUDGET.md:281`, `examples/sample-report.md:7` | Show the CV filename | **CHANGE (text).** |
| Export destination example | `config/profile.example.yml:130` (`../{candidate-name}-Resume.pdf`) | Example for `cv.export_path` | **KEEP.** That is the clean, application-ready name `export-cv.mjs` writes, so a person's name belongs in it. |
| Existing files in `output/` | — | — | **KEEP.** Not renamed (earlier decision). They stay reachable through `pdf-index.tsv` and the dashboard's legacy fallback. |

---

## Implementation steps (proposed order)

Each step is one or more commits on a feature branch, conventional-commit style, with a PR to
`origin/main`.

1. **Enforce one number space.** `verify-pipeline.mjs` fails on any row whose `#` differs from its report
   link's number, or that has no report link. `merge-tracker.mjs` refuses to add such a row instead of
   renumbering it (`:774-782`), leaves the refused TSV in `tracker-additions/`, and exits 1. Update
   AGENTS.md's backfill rule (#1799) to require a report. Test both. This step goes first: everything
   after it relies on the numbers being equal.
2. **Shared resolver plus `set-status.mjs`.** Export one function from `find.mjs` that takes a report
   number and returns the tracker row (exit 2 if not found, a usage error if the argument isn't numeric).
   `set-status.mjs` uses it; remove the company selector, `--role`, `--row`, `--report`, the mismatch
   guard, and `--force`. Rewrite `set-status-tests.mjs`.
3. **`outcome.mjs`** onto the resolver; call `set-status.mjs N` without `--force`. Update
   `modes/outcome.md`.
4. **Other scripts.** `assessment-log.mjs` (`--report`, company derived), `application-artifacts.mjs`
   (derive company/role), usage-text relabels in `salary-gap.mjs` and `followup-seed.mjs`. Optional:
   `archive-posting.mjs --report`.
5. **Modes and hints.** Add the selector rule once to `modes/_shared.md` (system layer: it is procedure
   for every user, not user data), then reference it from each mode instead of restating it. Update
   `cover`, `pdf` (new invocation section), `email`, `interview-prep`, `interview/*`, `outcome`, `apply`,
   `offer-prep`, `reply-watch`, `tracker`, `patterns`, and the hints in `batch/batch-prompt.md`,
   `modes/pipeline.md`, `modes/oferta.md`, `modes/pdf.md`, `SKILL.md`.
6. **Artifact paths.** Interview-prep file `{NNN}-` prefix, session `{NNN}-` prefix plus `report:` front
   matter and the `interview-redflag` gate, cover payload and PDF, `data/offers/{NNN}-…`. Rename
   `interview-prep/snorkel-ai-coding-fellow.md` → `interview-prep/245-snorkel-ai-coding-fellow.md` and
   update the link to it in `reports/245-snorkel-ai-2026-10-02.md` (the only reference). Both files are
   gitignored user data, so this part leaves no commit.
7. **CV filename convention** (section 5). Batch prompt (paths and header template), pdf / latex /
   latex-tex modes, `generate-pdf.mjs` warning text, `export-cv.mjs` comment, web `pdf-paths.mjs` and
   its tests, the `test-all.mjs` guards, docs and examples. Also index LaTeX and Canva PDFs:
   `generate-latex.mjs --report=NNN` plus a manifest write after the Canva download, both through
   `lib/pdf-manifest.mjs` (extracted from `generate-pdf.mjs`) with a blank `html` column, and copy that
   module wherever `generate-pdf.mjs` is staged alone (`tests/generate-pdf-page-budget.test.mjs`), with a test that `export-cv.mjs` finds a LaTeX-only report's PDF. Run this
   before the dashboard step so the Go code is written against the final names.
8. **Dashboard (Go).** `-{NNN}` match first with legacy company-slug fallback in `pdf.go`; read job URLs
   from report `**URL:**` headers in `career.go`. `go test ./...`.
9. **Docs.** `AGENTS.md` (script table, Pipeline Integrity rule 2), `docs/SCRIPTS.md`, and README if
   it shows a name selector.
10. **Regression guards.** Like the CV plan's prompt-shape test: assert no mode or prompt template
   contains `/career-ops (pdf|cover|email) {(company-)?slug}` or a `<company>` selector for
   `set-status`/`outcome`; assert the interview-prep and session path templates contain `{NNN}`; assert
   `set-status.mjs Acme Applied` exits with a usage error.

### Verification

- `node test-all.mjs` clean; `go test ./...` in `dashboard/` clean; `node verify-pipeline.mjs` clean
  (including the new rule from Step 1) against the real tracker.
- `node set-status.mjs 278 Applied --dry-run` resolves row 278; `node set-status.mjs AAPC Applied` is
  rejected with a pointer to `find.mjs`.
- `npm run sheets:sync:dry` shows no changes before and after (confirms the sheets finding).
- Dashboard: a Vercel row with no manifest entry resolves to its own `-{NNN}` CV, and a legacy row
  still resolves to its old file.

## Suggested Commit Order

All commits go on `feat/report-number-as-id` and reach `origin/main` through one PR (never `upstream`).
The spike lives on `spike/report-number-as-id` (d8e6180) as reference only and is never merged.

- One-line Conventional Commit subjects, `type(scope): imperative lowercase subject`, plus the
  `Co-Authored-By` trailer on commits Claude authors.
- One logical change per commit. Each commit leaves `node test-all.mjs` passing (and `go test ./...`
  where Go changed). `main` starts with one failing test (the batch-prompt CV path), so commit 2 fixes it
  first; every later commit keeps the suite green.
- A behavior change and the tests it invalidates land in the same commit.

The order differs from the step numbering above: the CV filename work moves first because it fixes the
existing failure, and the scripts come before the mode text that documents them.

| # | Hash | Commit | Step |
|---|---|---|---|
| 1 | d95d40b | `docs(plans): plan report number as the application ID` | — |
| 2 | c93b5c7 | `fix(batch-prompt): name tailored CVs cv-{company-slug}-{NNN}` | 7 |
| 3 | a0e06f6 | `refactor(pdf): move pdf-index.tsv writes into lib/pdf-manifest.mjs` | 7 |
| 4 | 5f8031d | `feat(pdf): honor CAREER_OPS_PDF_INDEX when writing pdf-index.tsv` | 7 (added) |
| 5 | 3f9c837 | `feat(latex): record LaTeX PDFs in pdf-index.tsv with --report` | 7 |
| 6 | 21ead06 | `feat(mark-pdf-ready): record a downloaded PDF in pdf-index.tsv with --pdf` | 7 |
| 7 | b711a22 | `docs(modes): name CVs cv-{company-slug}-{NNN} in pdf, latex and latex-tex` | 7 |
| 8 | c7a1485 | `fix(web): drop the candidate slug from the rendered CV name` | 7 |
| 9 | 5560489 | `docs: update CV filename examples to cv-{company-slug}-{NNN}` | 7 |
| 10 | 91ede79 | `feat(verify-pipeline): require each row's # to equal its report number` | 1 |
| 11 | cd07f37 | `fix(merge-tracker): refuse rows that break the report-number rule instead of renumbering` | 1 |
| 12 | 6799b60 | `feat(find): add resolveReportNumber and use it in mark-pdf-ready` | 2 |
| 13 | 8de5794 | `fix(outcome): resolve rows by report number so names stop matching unknown employers` | 3 |
| 14 | 095f19f | `refactor(set-status): accept only a report number` | 2 |
| 15 | 8e237d8 | `feat(assessment-log): derive the company from --report` | 4 |
| 16 | f158e40 | `refactor(application-artifacts): read company and role from the report number` | 4 |
| 17 | 00229f3 | `docs(scripts): label tracker-number arguments as report numbers` | 4 |
| 18 | 371640e | `fix(dashboard): match CV files by report number before company` | 8 |
| 19 | 3a13efb | `fix(dashboard): stop guessing job URLs from company-name matches` | 8 |
| 20 | 156ed60 | `docs(agents): add the report-number selector rule to AGENTS.md` | 5 |
| 21 | a07b372 | `docs(modes): take a report number in cover, pdf and email` | 5, 6 |
| 22 | 59f3eea | `docs(modes): key interview-prep files and sessions on the report number` | 5, 6 |
| 23 | 92a3e9b | `docs(modes): use report numbers in apply and offer-prep` | 5, 6 |
| 24 | 5fd330a | `docs: document report-number selectors in AGENTS.md and SCRIPTS.md` | 9 |
| 25 | cef8d6a | `test: guard modes and prompts against name selectors` | 10 |
| — | — | Rename `interview-prep/snorkel-ai-coding-fellow.md` → `245-…` and fix its link in report 245 | 6, user data, after the merge |

## Implementation notes (deviations from the plan as written)

- **Commit 4 added: the manifest writer honors `CAREER_OPS_PDF_INDEX`.** Its readers (`export-cv.mjs`,
  `sync-pdf-flags.mjs`) already did; the writer always wrote the live `data/pdf-index.tsv`, so any test of
  `generate-latex --report` would have rewritten the user's real index.
- **The Canva entry point is `mark-pdf-ready.mjs --pdf <path>`** (commit 6), not a new script: it already
  resolves a report and flips the PDF cell, and now also records the file through `lib/pdf-manifest.mjs`.
  Paths outside career-ops, non-`.pdf` files, and missing files are refused before anything is written.
- **`mark-pdf-ready.mjs` moved onto `resolveReportNumber()`** in commit 12 — it carried its own copy of the
  same lookup.
- **`outcome.mjs` landed before `set-status.mjs`** (commits 13, 14): `outcome` passed `--force`/`--role`,
  which the new `set-status` rejects, so the reverse order would have broken the suite between commits.
  The regression test for the unknown-employer bug was confirmed to fail on `main`'s `outcome.mjs`.
- **`set-status` docs changed with the script** (commit 14: AGENTS.md, SCRIPTS.md, `tracker`, `patterns`,
  `interview-prep` modes) instead of in the docs commit, so no commit documents a CLI that rejects what it
  shows. Commit 23 therefore covers `apply` and `offer-prep` only.
- **AGENTS.md's backfill rule (#1799) changed with `merge-tracker`** (commit 11): a backfilled row now needs
  a stub report, since report-less rows are refused.
- **The selector rule lives in AGENTS.md, not `modes/_shared.md`** (commit 20). Most modes that select an
  application (`cover`, `email`, `interview-prep`, `interview/*`, `outcome`, `tracker`, `offer-prep`,
  `followup`, `reply-watch`) never load `_shared.md`; AGENTS.md is imported by `CLAUDE.md`, `CODEX.md`,
  `OPENCODE.md`, and `KIMI.md`, so it reaches every mode. Modes point to "AGENTS.md → Selecting an
  Application".
- **`application-artifacts.mjs` dropped `--company`/`--role`** (`parseArgs` is strict, so passing them is an
  error) and reads both from the report's tracker row.
- **Dashboard job URLs:** Strategy 1 already reads each report's `**URL:**` header; the company-name
  fallbacks only run for reports without an `http` URL (3 of the user's reports: 188, 245, 274). Both
  fallbacks now share `roleMatchedURL()`, which returns nothing rather than guess (no shared role word, or
  a tie). Found while checking: **both fallbacks are effectively dead on current data** — Strategy 4 reads
  `scan-history.tsv` from the repo root while the file lives in `data/`, and Strategy 5 parses
  `role @ company` notes while `batch-input.tsv` uses `Company — Role`. Left as is (out of scope); the
  change is defensive.
- **Not done (LOW, optional in the plan):** `archive-posting.mjs --report`, `jds/{NNN}-…` scratch names,
  `deep` accepting a report number.
- **Unchanged on purpose:** the sheets plugin (no plugin files or tracker data change), old CV files in
  `output/`, existing `jds/` files, the company-level `interview-prep/{company-slug}-redflags.md`, and
  `profile.example.yml`'s export-name example.

---

## PR #7 review round (2026-10-09)

The automated code review resolved `#7` against the upstream repo and reviewed a different PR, so its
findings were discarded and the diff was reviewed by hand at `eda2d6c`. Three findings, all fixed, each
with a test confirmed to fail on the unfixed code:

| # | Finding | Fix |
|---|---|---|
| [1] | `merge-tracker`'s re-evaluation path (same company+role, new report number) kept the row's old `#` but wrote the new report link, breaking Check 14 on a routine re-eval. | bbd8074 — the row keeps its own report link; a different report is linked from the `Re-eval …` note. |
| [2] | `batch-runner.sh:760` called `merge-tracker` unguarded under `set -euo pipefail`, so one refused TSV skipped reconcile, verify, and the batch summary. | e16b9ce — `|| echo` guard like its sibling steps; `merge-tracker` still exits 1 for direct callers. |
| [3] | `generate-latex --report` recorded out-of-repo PDF paths and silently ignored a bare `--report`. | 29f361b — a `--report` with no value is a usage error; a PDF outside career-ops compiles but is not recorded (warning on stderr, `manifestSkipped` in the JSON). |

## Spike results (2026-10-09)

The riskiest changes were prototyped on branch `feat/report-number-as-id` in a separate worktree that
held a **copy** of the user data, so the real tracker was never written. Nothing is committed.
Baseline on `main` before the spike: `test-all.mjs` 2954 passed / 1 failed (the batch-prompt CV-path
test predicted in section 5), `go test ./...` clean, `verify-pipeline.mjs` 0 errors.

| Spike | Result | What it found |
|---|---|---|
| **Step 1:** one number space | ✅ Works | Check 14 in `verify-pipeline.mjs` passes on the real tracker copy, and reports each broken case (wrong #, no report, two reports) with its own message. **New:** `merge-tracker.mjs:774-782` *silently renumbers* a colliding row to `max+1` while keeping its report link, which breaks the rule by design. It now refuses instead. Refused TSVs must **stay in `tracker-additions/`** (the old code moved every TSV to `merged/`, skipped ones included) and the run exits 1, so verify-pipeline's pending-TSV check keeps flagging them. Consequence: a backfilled row with no report (#1799 `N/A` sentinel) is now refused; AGENTS.md's backfill rule needs to require a report. |
| **Step 2:** shared resolver + `set-status.mjs` | ✅ Works | `resolveReportNumber()` in `find.mjs`. `set-status.mjs` went from 521 to 310 lines. On the copy: `278`/`0278` resolve; `AAPC` → usage error pointing to `find.mjs` (exit 1); `999` → not found (exit 2); `--role`/`--force` → unknown flag. One real write on the copy changed exactly one line and appended the right status-log row. `set-status-tests.mjs`: 43 pass, 28 fail, all testing removed features (mismatch guard, `--role`, `--row`/`--report`, `--force`, company selectors, #2346). |
| **Step 3:** `outcome.mjs` | ✅ Works | On the shared resolver; passes the resolved report number to set-status without `--force`. **Bug on `main` today:** the substring fallback (`outcome.mjs:176`) matches every unknown-employer row for *any* name, because `normalizeCompany("?")` is `""` and every string contains `""`. Verified by dry-run: `node outcome.mjs Zzyzxco rejected` would record a rejection on **#226** and set its status. The spike removes the name path, which fixes it. |
| **Step 7:** LaTeX in the index | ✅ Works | Manifest code moved to `lib/pdf-manifest.mjs` (`generate-pdf.mjs` imports Playwright at load, so `generate-latex.mjs` can't import from it), with re-exports from `generate-pdf.mjs` for existing callers. `generate-latex.mjs --report=249` (with a stand-in `pdflatex`, since none is installed here) recorded the PDF; `find.mjs 249` shows it; **unchanged** `export-cv.mjs 249` copied it. A real Playwright render through the shared module still records correctly. **New:** a LaTeX/Canva row must leave the `html` column **blank**: the dashboard's D key runs `generate-pdf.mjs <html column>` (`dashboard/main.go:213`). **New:** anything that stages `generate-pdf.mjs` on its own must copy `lib/pdf-manifest.mjs` too (`tests/generate-pdf-page-budget.test.mjs` broke with `ERR_MODULE_NOT_FOUND`). |
| **Step 8:** dashboard `-{NNN}` match | ✅ Works | `narrowByReport()` in `pdf.go` for both `ResolvePDFs` and `ResolveHTML`: files with this report's number win; files with *another* report's number are dropped; unnumbered legacy files stay as candidates. A 3+-digit rule keeps date fragments (`-06`) from passing as report numbers. New Go tests pass, along with all existing ones. `enrichAppURLsByCompany` was not prototyped. |

**Full suite with every spike applied:** 2941 passed / 9 failed. One is the existing batch-prompt
failure; the other eight all test behavior this plan removes on purpose, and each needs its test
rewritten during implementation:

- `set-status-tests.mjs` (28 assertions, above)
- `tracker-writer-lock-tests.mjs` (calls `set-status --row`)
- `tracker-columns-tests.mjs` (fixture rows have no report links)
- verify-pipeline "clean fixture" (#1704; rows without report links now fail Check 14)
- merge-tracker #912, #1704, and "collision fallback" tests (assert the removed renumbering)
- merge-tracker PDF-flag test (fixture TSV num 1 links report 41)

`tests/outcome.test.mjs` also needed its fixture links changed from `local:reports/1-acme.md` (which the
shared parser deliberately ignores) to standard `[1](../reports/001-acme-….md)` links, and its `'Acme'`
selector changed to `'1'`.

Not prototyped (low risk, or needs an LLM run to exercise): mode and prompt text, the Snorkel rename,
the cover and interview-prep path changes, `assessment-log`/`application-artifacts`, the Canva manifest
write, the web `pdf-paths.mjs` change.

**Unrelated hazard found while checking data safety:** `tests/stats.test.mjs:231-252` (upstream, #2123)
overwrites the **live** `data/applications.md` and `data/follow-ups.md` with fixtures, runs `stats.mjs`,
and restores from an in-memory backup in `finally`. The baseline run restored both intact (243 rows, 25
follow-up pins, verify-pipeline unchanged), but an interrupted run inside that window would leave
fixture data in the real tracker. Fix: let `stats.mjs` take `CAREER_OPS_TRACKER` like the other scripts
and point the test at temp files. Separate from this plan.

---

## Side findings (not name-vs-ID, but turned up during the sweep)

1. **CV filename convention drift.** `batch/batch-prompt.md:417`, `:422-423` (changed in `f0e76ac`)
   writes `output/{candidate-name}-{company-slug}-{NNN}.html`, while `modes/pdf.md:39-44`,
   `latex.md:17-19`, and `latex-tex.md:57-58` use `output/cv-{candidate}-{company}-{NNN}…`. Resolved by
   the decision in section 5.
2. **`set-status.mjs` and `outcome.mjs` mislabel the bare-number selector** as `report#` when it matches
   the tracker `#` column. Resolved by the decision that a bare number means the report number, plus
   Step 1's rule.

## Decisions (2026-10-09)

- **A bare number means the report number everywhere** (option b). This fork is maintained
  independently and won't merge upstream. Made safe by enforcing `# == report #` (Step 1), which also
  makes `--row`, the mismatch guard, and `--force` in `set-status.mjs` unnecessary; they are removed.
- **No name fallback for selecting an application.** Modes and scripts refuse a name as a selector. The
  agent may run `find.mjs` for the user and show matching rows, but proceeds only once the user gives
  the number. Inputs that are inherently names (emails, live forms, pasted JDs or contracts, per-company
  aggregates, external searches) are not selectors and stay as they are.
- **Rename old-convention files in the conventions this plan changes.** That is one file today: the
  Snorkel interview-prep file (→ `245-…`). Session transcripts and `data/offers/` are empty.
- **Leave legacy CV files in `output/` as they are.** They don't disturb the new convention and remain
  reachable through `pdf-index.tsv` and the dashboard's legacy fallback. The same applies to existing
  `jds/` files and the existing cover letter PDF.
- **Leave the sheets plugin alone.** The investigation (section 3) found nothing the switch breaks. The
  role-title-edit duplicate is not a concern: it is rare and usually means a genuinely different role.
- **CV filename is `cv-{company-slug}-{NNN}` everywhere** (section 5). No candidate name and no date.
  `export-cv.mjs` produces the application-ready name. Proposed extensions, open to veto: a `-latex`
  suffix for LaTeX output so it can't overwrite the same report's HTML-pipeline PDF, and `-canva` for
  Canva exports.
