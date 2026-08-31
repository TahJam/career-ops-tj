# Google Sheets Sync

**Date:** 2026-08-31
**Status:** Implemented on branch `plugin-googlesheet` (2026-08-31). First full sync ran: 37 rows, 13 added. Sidecar formulas, hyperlinks, dropdown validation and date formatting all verified intact afterwards.
**Goal:** Mirror the career-ops tracker into the existing "Applications" Google Sheet, without damaging anything already in that sheet.
**Shape:** A bundled plugin at `plugins/sheets/`, driven by `node plugins.mjs run sheets export`. See §3 — it supersedes an earlier root-script recommendation that rested on two incorrect readings of the plugin contract.

---

## 1. What was verified (not assumed)

All of the following was read from the live sheet with the service-account key.

### Auth — working end to end

| Item | Value |
|---|---|
| Key type | `service_account` |
| Client email | `sheetupdator@career-ops-sheetupdator.iam.gserviceaccount.com` |
| Project | `career-ops-sheetupdator` |
| Token mint | ✅ RS256 JWT → `oauth2.googleapis.com/token` |
| Read | ✅ |
| **Write** | ✅ verified — wrote `Apply 2026!Z999`, then cleared it; sidecar formulas re-read intact |
| `.env` pickup | ✅ `dotenv.config()` resolves all three keys |

`GOOGLE_SHEET_ID`, `GOOGLE_AUTH_PATH=auth/google-auth.json`, `GOOGLE_SYNC=true`. No setup work remains.

**No new dependency needed.** The JWT flow is ~40 lines of `node:crypto` and was proven working during this investigation. `googleapis` would be the heaviest dependency in the project and buys nothing.

### Spreadsheet shape

Title **"Applications"**, six tabs:

| Tab | Rows | Role |
|---|---|---|
| `Apply 2026` | 24 data rows | **sync target** |
| `Apply 2025` / `2024` / `2023` | 31 / 34 / 106 | history, untouched |
| `Interviews`, `Referees` | — | different schema, untouched |

`Apply 2026`, frozen header row:

```
A Company | B Position | C Date | D Resume | E Reference Link | F Location | G Referral | H Response
```

### Four hazards found in that tab

These are the reason this needs a plan rather than a script.

**H1 — Columns I and J hold live formulas, interleaved with the data rows.**

```
I1 =CONCAT("Yesterday: ", Countif(C:C,TODAY()-1))
J1 =Concat("Today: ", COUNTIF(C:C,Today()))
I2 "Remote:"        J2 =COUNTIF(F:F,"Remote")
I3 "California:"    J3 =Countif(F:F,"* CA")
I4 "Texas:"         J4 =Countif(F:F,"* TX")
I5 "New York"       J5 =countif(F2:F,"* NY")
I6 "Total:"         J6 =sum(J2:J6)
```

A read-then-write round trip using the default `valueRenderOption` returns these as the *strings* `"Remote:"`, `"1"`, `"22"` — writing them back replaces five live formulas with stale literals. This is the failure the sync must be built to avoid.

The good news, established by inspection: every one of these references either a **whole column** (`C:C`, `F:F`), an **open-ended range** (`F2:F`), or the **J column itself** (`J2:J6`). **None references A:H by relative row.** So rewriting and reordering A:H does not disturb them — provided we never write I/J and never shift their grid position.

**H2 — Column E hyperlinks are cell-level, invisible to the values API.**

`userEnteredValue` is `{"stringValue":"Link"}`; the URL lives in the separate, **output-only** `hyperlink` field:

```
row2  "Link" → https://www.linkedin.com/jobs/view/4087387688
row6  "Link" → https://job-boards.greenhouse.io/spacex/jobs/8379301002
```

All 24 data rows carry one. A `values.update` writing the string `"Link"` keeps the text and **silently destroys the link**. Since `hyperlink` cannot be written back, the fix is to write `=HYPERLINK("<url>","Link")` with `USER_ENTERED` — renders identically, and is round-trippable forever after.

