# Fix job location in the Google Sheets sync (and make location single-sourced)

> **Status: all decisions final 2026-10-01, ready to implement.** Branch `fix-sheet-location` → one PR into
> `origin/main`. Nothing is implemented yet. See "Resolved decisions" for how each answer shapes the steps,
> and "Suggested Commit Order" for the commit sequence.

## Context

The Google Sheets sync writes `Austin, TX` into column F (Location) for every row, while the dashboard shows
the correct per-job location (Remote, Austin, etc.). The 2026-09-30 applications made it obvious: most were
remote, and the sheet recorded all of them as `Austin, TX`.

### Root cause 1 — the plugin never computes a per-job location

- `plugins/sheets/index.mjs:103` — `const location = cfg.location_default || profileLocation('');`
- `config/plugins.yml:10` — `location_default: "Austin, TX"`. Even without it, `profileLocation()`
  (`plugins/sheets/_sources.mjs:142`) returns the **candidate's** base location from `config/profile.yml`.
- `plugins/sheets/_reconcile.mjs:104` — every tracker-only row gets `location: locationDefault`.

This was deliberate: `plans/08-31-26_google-sheets-sync.md:165` defines column F as *"the candidate's base, not
the job's"*, because the 24 hand-entered rows at the time all used `Austin, TX`. That assumption stopped
holding once the search moved to remote roles.

### Root cause 2 — the dashboard uses a separate, heuristic code path

`dashboard/internal/data/derive.go:131` (`deriveNoteFields`) derives Location and WorkMode **per row from
the tracker Notes** (first "City, ST" in Notes → Role → an international city list; hybrid/remote/onsite
keywords for WorkMode). Two components, two rules, and only one of them looks at the data.

The heuristic also misses rows with no state code: "onsite Austin" / "Austin on-site" produce no Location,
so the dashboard shows only `Full`.

| # | Company | Notes say | Dashboard | Sheet |
|---|---|---|---|---|
| 229 / 230 / 231 / 234 / 235 | BrightPlan, DeepScribe, TRM, IFS, Crogl | "Remote US" | Remote | Austin, TX ❌ |
| 233 | Nava | "Remote" | Remote | Austin, TX ❌ |
| 224 / 225 / 227 | Aalo ×2, Boom | "onsite Austin" | Full (no City, ST match) | Austin, TX (right by accident) |

### Root cause 3 — rows already in the sheet are never corrected

`plugins/sheets/_reconcile.mjs:85-89`: when a tracker row matches an existing sheet row, *"career-ops owns
Response, the sheet keeps everything else."* Only column H (status) is updated. The rows already written as
`Austin, TX` would stay wrong even after the location is computed correctly.

### Why a report-level field is needed

Reports have no structured location. The only source is the Block A `| Remote |` row, which is free-form
prose and inconsistent ("Full — `workplaceType: Remote`…", "Remote, but restricted to within Spain",
"On-site, North Austin facility…"), and it appears in only 69 of 200 reports. Nothing can read it reliably.

### Related duplication

The Machine Summary YAML fence is already parsed separately in at least five places:
`verify-pipeline.mjs:262`, `upskill.mjs:57`, `salary-gap.mjs:123`, `plugins/sheets/_sources.mjs:120` (header
regexes), and `dashboard/internal/data/career.go` (Go regexes, e.g. `reArchetypeYAML`). This is the same drift
pattern that caused this bug.

## Guiding principle

**Derive a fact once, store it at the source, and have every consumer read it.** Location gets normalized
during evaluation and written into the report. The dashboard, the sheet sync, and future scripts read the
stored value instead of each guessing on their own. Shared JS logic goes in `lib/`. Where Go can't import JS,
a shared fixture file keeps both implementations honest in CI.

## Decisions (fill in)

Recommendations are marked; replace `[ ]` with `[x]` or write your own answer.

### D1. Overwriting existing sheet rows

When a tracker row matches an existing sheet row, should career-ops own column F?

- [x] **(Recommended)** Yes, overwrite F whenever the report has a non-null location; keep the sheet's
      value when the report has none. This fixes the 2026-09-30 rows on the next sync. Hand-entered rows
      that predate career-ops (no matching report) are untouched.
- [ ] Only fill F when the sheet cell is blank. Existing wrong `Austin, TX` rows stay wrong and need a
      manual fix.

**Notes**: This should behave like the current sheet sync update. When I change the status (Applied to Rejected, Applied to Responded/Interview, etc), the sync changes the row value. So, code changes should be made to reuse the existing logic for updating the location column (extract/generalize logic if needed).

### D2. Remote roles with a site component

