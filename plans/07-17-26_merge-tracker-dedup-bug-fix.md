# Fix merge-tracker.mjs's dedup bug (silent tracker-row corruption)

## Context

During this session's live `batch-runner.sh` test run, `merge-tracker.mjs` silently overwrote two *different* tracker rows with data from unrelated job postings — the second occurrence of a pattern I'd already hand-fixed once earlier in the session. Both incidents lost the original row's data from `data/applications.md` (the report `.md` files themselves stayed intact on disk, so no evaluation work was actually lost, but the tracker — the single source of truth for "what have I evaluated and at what score" — silently became wrong twice).

**Root cause (confirmed via Explore agent + direct code read):** `merge-tracker.mjs`'s third-tier dedup check (`merge-tracker.mjs:560-587`) decides whether an incoming TSV row is a *duplicate update* to an existing tracker row using `roleFuzzyMatch()` from `role-matcher.mjs` — a token-overlap (Jaccard ≥ 0.6) fuzzy title matcher. That threshold is trivially crossed by **short titles that happen to reduce to a near-identical content-token set**, even when the postings are genuinely different:

- "Senior Solutions Architect - Europe" vs. "Solutions Architect (EST or PST)" both reduce to the token set `{solutions, architect}` after stopword/seniority stripping → Jaccard = 1.0 → falsely matched, and row #4 (score 1.5/5) was overwritten with row #13's data (score 2.7/5).
- "Software Engineer, Voice Agents & AI (Senior or Staff Level)" vs. "Senior Software Engineer - Saga / Voice OS" share `{software, engineer, voice}` → Jaccard = 3/5 = 0.6, exactly at the threshold → falsely matched, and row #16 (3.7/5) was overwritten with row #33's data (4.1/5). (Both fixed by hand this session; `verify-pipeline.mjs` now clean.)

**This bug class is already known and already fixed elsewhere in the same codebase.** `dedup-tracker.mjs` has its own separate, *exact*-string role matcher (`dedup-tracker.mjs:188-220`), with a docstring explicitly stating fuzzy matching "collapsed distinct sibling roles at one company... causing real data loss" and was deliberately replaced. That fix was never carried over to `merge-tracker.mjs`'s live auto-merge path, which still uses the fuzzy matcher for a silent, unattended overwrite decision — a strictly more dangerous context than `dedup-tracker.mjs`'s (which is a separate, human-invoked cleanup pass).

**No existing regression test covers this failure mode.** `test-all.mjs`'s merge-tracker fuzzy-dedup tests (`:4064-4123`, `#751`/`#947`) all exercise the *opposite* direction — long titles with a shared prefix or brand token, where the Jaccard-over-union formula correctly keeps them separate. None test *short* titles whose entire token sets nearly or fully coincide, which is exactly how the two real incidents happened.

## Decision

Replace tier-3's fuzzy match with **exact, normalized role-string comparison** — reusing the same normalization `dedup-tracker.mjs` already uses and has proven safe (case-fold + whitespace-collapse, no punctuation stripping, no stopword removal). `roleFuzzyMatch` is used nowhere else inside `merge-tracker.mjs` (confirmed via grep — single call site, line 566), so this is a one-line behavioral change plus its supporting plumbing.

Checked against the existing "distinct roles vs reposts" test fixture (`test-all.mjs:4064-4123`) line by line: its "true repost" case uses a **byte-identical** role string with only the score changed — exact matching handles it trivially. Its two "must stay distinct" cases (long shared prefix, shared brand token) are non-identical strings — exact matching correctly keeps them separate too. So this fix passes the existing suite without modification, in addition to fixing both real incidents.

`roleFuzzyMatch`'s other three consumers (`find.mjs` fuzzy search, `detect-reposts.mjs` advisory clustering, `set-status.mjs` CLI candidate-narrowing before a human picks the target row) are all read-only or human-mediated — they stay on fuzzy matching, since a wrong *suggestion* is recoverable but a wrong *silent overwrite* is not. `roleFuzzyMatch` itself is not touched.

## Steps

### 1. Add exact-match helper to `role-matcher.mjs`
Add and export `normalizeRole(role)` (case-fold + whitespace-collapse + trim — identical to `dedup-tracker.mjs:188-193`'s local version) and `roleExactMatch(a, b)` (thin wrapper: `normalizeRole(a) === normalizeRole(b)`).

### 2. Fix `merge-tracker.mjs`'s tier-3 check
- `merge-tracker.mjs:22` — import `roleExactMatch`.
- `merge-tracker.mjs:566` — replace `roleFuzzyMatch(addition.role, app.role)` with `roleExactMatch(addition.role, app.role)`.
- `merge-tracker.mjs:560` comment — "Company + role fuzzy match" → "Company + role exact match".
- `merge-tracker.mjs:11` top docstring — "role fuzzy match" → "role exact match".

### 3. (Optional, low-risk cleanup) Point `dedup-tracker.mjs` at the shared helper
Replace its local `normalizeRole` (`:188-193`) with the newly-shared one from `role-matcher.mjs`.

### 4. New regression test in `test-all.mjs`
Add a test block after the existing "distinct roles vs reposts" test (`:4064-4123`), same fixture harness. Reproduce both real incidents verbatim, assert both rows survive after merge.

### 5. Testing phase
Throwaway `process/scripts/test-role-exact-match.mjs` asserting against all 5 known cases before touching real files.

## Verification

- Scratch script (step 5) — 5/5 assertions pass.
- Full `node test-all.mjs` suite — new test passes, no regressions elsewhere.
- `find.mjs` / `detect-reposts.mjs` / `set-status.mjs` untouched — still use `roleFuzzyMatch` for their own purposes.