**H3 — Column H has a `ONE_OF_LIST` data validation.**

```
"Submitted - Waiting" | "Rejected" | "Interviewing" | "Offer Received" | "Offer Accepted"
```

~~Applied to rows 2–30; growing past row 30 drops the dropdown.~~ **Corrected during implementation:** the initial probe only read `A1:J30`, so the validation appeared to stop at row 30. A full-grid read shows it covers rows 2–1000. **Not a hazard** — no validation extension is needed. Writes must still emit only these five values.

The `status_map` in `config/plugins.yml` is what enforces that.

**H4 — Column C is a real date, not text.**

`userEnteredValue` is `{"numberValue": 46042}` with `numberFormat {type: DATE, pattern: "mm/dd/yyyy"}`. Writing `RAW` strings breaks `COUNTIF(C:C,TODAY()-1)`. Writes must use `USER_ENTERED`.

Unlike H3 this one **is** real: the DATE format stops at row 25 (verified `dateFormatLastRow=25` against the live grid), so appended rows need it extended or their dates land as plain text and drop out of the `COUNTIF(C:C,…)` counters.

### The JOIN, measured

| | |
|---|---|
| Tracker rows | 93 |
| Tracker rows in an applied-or-later state | 14 |
| `Apply 2026` rows | 24 |
| **Overlap on (company, role)** | **1** |
| Tracker applied-or-later missing from sheet | 13 |
| Sheet rows with no tracker row | 23 |

The single overlap proves the join key:

```
#94 Lightspeed Systems | Software Engineer (AI Native)
    tracker:   2026-08-05  Rejected      ← evaluation date
    sheet r25: 05/21/2026  "Rejected"    ← actual apply date
```

**Join on normalized `company|role`. Never on date** — the tracker's Date is the *evaluation* date, the sheet's is the *apply* date, and they legitimately differ by months.

---

## 2. Design

### 2.1 One reconciler, not two code paths

Full-sync and delta-sync as separate code paths will drift and disagree. Build **one reconciler** with a scope filter:

```
read sheet (values + hyperlinks) → build desired row set → diff → emit minimal writes
```

- `--all` — full rewrite of `Apply 2026`, date-ordered
- `--report N` / `--since-log` — same reconciler, scoped to affected rows

Delta then normally resolves to *append one row* or *update one cell*, because a new application's date is the newest date. **If a delta write would break date ordering** (a backdated `--on`), it escalates to a full rewrite automatically. That rule is what keeps the two modes from ever producing different sheets.

### 2.2 Full sync = full rewrite of A:H, formulas intact

Since all sidecar formulas are column-scoped, a date-ordered rewrite is safe under four rules:

1. **Write only `A2:H<n>`.** Never I or J, never row 1.
2. **`values.update`, never `InsertDimension` / `DeleteDimension` / `SortRange`.** Those shift I/J's grid position; a plain value write does not. Row order changes by rewriting *values*, not by moving rows.
3. **If the new set is shorter, `values.clear` on `A<n+1>:H<oldLast>`** — a range clear on A:H only, which does not touch I/J.
4. **`valueInputOption: USER_ENTERED`** always.

Row count grows 24 → 37; the grid is 1000 rows, so no dimension insert is needed.

**Union semantics.** The rewrite emits the union of both sides:

| Row source | Company/Position | Date | Resume | Link | Location | Referral | Response |
|---|---|---|---|---|---|---|---|
| Sheet only (23) | sheet | sheet | sheet | sheet URL → `=HYPERLINK` | sheet | sheet | sheet |
| Both (1) | sheet | **sheet** (apply date wins) | sheet | sheet | sheet | sheet | **career-ops** |
| Tracker only (13) | tracker | status-log → tracker | from report | report `**URL:**` | profile | from `via:` | career-ops |