For example, IFS Nexus Black: "Remote US; some site visits", or `remote_flex` roles.

- [x] **(Recommended)** Column F = `Remote` for both `remote` and `remote_flex`. They count toward
      `COUNTIF(F:F,"Remote")`.
- [ ] Column F = the city when one is known, `Remote` only when no city exists.
- Notes:

### D3. Unknown location

The report has no `job_location`, or there is no report at all.

- [ ] **(Recommended)** Leave F blank and list the row in the sync log / dry-run output. Remove
      `location_default` from `config/plugins.yml` and the `profileLocation()` fallback.
- [ ] Keep `location_default` as a fallback for unknown rows. This is the behavior that caused the bug.

**Notes:** A report should not be have a missing `job_location` if the `work_mode` is not `remote` or `remote_flex` (i.e. if the role is `hybrid` or `onsite`, it must have a non-null `job_location`). If there is a row in the Google Sheet that has no corresponding report, it should be kept as is. It means that the row was manually added to the sheet and not synced from career-ops.

### D4. Scope

- [ ] **(Recommended)** Two phases on one branch. Phase A is the location fix (Steps 1-7). Phase B, as
      separate commits, migrates `verify-pipeline.mjs`, `upskill.mjs` and `salary-gap.mjs` onto the shared
      parser (Step 8).
- [ ] Location fix only; leave the other parsers for a later plan.
- [ ] Everything in a single change.

**Notes:** This will be a new PR. There is a new branch for implementing the location fix called `fix-sheets-location`. All changes will be committed to this branch, then a new PR will be created and reviewed, then merged to `main` (`origin/main` not `upstream/main`).

### D5. Backfill coverage

- [x] **(Recommended)** All 198 reports with a Machine Summary, so the dashboard is consistent for every
      row, not just synced ones.
- [ ] Only the 61 reports whose rows sync to the sheet (`Applied` + `Rejected`).

**Notes:** Need to understand more about what it means to backfill and how to do it.

#### What backfilling means here

Steps 1-2 teach the evaluator to write `work_mode` / `job_location` into **new** reports. The 198 reports
that already exist were written before those keys existed, so they don't have them. Without the keys, the
sheet sync has nothing to read for those rows: new rows get a blank F, and existing sheet rows keep their
current (often wrong) `Austin, TX`. That includes the 2026-09-30 rows this plan exists to fix.

**Backfilling** means adding the two keys to those existing reports, once, so old and new reports look the
same to every reader. It is a one-time data repair, not a permanent code path.

How it works (Step 6):

1. **Propose (read-only).** A script reads each report, using the Block A `| Remote |` row, the
   Geo-mismatch line and the tracker Notes. For clear cases it proposes values, for example:
   - "Remote US" → `remote` / `null`
   - "On-site, Austin, TX" → `onsite` / `"Austin, TX"`

   Each proposal gets a confidence rating. Nothing is written in this phase.
2. **Resolve the unclear ones.** Rows with no city, conflicting signals, or a non-US location are
   flagged. Claude reads each flagged report in full and proposes a value. You can override any row.
3. **You approve the table.** You see one table — report #, company, proposed `work_mode`, proposed
   `job_location`, confidence, source — and approve or edit it.
4. **Apply.** Only after approval, the script inserts the two lines into each report's Machine Summary
   fence, directly after `advertised_comp`, and touches nothing else in the file. `reports/` is
   gitignored, so this step produces no commit. Re-running it is a no-op for reports that already have
   the keys.

Coverage trade-off:
- **All 198:** the dashboard reads the report for every row, including `Evaluated` / `SKIP`, so its
  Location column becomes consistent everywhere. More rows to review: roughly 110 extra, most of them
  clear cases.
- **Only the 61 synced:** fixes the sheet and the dashboard for those rows. The other ~137 keep the
  dashboard's Notes heuristic until they're re-evaluated, so the two rules coexist longer.

## Resolved decisions

How each answer above is applied in the steps below.

- **D1 → reuse the status-update path.** Today `_reconcile.mjs:85-89` handles one career-ops-owned
  column, status, inline. Step 4a generalizes it into a list of **owned columns**, each with a desired
  value, before location is added:
  - Same rule for every owned column: when the desired value is non-null and differs from the sheet
    value, overwrite it and mark the row changed.
  - A row counts **once** in `stats.updated` no matter how many owned columns changed, so
    `max_rows_per_run` still counts rows.
  - Status becomes the first entry, with no behavior change; location (Step 4b) is the second.
  - A `null` desired value defers to the sheet. This is how sheet rows without a report keep their value.
