# Add a structured `referred_by` field so the Sheets sync stops treating agency postings as referrals

> **Status: implemented 2026-10-19** on `feat/referred-by` → one PR into `origin/main` (hashes in "Suggested
> Commit Order"). `node test-all.mjs` 3008 passed / 1 failed. The one failure is pre-existing on `main`
> and unrelated (see "Implementation notes"). `verify-pipeline.mjs` 0 errors after the backfill.
> `npm run sheets:sync:dry`: 117 existing rows, 0 added, 0 updates. No real sheet write.

## Context

The Google Sheets sync fills column G (Referral) with `isReferral()` (`plugins/sheets/index.mjs:56`):

```js
function isReferral(row, facts) {
  if (facts.via) return true;
  return /\breferr(al|ed)\b/i.test(String(row.notes ?? ''));
}
```

`facts.via` is the report's Machine Summary `via:` key (`plugins/sheets/_sources.mjs:132`). In career-ops
`via` means **an agency or recruiter in the middle** (#1596: company `?`, `via={Agency}`), not a personal
referral. The sync plan wrote the conflation down (`plans/08-31-26_google-sheets-sync.md:148`, `:170`,
and `:376`, which calls referral detection a guess).

Result: report #293 (UMATR, an agency posting) synced as Referral = Yes. #226 (NJF Global, also an
agency) would do the same once it reaches Applied.

### Audit — what reads as a referral today

Every tracker row where either signal fires (`node` script over `reportFacts()` + the notes regex,
2026-10-19):

| # | Company | Status | Report `via` | Notes regex | Real referral? |
|---|---|---|---|---|---|
| 293 | ? (UMATR) | Applied | `UMATR` | no | **No** — agency |
| 226 | ? (NJF Global) | Evaluated | `NJF Global Holdings Ltd` | no | **No** — agency |
| 284 | Bain & Company | Applied | — | "Referred by Mustansir" | Yes |
| 283 | Bain & Company | Applied | — | "Referred by Mustansir" | Yes |
| 282 | Bain & Company | Applied | — | "Referral from a team member; Referred by Mustansir" | Yes |
| 275 | 1Password | Applied | — | "Referred by Khuzaima" | Yes |
| 274 | SAP | Applied | — | "Referred by Kai" | Yes |
| 271 | Microsoft | Applied | — | "Referred by Murtaza" | Yes |
| 265 | Amazon | Applied | — | "Referred by Mohammed" | Yes |
| 82 | Oura | Rejected | — | "Applying via friend referral at Oura" | Yes |

The brief named #275 and #282–284. The audit also finds **#265, #271, #274 and #82**, each with a
"Referred by …" / "friend referral" note the user wrote. The notes regex already catches them; they are
included in the backfill below because their source is the user's own tracker note.

Only #293 is wrong today. The regex has no false positive in the current tracker (`\breferr…\b` does not
match "preferred").

### Every reader of the Machine Summary / `via`

| Where | What it does with `via` / the fence | Change needed? |
|---|---|---|
| `batch/batch-prompt.md` "Machine Summary" | **Schema source of truth** | Add the key + a rule |
| `modes/oferta.md:516` (header `**Via:**`), `:561` (pointer paragraph), `:569` (tracker Via) | Report format | Add a pointer sentence for the key |
| `lib/report-summary.mjs` `parseMachineSummary()` | Generic: passes every top-level key through, `partial` fallback included | No parser change. Add `referredBy()` + `checkReferredBy()` helpers so the rule lives in one place |
| `plugins/sheets/_sources.mjs` `reportFacts()` | Reads `via` → `facts.via` | Also return `referredBy` |
| `plugins/sheets/index.mjs` `isReferral()` | `via` → Yes | **The bug.** Stop reading `via` |
| `analyze-patterns.mjs` `MACHINE_SUMMARY_FIELDS` | Allowlist; unknown keys are dropped | Add `referred_by` so it round-trips |
| `test-all.mjs:1772` | Asserts batch schema fields ⊆ `MACHINE_SUMMARY_FIELDS` (via, company_confidential) | Extend to `referred_by` |
| `verify-pipeline.mjs` | Checks parse + job location only | New Check 15 (see D1) |
| `followup-cadence.mjs`, `merge-tracker.mjs`, `tracker-parse.mjs`, `verify-pipeline.mjs` Via checks, `web/`, dashboard Go | Read the **tracker** Via column, not the report key | No — `via` semantics unchanged |
| `salary-gap.mjs`, `upskill.mjs` | Read other keys through the shared reader | No |
| Go dashboard | Reads `work_mode` / `job_location` only | No |