Sheet-only rows are **never dropped and never rewritten in substance** — they pre-date career-ops and are the user's own history. Their only change is `"Link"` → `=HYPERLINK("<same url>","Link")`, which is what makes the rewrite lossless.

Only tracker rows in `Applied | Responded | Interview | Offer | Hired | Rejected` are pushed. `Evaluated`, `SKIP`, `Discarded` never reach the sheet — it is an applications log, not an evaluations log.

After the value write, one `batchUpdate` extends `numberFormat` and `dataValidation` down to the new last row (`copyPaste` `PASTE_FORMAT` from row 2), fixing H3 and H4 together.

### 2.3 Column mapping

| Col | Source | Notes |
|---|---|---|
| A Company | tracker `company` | |
| B Position | tracker `role` | |
| C Date | `data/status-log.tsv` transition into `Applied`; fallback tracker Date | written `MM/DD/YYYY`, `USER_ENTERED` |
| D Resume | `**PDF:**` in report / `data/pdf-index.tsv`, **basename minus `.pdf`** | e.g. `cv-taher-jamali-langchain-applied-ai` |
| E Reference Link | report `**URL:**` → `=HYPERLINK("<url>","Link")` | |
| F Location | `config/profile.yml` → `profile.location` = `"Austin, TX"` | all 24 existing rows use exactly this; it's the candidate's base, not the job's — the `COUNTIF(F:F,"* TX")` formulas depend on it |
| G Referral | `Yes` if report `via:` non-null or notes mention a referral, else `No` | |
| H Response | status map below | |

**Status map** — constrained to the five dropdown values (H3):

| career-ops | sheet |
|---|---|
| Applied | `Submitted - Waiting` |
| Responded | `Submitted - Waiting` |
| Interview | `Interviewing` |
| Offer | `Offer Received` |
| Hired | `Offer Accepted` |
| Rejected | `Rejected` |
| Discarded | *not synced* — see below |
| Evaluated, SKIP | *not synced* |

`Discarded` means the candidate withdrew or the posting closed; no dropdown value fits, and `Rejected` would be a false statement about what the company did. If a row already in the sheet becomes `Discarded`, **leave column H as-is and report it in the run summary** for manual handling.

The map lives in the plugin's `config/plugins.yml` settings block (user layer) so it's editable without touching code.

### 2.4 Delta trigger — journal + cursor, never inside the lock

`set-status.mjs` writes `data/status-log.tsv` **inside its tracker lock**:

```
93	2026-08-03	Evaluated	Applied	set-status
82	2026-08-18	Applied	Rejected	set-status
```

Do **not** call the Sheets API from inside that lock. Network latency would hold a file lock for seconds, and a network failure must never fail a status write.

Instead, treat `status-log.tsv` as the change journal and keep a cursor:

- `set-status.mjs` gains `sheetSyncCandidate: true` on its JSON result — a ~2-line change mirroring the existing `followupSeedCandidate` hook. Signal only, no network.
- `node sheets-sync.mjs --since-log` runs **after** the lock releases, reads the journal from the stored cursor, pushes everything new.
- The cursor advances **only on a successful write**.

This is the answer to "is there a better way": crash-safe and idempotent by construction. Network down, laptop closed, sync fails — the cursor doesn't move and the next run catches up. No lost updates, no double writes, no ordering assumptions.

**The cursor is also what makes the plugin architecture work** (§3): because scope lives in the state file rather than in a command-line argument, the entry point needs no parameters. See §3.2.

Wire it two ways:

1. `npm run status -- <args>` → `node set-status.mjs "$@" && node plugins.mjs run sheets export`
2. A rule in `modes/_custom.md` (user layer): after any `set-status`, run the export.

### 2.5 State file

`data/sheets-sync-state.json` — the plugin's own cursor, exactly the pattern `plugins/gmail/index.mjs` already uses for `data/gmail-state.json`:

```json
{
  "statusLogCursor": 4,
  "rows": { "lightspeed systems|software engineer ai native": { "tab": "Apply 2026", "row": 25, "hash": "…" } }
}
```

The hash guards against blind writes: if the row at the remembered position no longer matches, re-locate by join key rather than overwrite whatever moved into that slot.

**Absence of this file means "full sync."** That makes the first run a full rebuild automatically, and makes `rm data/sheets-sync-state.json` the legible "resync everything" gesture — no flag needed.

### 2.6 Safety rails

- **Backup before every write.** Dump the target tab's `A1:J<last>` — values *and* formulas *and* hyperlinks — to `data/sheet-backups/{tab}-{ISO}.json`. Cheap, and the only real undo.
- **`--dry-run` prints the exact `batchUpdate` payload.** The CLI already routes `--dry-run` into `ctx.dryRun`, so this rail is free.
- **Row cap.** Refuse to write more than `max_rows_per_run` (default 50), overridable via the plugin's settings block, so a parser bug can't flatten the sheet.
- **Never** `values.clear` outside A:H, `DeleteDimension`, `SortRange`, or any write to I/J.
- **Scope minimization.** Mint `spreadsheets.readonly` for dry runs; request write scope only when actually writing.
- Only `Apply 2026` is a write target. Rows dated outside 2026 are skipped and reported, never routed to a prior-year tab.

---

## 3. Architecture: a bundled plugin at `plugins/sheets/`

**This supersedes the earlier root-script recommendation.** Two of the three objections raised against the plugin path were wrong on the facts, and the third is dormant. Corrected below.

### 3.1 What the plugin contract actually permits

Verified by reading `plugins.mjs`, `plugins/_engine.mjs`, and all three bundled plugins.

| Concern | Finding |
|---|---|
| "A plugin gets no file handle, so it can't read status-log / pdf-index / reports / profile.yml" | **Wrong.** That line in `_types.js` describes what the engine *hands* the hook, not a prohibition. `_types.js` says outright the ctx is "a CONVENIENCE not a security sandbox — plain ESM cannot isolate a module's ambient imports." **All three bundled plugins import `fs` directly**: `gmail/index.mjs`, `apify/index.mjs`, `notion/_notion.mjs` (which reads `templates/states.yml`). |
| "A plugin can't keep a cursor" | **Wrong.** `plugins/gmail/index.mjs` keeps `data/gmail-state.json` with `loadProcessedIds()` / `saveProcessedIds()` — the exact pattern §2.5 needs, already in-tree. |
| HTTP through the egress guard | ✅ `ctx.fetch` takes `method`/`headers`/`body`, follows redirects with per-hop re-validation and cross-host credential strip. The engine's own comment names Google as a motivating case. |
| `allowedHosts` | ✅ `["oauth2.googleapis.com", "sheets.googleapis.com"]`. `gmail` already declares `oauth2.googleapis.com` — direct precedent. |
| `requiredEnv` denylist | ✅ `GOOGLE_*` is not in `RESERVED_ENV` and doesn't match `^AWS_`. |
| `humanInTheLoop: true` | ✅ Required and honest — this writes to the user's own sheet, never submits an application. |
| `plugins.lock` consent friction | ✅ Non-issue during development: `lockGate` auto-repins `drift-nobump` for `source === 'bundled'`, i.e. anything under `plugins/`. |
| `plugins/` is system layer | Real, but **dormant** — this fork is deliberately not taking updates (v1.24.0 vs upstream v1.31.0, `.update-dismissed` in place). Cost is a future merge conflict in a directory nothing upstream will touch. |

The one thing that genuinely *is* constrained is argument passing — §3.2.

### 3.2 The export hook takes no arguments — and shouldn't need to

`cmdRun` does `const positional = args.filter(a => a !== '--dry-run')`, then the `export` branch calls `runHook('export', snapshot, …)` and **ignores every remaining positional**. So `node plugins.mjs run sheets export --report 114` cannot work. (Only `search` and `notify` consume `positional.slice(hookArgStart)`.)