- **D2 → `Remote` for both `remote` and `remote_flex`.** As recommended.
- **D3 → hybrid/onsite require a location; sheet-only rows untouched; no default.** Neither checkbox was
  ticked; the notes are applied as:
  - **Schema rule (Step 1):** `job_location` may be `null` only when `work_mode` is `remote` or
    `remote_flex`. A `hybrid` / `onsite` report must have a non-null `job_location`.
  - **Enforcement (Step 3b):** `verify-pipeline.mjs` reports any report that breaks the rule as an
    error, and the backfill (Step 6) can't apply a table that contains one.
  - **Sheet rows with no corresponding report** survive verbatim. This is already how sheet-only rows
    behave (`_reconcile.mjs:62-69`) and stays unchanged.
  - **`location_default` and `profileLocation()` are removed.** The notes ask for no fallback value,
    and the fallback is what caused this bug.
  - **Edge case (confirmed):** a tracker row being **added** to the sheet whose report is missing or
    has no keys gets a blank F and a log line, never a guess. In practice this is a guard, not a code
    path that runs today:
    - All 203 tracker rows link a report, as of 2026-10-01.
    - This fork's `add` mode writes to `cv.md`, never the tracker.
    - The only reports without a Machine Summary are the two gate-skip notes, #204 Teero and #208
      Fluidstack. Both are `SKIP`, so they never sync. The dashboard falls back to the Notes heuristic
      for them.
- **D4 → one branch, one PR.** All work goes on `fix-sheet-location` (confirmed) and merges into
  `origin/main`, never `upstream/main`. Phase A and Phase B both go in this PR, as separate commits so
  Phase B can be dropped from the PR if review prefers.
- **D5 → backfill all 198 reports with a Machine Summary**, every status (`Evaluated`, `SKIP`, `Applied`,
  `Rejected`, …). The two gate-skip notes (#204, #208) have no Machine Summary fence and are out of scope.

## Design

### Schema: two new Machine Summary keys

```yaml
work_mode: "remote"         # remote | remote_flex | hybrid | onsite
job_location: "Austin, TX"  # "City, ST" (US) | "City" (international) | null
```

- Filled once, at evaluation time. This is where "Austin on-site", "North Austin facility", or a JD
  location of "Austin, Texas" gets normalized to `"Austin, TX"`.
- `job_location` is `null` for fully remote roles with no stated hub, and for roles whose location is
  genuinely unstated.
- `work_mode` uses the four categories the dashboard already displays (`Remote`, `RemoteFlex`, `Hybrid`,
  `Full`), so the dashboard's UI and sorting (`workModeRank`) stay the same.
- The key is `job_location`, not `location`, so it can't be confused with the candidate's location in
  `config/profile.yml`.

### Shared JS module: `lib/report-summary.mjs`

- `readMachineSummary(text)` — finds the `## Machine Summary` fence and parses it with js-yaml (already a
  dependency). Returns `null` when there is no fence or the YAML is invalid.
- `jobLocation(summary)` — returns `{ workMode, location }` with validated enum values; anything else
  becomes `null`.
- `sheetLocation(summary)` — the column F rule: `Remote` for remote (and, per D2, remote_flex), otherwise
  `job_location`, otherwise `''`.

### Go dashboard

Go can't import the JS module. It already pulls YAML keys from reports with regex (`reArchetypeYAML` in
`career.go`), so it reads `work_mode` / `job_location` the same way. `deriveNoteFields` uses the report
values first and falls back to the Notes heuristic only when the report lacks them (no report, or a report
without a Machine Summary).

**Drift guard:** `tests/fixtures/report-location-cases.json` holds a set of report snippets with expected
`{ workMode, location, sheetLocation }`. Both `dashboard/internal/data/derive_test.go` and the JS test suite
run against the same file, so a rule change in one language that isn't made in the other fails CI.

## Steps

### Phase A — location fix

#### 1. Schema — `batch/batch-prompt.md` (Machine Summary source of truth)

- Add `work_mode` and `job_location` to both Machine Summary templates (around lines 267-305 and 339-362).
- Add normalization rules:
  - US locations become "City, ST" with the two-letter state code ("Austin, Texas" / "Austin on-site" →
    `"Austin, TX"`).
  - Neighborhood or facility names collapse to the city ("North Austin facility" → `"Austin, TX"`).
  - Multi-location postings use the location the candidate would actually work from, when one matches
    their base; otherwise the first listed location.
  - `null` only when `work_mode` is `remote` / `remote_flex` and the JD names no hub (D3). A `hybrid` /
    `onsite` role must carry a city; if the JD truly states none, the evaluator says so in Block A
    and asks rather than guessing.