`via` keeps its meaning everywhere. Nothing outside the sheet sync conflated it with a referral.

## Decisions

### D1. Key name and type — `referred_by`

```yaml
referred_by: {who referred the candidate or how, as a quoted string (e.g. "Khuzaima", "friend at Oura"), or null}
```

- A name or relationship, nothing else. **Never** an email, phone number, URL, password or any other
  credential or contact detail.
- `null` when there is no referral. Placed directly after `via:` so the two read as a pair.
- `—` / `-` / empty read as null (same as `via`), so a hand-typed dash is harmless.
- `verify-pipeline.mjs` Check 15 errors on a value that is not a string/null, or that looks like
  contact details (contains `@`, a URL, or a 7+ digit run). A missing key is **not** flagged: reports
  before the key existed are expected to lack it, and the notes fallback covers them (D3).

### D2. How the field gets set

- **Interactive evaluation (`oferta` / auto-pipeline):** non-null only when the user states a referral
  in the conversation, or it is already recorded in an in-scope file (e.g. a tracker note the user
  wrote for this application). Otherwise `null`.
- **Batch workers:** always `null`. They have no conversation and the JD is the only input.
- **Never inferred** from the JD ("employee referral program", "referrals welcome"), from `via`, from a
  recruiter's outreach, or from company research.

### D3. Notes fallback — kept, as an OR

`isReferral = referredBy(report) != null OR notes regex`. `via` is never consulted.

Why keep the regex rather than replace it with a backfill:

- Referrals usually surface **after** evaluation, at apply time, and get recorded with
  `set-status.mjs <#> Applied --note "Referred by X"` — that is how #265, #271 and #274 got theirs.
- A row joins the sheet when it reaches Applied, which is exactly when that note is written. The
  report's `referred_by` is fixed at evaluation time and is usually `null` then.
- So the note is the timely signal and the key is the evaluation-time one. Dropping the regex would make
  every post-evaluation referral read No unless the report were hand-edited.

`referred_by: null` does **not** veto a notes mention: null means "no referral known at evaluation".
Known residual risk: a note like "no referral" would read Yes. None exists today.

### D4. Backfill (user data, gitignored, not committed)

One-time edit of `reports/*.md`, inserting the key directly after `via:` in the Machine Summary fence:

| # | `referred_by` | Source |
|---|---|---|
| 275 | `"Khuzaima"` | tracker note + report `## Referral` section |
| 282 | `"Mustansir (team member)"` | tracker note + report body (user-stated 2026-10-12) |
| 283 | `"Mustansir"` | tracker note |
| 284 | `"Mustansir"` | tracker note |
| 265 | `"Mohammed"` | tracker note |
| 271 | `"Murtaza"` | tracker note |
| 274 | `"Kai"` | tracker note |
| 82 | `"friend at Oura"` | tracker note |
| 226 | `null` | agency posting (via NJF Global) |
| 293 | `null` | agency posting (via UMATR) |

All other reports are left without the key. Done with a scratchpad script, not a committed one (10
reports; nothing reusable). `verify-pipeline.mjs` must stay at 0 errors afterwards.

Column G is sheet-owned on existing rows (`_reconcile.mjs:121-131`; only F and H are career-ops-owned),
so the backfill changes **nothing** in the live sheet. The user fixes #293's G cell by hand.

### D5. Report header — no `**Referred by:**` line

The YAML key is the single source; nothing parses report headers for it. A header copy would be a second
place to update and could drift (see the shared-logic rule). `**Via:**` stays in the header because the
#1596 confidential-agency flow is read by humans there. #275 already has a `## Referral` section in the
body, which is the right place for prose about a referral. Easy to add later if wanted.

## Steps

1. **Schema** — `batch/batch-prompt.md`: add `referred_by` after `via:` in both Machine Summary blocks,
   plus a rule (D1, D2). `modes/oferta.md:561`: one pointer sentence (who sets it, never from the JD).
2. **Shared helpers** — `lib/report-summary.mjs`: `referredBy(summary) → string|null` and
   `checkReferredBy(summary) → { state: 'ok'|'missing'|'invalid', reason }`. Tests in
   `tests/report-summary.test.mjs`.