Three ways around it, in order of preference:

1. **Put the scope in the cursor, not in an argument — recommended.** `export` means "reconcile the sheet." The plugin reads `data/status-log.tsv` plus its own state file and decides scope itself. This is why §2.5 exists, and it removes the need for arguments entirely:

   | Situation | Command | Behaviour |
   |---|---|---|
   | First ever run | `node plugins.mjs run sheets export` | no state file → **full sync** |
   | After a `set-status` | `node plugins.mjs run sheets export` | replays the journal from the cursor → **delta** |
   | Force a rebuild | `rm data/sheets-sync-state.json` then export | **full sync** |
   | Force a rebuild, keeping state | `SHEETS_SYNC_MODE=full node plugins.mjs run sheets export` | **full sync** |

   `SHEETS_SYNC_MODE` goes in `optionalEnv`, so it reaches `ctx.env` with no core change. One command, no flags, and the two modes can't drift because they're one reconciler (§2.1).

2. **Declare `notify` as a second hook** for the parameterized case — `hooks: ["export","notify"]`, then `node plugins.mjs run sheets notify "114"` arrives as `{message:"114"}`. It works today with no core change, but it abuses a hook whose contract is "outbound, ephemeral notification." Available if a per-report override is ever wanted; not recommended as the primary path.

3. **Patch `plugins.mjs` to forward positionals to `export`.** ~2 lines, but it's a system-layer change to shared dispatch, and option 1 makes it unnecessary.

### 3.3 The one real cost: the 15-second hook timeout

`runHook` races every hook against `DEFAULT_HOOK_TIMEOUT_MS = 15_000`, and `plugins.mjs` never passes `timeoutMs` — so it is not configurable from `plugins.yml`. Worse, the engine documents it as **cooperative**: `Promise.race` resolves the wait but does **not** abort the plugin. For a *write* hook that is a specific hazard — a slow full rewrite reports `ok: false` while the write actually lands, and a cursor that advances only on success would then re-write on retry.

Four mitigations, all of which the design should carry:

- **Batch the writes.** The full rewrite is 2–4 API calls total (one `values.update` for `A2:H<n>`, one `batchUpdate` for formats/validation). Note `plugins/notion/index.mjs` loops one HTTP call *per row* — that pattern would blow 15s at 37 rows and must not be copied.
- **Make every write idempotent.** The reconciler is a diff, so a repeat is a no-op. This is already true by construction.
- **Persist the cursor immediately after the API call returns**, not after the hook returns, so a post-write timeout can't lose it.
- If a legitimately long run is ever needed, pass `timeoutMs` from `plugins.mjs` — a 1-line system-layer change, deferred until actually required.

### 3.4 Layout

`_`-prefixed files are never discovered as plugins, so helpers sit beside the entry module exactly as `notion/_notion.mjs` does.

```
plugins/sheets/
  manifest.json     # id, hooks:["export"], requiredEnv, allowedHosts, humanInTheLoop
  index.mjs         # the export hook — thin: resolve scope, call _sync, return {pushed}
  _auth.mjs         # service-account JWT → access token, in-process cache
  _sheets.mjs       # Sheets API: read tab w/ hyperlinks+validation, serial↔date, A1 helpers
  _reconcile.mjs    # pure: (sheetRows, trackerRows, config) → write plan. No I/O, fully testable.
  _sources.mjs      # status-log, pdf-index, report headers, profile.yml
  skill.md          # how to drive it (loaded via `node plugins.mjs skill sheets`)
```

`manifest.json`:

```json
{
  "id": "sheets",
  "name": "Google Sheets sync",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Mirror your application tracker into your own Google Sheet.",
  "hooks": ["export"],
  "requiredEnv": ["GOOGLE_SHEET_ID", "GOOGLE_AUTH_PATH"],
  "optionalEnv": ["GOOGLE_SYNC", "SHEETS_SYNC_MODE"],
  "allowedHosts": ["oauth2.googleapis.com", "sheets.googleapis.com"],
  "skill": "skill.md",
  "humanInTheLoop": true
}
```