- Block A's `| Remote |` row stays as the human-readable explanation. The YAML keys are the
  machine-readable form.

#### 2. Pointer — `modes/oferta.md:561`

Add the two keys to the list of Machine Summary fields in the "Machine Summary (required)" paragraph. The
schema stays in `batch/batch-prompt.md`; don't duplicate it here.

#### 3. Shared module — `lib/report-summary.mjs` + tests

##### 3a. Module + fixture

As described in Design, including a `validateJobLocation(summary)` helper for the D3 rule. Add
`tests/fixtures/report-location-cases.json`, and unit tests in `tests/report-summary.test.mjs` (auto-discovered by `test-all.mjs`) driven by it. The fixture
includes cases that break the rule (`onsite` + `null`).

##### 3b. Enforce the D3 rule — `verify-pipeline.mjs`

Add a check that reports any report whose Machine Summary has `work_mode` of `hybrid` / `onsite` with a
null `job_location`. It calls `validateJobLocation()` from the shared module and does not re-implement the
rule. Reports that don't have the keys yet aren't errors until the backfill lands; treat them as a warning
so the check doesn't fail on all 198 existing reports first.

#### 4. Sheets plugin

##### 4a. Generalize the overlap update (refactor, no behavior change) — `plugins/sheets/_reconcile.mjs`

Replace the inline status overwrite at lines 85-89 with an **owned-columns** pass (per D1), with status as
its only entry. Existing reconciler tests must pass unchanged. This lands before any location code, so the
review can confirm the refactor on its own.

##### 4b. Per-job location — `plugins/sheets/`

- `_sources.mjs` — `reportFacts()` uses `readMachineSummary()` / `sheetLocation()` from the shared
  module and returns `location` (`null` when unknown). Delete `profileLocation()` (per D3).
- `index.mjs:103` — remove the `location` constant. `facts(row)` returns `location` per row.
- `_reconcile.mjs`:
  - Add location as the second owned column; it gets the same overwrite and once-per-row counting as
    status. This keeps the `max_rows_per_run` guard (`index.mjs:149`) honest.
  - Tracker-only rows: `location: f.location ?? ''`.
  - Remove the `locationDefault` parameter.
- `index.mjs:156` — the dry-run log line prints column F (`r[5]`), so a location repair is visible before
  anything is written.
- Log a line for every row added with a blank F (per the D3 edge case).
- Remove `location_default` from `DEFAULTS` (`index.mjs:38`) and from `config/plugins.example.yml:52`.
  `config/plugins.yml` is gitignored user config; remove the key there by hand. That edit produces no
  commit, and a leftover key is ignored.
- Reconciler tests: overlap row with a new location → overwritten; overlap row with `null` → sheet value
  kept; sheet-only row → untouched; status and location both changed on one row → `updated` counts 1.

##### 4c. Docs

Update `plans/08-31-26_google-sheets-sync.md:165` and `plugins/sheets/skill.md` (if it describes column F)
to say that column F is now the job's location, with a link to this plan.

#### 5. Dashboard — `dashboard/internal/data/`

- `career.go` — in the existing report-enrichment loop, read `work_mode` / `job_location` from the
  Machine Summary. That loop only scans the first 1000 bytes for the URL, so read the YAML keys from the
  full content.
- `derive.go` — `deriveNoteFields` keeps the Notes heuristic, but only for fields the report didn't
  supply. Map `remote|remote_flex|hybrid|onsite` → `Remote|RemoteFlex|Hybrid|Full`.
- `derive_test.go` — table test driven by `tests/fixtures/report-location-cases.json`.

#### 6. Backfill — `backfill-job-location.mjs` (one-time, user-confirmed)

- Default mode is dry-run: for each of the 198 reports with a Machine Summary (per D5), propose `work_mode` / `job_location`.
  Sources:
  - The Block A `| Remote |` row.
  - The report's Geo-mismatch line.
  - The tracker Notes.
  - The same "City, ST" and keyword rules as `derive.go`.
- Output a review table with a confidence column. Ambiguous rows (no city, conflicting signals,
  non-US) are flagged for manual resolution. Claude reads each flagged report and proposes a value.
- `--apply` inserts the two keys into each Machine Summary fence, after `advertised_comp`. It never
  rewrites any other part of the report. It runs only after the user approves the table.
- Reports are user layer. Nothing is written without the user approving the table.
- Delete the script after the backfill, so it doesn't sit at the repo root as dead code.

#### 7. Sync and verify the live sheet

`npm run sheets:sync:dry`, review the column F changes (the 2026-09-30 rows should flip to `Remote`), then
`npm run sheets:sync`. Confirm the `COUNTIF(F:F,"Remote")` and `"* TX"` counters look correct.

