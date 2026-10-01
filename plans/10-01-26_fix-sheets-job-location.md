# Fix job location in the Google Sheets sync (and make location single-sourced)

> **Status: draft 2026-10-01 — awaiting decisions.** Fill in the "Decisions" section below; nothing is
> implemented yet.

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

- [ ] **(Recommended)** Yes, overwrite F whenever the report has a non-null location; keep the sheet's
      value when the report has none. This fixes the 2026-09-30 rows on the next sync. Hand-entered rows
      that predate career-ops (no matching report) are untouched.
- [ ] Only fill F when the sheet cell is blank. Existing wrong `Austin, TX` rows stay wrong and need a
      manual fix.
- Notes:

### D2. Remote roles with a site component

For example, IFS Nexus Black: "Remote US; some site visits", or `remote_flex` roles.

- [ ] **(Recommended)** Column F = `Remote` for both `remote` and `remote_flex`. They count toward
      `COUNTIF(F:F,"Remote")`.
- [ ] Column F = the city when one is known, `Remote` only when no city exists.
- Notes:

### D3. Unknown location

The report has no `job_location`, or there is no report at all.

- [ ] **(Recommended)** Leave F blank and list the row in the sync log / dry-run output. Remove
      `location_default` from `config/plugins.yml` and the `profileLocation()` fallback.
- [ ] Keep `location_default` as a fallback for unknown rows. This is the behavior that caused the bug.
- Notes:

### D4. Scope

- [ ] **(Recommended)** Two phases on one branch. Phase A is the location fix (Steps 1-7). Phase B, as
      separate commits, migrates `verify-pipeline.mjs`, `upskill.mjs` and `salary-gap.mjs` onto the shared
      parser (Step 8).
- [ ] Location fix only; leave the other parsers for a later plan.
- [ ] Everything in a single change.
- Notes:

### D5. Backfill coverage

- [ ] **(Recommended)** All 198 reports with a Machine Summary, so the dashboard is consistent for every
      row, not just synced ones.
- [ ] Only the 61 reports whose rows sync to the sheet (`Applied` + `Rejected`).
- Notes:

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

**Drift guard:** `test/fixtures/report-location-cases.json` holds a set of report snippets with expected
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
  - `null` when the JD states no location.
- Block A's `| Remote |` row stays as the human-readable explanation. The YAML keys are the
  machine-readable form.

#### 2. Pointer — `modes/oferta.md:561`

Add the two keys to the list of Machine Summary fields in the "Machine Summary (required)" paragraph. The
schema stays in `batch/batch-prompt.md`; don't duplicate it here.

#### 3. Shared module — `lib/report-summary.mjs` + tests

As described in Design. Add unit tests to `test-all.mjs` that use the shared fixture file.

#### 4. Sheets plugin

- `plugins/sheets/_sources.mjs` — `reportFacts()` uses `readMachineSummary()` and returns
  `sheetLocation`. Delete `profileLocation()` (per D3).
- `plugins/sheets/index.mjs:103` — remove the `location` constant. `facts(row)` returns `location` per
  row.
- `plugins/sheets/_reconcile.mjs`:
  - Tracker-only rows: `location: f.location` instead of `locationDefault`.
  - Overlap rows (per D1): if `f.location` is set and differs from `existing.location`, overwrite it and
    count it in `updated`. This keeps the `max_rows_per_run` guard (`index.mjs:149`) honest about how many
    rows a run will touch.
  - Remove the `locationDefault` parameter.
- `plugins/sheets/index.mjs:156` — the dry-run log line prints column F (`r[5]`), so a location repair is
  visible before anything is written.
- Log a line for every synced row with an unknown location (per D3).
- `config/plugins.yml` / `config/plugins.example.yml` — remove `location_default` (per D3), and remove
  the `location_default` entry from `DEFAULTS` in `index.mjs:38`.
- Update `plans/08-31-26_google-sheets-sync.md:165` to note that column F's definition changed, with a link
  to this plan.

#### 5. Dashboard — `dashboard/internal/data/`

- `career.go` — in the existing report-enrichment loop, read `work_mode` / `job_location` from the
  Machine Summary. That loop only scans the first 1000 bytes for the URL, so read the YAML keys from the
  full content.
- `derive.go` — `deriveNoteFields` keeps the Notes heuristic, but only for fields the report didn't
  supply. Map `remote|remote_flex|hybrid|onsite` → `Remote|RemoteFlex|Hybrid|Full`.
- `derive_test.go` — table test driven by `test/fixtures/report-location-cases.json`.

#### 6. Backfill — `backfill-job-location.mjs` (one-time, user-confirmed)

- Default mode is dry-run: for each report in scope (per D5), propose `work_mode` / `job_location`.
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
- Delete the script after the backfill (or move it under `batch/` if it might be useful again), so it
  doesn't sit at the repo root as dead code.

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