Keeping `_reconcile.mjs` pure is the point of the split: the join, date ordering, and A:H-only write planning are where the bugs live, and they get tested against fixtures with no network and no plugin engine.

### Files

**New**

| File | Layer | Purpose |
|---|---|---|
| `plugins/sheets/*` | system | as above |
| `config/plugins.yml` | **user** | must be created — doesn't exist yet; holds `sheets.enabled: true` + the status map, tab name, location default, row cap |
| `tests/sheets-reconcile.test.mjs` | system | fixture tests for the pure planner; auto-discovered by `test-all.mjs` |

**Modified**

| File | Change |
|---|---|
| `set-status.mjs` | add `sheetSyncCandidate` to JSON result (~2 lines, mirrors `followupSeedCandidate`) |
| `doctor.mjs` | non-blocking warning when `GOOGLE_SYNC=true` but the plugin is disabled or keys are missing |
| `AGENTS.md` | plugin note + skill-mode row |
| `.env.example` | document the three vars |
| `package.json` | `sheets:sync`, `sheets:sync:dry` |
| `.gitignore` | `data/sheet-backups/`, `data/sheets-sync-state.json` |
| `modes/_custom.md` | **user layer** — "after `set-status`, run the sheets export" |

Per the Data Contract, the status map, location default, and tab config are user-facing targeting data — they belong in `config/plugins.yml`, never in `modes/_shared.md`.

**Note on `GOOGLE_SYNC`:** the plugin's real on/off switch becomes `enabled: true` in `config/plugins.yml`, which is the engine's own gate. `GOOGLE_SYNC` is kept as `optionalEnv` and honoured as a second kill-switch (`GOOGLE_SYNC=false` → no-op), so the flag already in `.env` keeps meaning what it looks like it means.

---

## 4. Order of work

1. **Scaffold + gates.** `plugins/sheets/manifest.json`, stub `index.mjs`, create `config/plugins.yml`. Confirm `node plugins.mjs list` shows `sheets [export] — ✅` and `node doctor.mjs --json` reports it enabled with no missing env.
2. **Read path.** `_auth.mjs` + `_sheets.mjs`: JWT auth, tab read including hyperlinks and validation, serial↔date.
3. **Pure planner.** `_reconcile.mjs` + fixture tests. The join, date ordering, A:H-only planning — all tested offline.
4. **Dry run.** `node plugins.mjs run sheets export --dry-run` prints the full 37-row plan and the exact payload. **Review the 13 backfill rows by hand before anything is written.**
5. **First write.** Backup, then the real export. Verify in the browser that I/J formulas still compute, all 37 links click through, and dropdowns reach row 38.
6. **Delta.** Cursor persistence, `set-status.mjs` signal, `npm run status` wrapper, `modes/_custom.md` rule, `skill.md`.

Steps 1–5 are independently useful; the sheet is correct and current at the end of step 5 even if step 6 is deferred.

---

## 5. Known imperfections in the first backfill

Not blockers — things to expect and hand-correct once.

- **Apply dates for the 13 backfill rows will mostly be evaluation dates.** `data/status-log.tsv` has only 4 entries; it started recording partway through this search. Reports 33, 34, 59, 62, 72, 82, 96, 106, 113, 114 will fall back to the tracker's evaluation date, which runs a few days later than the true apply date. Correct by hand in the sheet afterward — the reconciler treats the sheet as authoritative on Date, so corrections stick.
- **`Referral` detection is heuristic.** `via:` is `null` on most reports; report #82 records "Applying via friend referral at Oura" in prose only. Expect a few manual fixes.
- **`Discarded` has no dropdown value** — specified as leave-and-warn. If a sixth value is wanted, add it in the sheet UI first.