### Phase B — consolidate Machine Summary parsing (per D4)

#### 8. Migrate the remaining JS readers onto `lib/report-summary.mjs`

`verify-pipeline.mjs:262`, `upskill.mjs:57`, `salary-gap.mjs:123`. Each one drops its own fence regex and
line-by-line YAML scraping in favor of `readMachineSummary()`. Behavior-preserving. Their existing tests
in `test-all.mjs` must pass unchanged. One commit per script.

## Verification

- `node test-all.mjs` passes, including the new shared-fixture tests.
- `cd dashboard && go test ./...` passes, including the fixture-driven `derive_test.go` cases.
- Dashboard (`npm run build:dashboard && npm run serve:dashboard`): reports 224/225/227 show
  `Full · Austin, TX` (previously `Full` with no location); 229-235 still show `Remote`.
- `npm run sheets:sync:dry` lists the expected column F changes, and no others. A second real sync after
  `npm run sheets:sync` reports "sheet already matches the tracker", which confirms the no-op gate still
  holds with column F as a compared column.
- A new evaluation run after Steps 1-2 produces a report with both keys populated.
- `node verify-pipeline.mjs` reports no hybrid/onsite report with a null `job_location` after the backfill.

## Suggested Commit Order

All commits go on `fix-sheet-location` and reach `origin/main` through one PR. Never push to or open PRs
against `upstream`.

Conventions, taken from this repo's history (e.g. the `plugin-googlesheet` branch):
- Subject: Conventional Commits, `type(scope): imperative lowercase subject`.
- Commits Claude authors end with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
  Plan-file commits you make yourself have carried no trailer.
- One logical change per commit. Each commit leaves `node test-all.mjs` (and `go test ./...` where
  Go changed) passing.
- Claude commits only when asked; the PR is opened only when asked.

| # | Commit | Step | Files |
|---|---|---|---|
| 0 | `docs(plans): wrote plan to fix job location in Google Sheet sync` ✅ `81cdecd` | — | this plan |
| 1 | `docs(plans): record decisions and commit order for the location fix` | — | this plan |
| | **Phase A — location fix** | | |
| 2 | `feat(batch-prompt): add work_mode and job_location to the Machine Summary` | 1, 2 | `batch/batch-prompt.md`, `modes/oferta.md` |
| 3 | `feat(lib): add shared Machine Summary reader with job-location rules` | 3a | `lib/report-summary.mjs`, `tests/fixtures/report-location-cases.json`, `tests/report-summary.test.mjs` |
| 4 | `feat(verify-pipeline): flag hybrid/onsite reports missing job_location` | 3b | `verify-pipeline.mjs`, `tests/verify-pipeline-job-location.test.mjs` |
| 5 | `refactor(sheets): generalize overlap updates into owned columns` | 4a | `plugins/sheets/_reconcile.mjs`, tests |
| 6 | `fix(sheets): write each job's location from its report` | 4b | `plugins/sheets/*`, `config/plugins.example.yml`, tests |
| 7 | `docs(sheets): redefine column F as the job's location` | 4c | `plans/08-31-26_google-sheets-sync.md`, `plugins/sheets/skill.md` |
| 8 | `fix(dashboard): read work_mode and job_location from the report` | 5 | `dashboard/internal/data/*` |
| 9 | `chore: add one-time job-location backfill script` | 6 | `backfill-job-location.mjs` |
| — | *(no commit)* run the backfill after approving the table | 6 | `reports/*.md` (gitignored) |
| 10 | `chore: remove the one-time job-location backfill script` | 6 | `backfill-job-location.mjs` |
| — | *(no commit)* `npm run sheets:sync:dry` → review → `npm run sheets:sync` | 7 | live sheet |
| | **Phase B — consolidate Machine Summary parsing** | | |
| 11 | `refactor(verify-pipeline): read the Machine Summary via the shared module` | 8 | `verify-pipeline.mjs` |
| 12 | `refactor(upskill): read the Machine Summary via the shared module` | 8 | `upskill.mjs` |
| 13 | `refactor(salary-gap): read the Machine Summary via the shared module` | 8 | `salary-gap.mjs` |
| 14 | `docs(plans): mark the job-location plan complete` | — | this plan |

Notes:
- Commits 2-8 don't touch report data, so they land and pass tests before the backfill runs.
- Commit 9 is kept and then deleted by commit 10, so the script stays in history (recoverable) without
  living at the repo root.
- Phase B (11-13) can be dropped from the PR without affecting Phase A.