3. **Allowlist** — `analyze-patterns.mjs` `MACHINE_SUMMARY_FIELDS` + the `test-all.mjs` alignment check.
4. **Validator** — `verify-pipeline.mjs` Check 15; `tests/verify-pipeline-referred-by.test.mjs`.
5. **Sheets fix** — `reportFacts()` returns `referredBy`; `isReferral()` moves to `_sources.mjs` (exported,
   pure, testable) and reads `referredBy` + notes, never `via`. `tests/sheets-referral.test.mjs`:
   - `via` set, no `referred_by`, no note → No
   - `referred_by` set → Yes
   - `referred_by: null` + "Referred by X" note → Yes (fallback)
   - legacy report (no key) + note → Yes; no key, no note → No
   - `via` set **and** `referred_by` set → Yes (an agency role you were also referred to)
6. **Docs** — `plans/08-31-26_google-sheets-sync.md` lines 148/170/376; `plugins/sheets/skill.md` gets a
   short "Column G (Referral)" section.
7. **Backfill** (D4) — no commit.
8. `node test-all.mjs`, `node verify-pipeline.mjs`, `npm run sheets:sync:dry` → show the user. No real
   sheet write.

## Verification

- `node test-all.mjs` green.
- `node verify-pipeline.mjs` 0 errors on the real data after the backfill.
- Re-run the audit: #293 and #226 → No; the eight referrals → Yes.
- `npm run sheets:sync:dry`: no column G change on existing rows (sheet-owned), nothing else unexpected.

## Suggested Commit Order

| # | Commit | Step | Files |
|---|---|---|---|
| 0 | `docs(plans): plan a structured referred_by field for the sheets sync` ✅ `3c93235` | — | this plan |
| 1 | `feat(batch-prompt): add referred_by to the Machine Summary` ✅ `a21f22f` | 1 | `batch/batch-prompt.md`, `modes/oferta.md` |
| 2 | `feat(lib): add referred_by helpers to the shared Machine Summary reader` ✅ `f95908f` | 2, 3 | `lib/report-summary.mjs`, `tests/report-summary.test.mjs`, `analyze-patterns.mjs`, `test-all.mjs` |
| 3 | `feat(verify-pipeline): flag referred_by values that are not a name` ✅ `b6fcd74` | 4 | `verify-pipeline.mjs`, `tests/verify-pipeline-referred-by.test.mjs` |
| 4 | `fix(sheets): stop marking agency postings as referrals` ✅ `38bc457` | 5 | `plugins/sheets/_sources.mjs`, `plugins/sheets/index.mjs`, `tests/sheets-referral.test.mjs` |
| 5 | `docs(sheets): define column G from referred_by and tracker notes` ✅ `da976fc` | 6 | `plans/08-31-26_google-sheets-sync.md`, `plugins/sheets/skill.md` |
| — | *(no commit)* backfill 10 reports ✅ | 7 | `reports/*.md` (gitignored) |
| — | *(no commit)* `npm run sheets:sync:dry` → shown to the user ✅ | 8 | — |
| 6 | `docs(plans): mark the referred_by plan complete` | — | this plan |

## Implementation notes

- **`reportFacts()` no longer returns `via`.** Its only consumer was `isReferral()`, so the field was
  replaced by `referredBy` rather than kept as dead data that invites the same mistake again.
- **`isReferral()` moved from `index.mjs` to `_sources.mjs`** and is exported. `index.mjs` has no
  test seam, and the function belongs next to `reportFacts()`, which produces its input.
- **Backfill** ran from a scratchpad script (backups of the 10 files kept there). Every report had exactly
  one `via:` line in its fence; the key went directly after it. Re-audit: the eight referrals read Yes,
  #226 and #293 read No.
- **Dry run.** `npm run sheets:sync:dry`: `plan: 117 row(s) — 117 existing, 0 added, 0 row update(s)`.
  The backfill changes nothing in the sheet because G is sheet-owned on existing rows. #293's G is still
  `Yes` in the sheet, and the user is fixing it by hand. The dry run also logs `no location for #275`. That
  is a pre-existing placeholder report with no `work_mode` / `job_location`, and it is unrelated to this change.
- **Pre-existing test failure.** `tests/company-funded.test.mjs` ("structured fetch behavior wrong")
  fails on `main` too. Its RSS fixture hardcodes `pubDate` 15 Jul 2026 with a 3-month window, so it
  started failing on 2026-10-15. Left for a separate fix.
