# Fix tailored-CV filename collisions (silent CV overwrite in batch runs)

> **Status: complete 2026-09-08** on `fix/cv-filename-collisions`. Steps 1-6 (the fix) landed as commits;
> Step 7 (remediation) is done as a record-only pass against gitignored user data.
>
> Two deviations from the plan as written, both recorded below:
> - **Step 5 (`openai-tailor.mjs`) was dropped** — unreachable in this Anthropic-only fork. See
>   "Corroboration (not in scope to fix)". Remaining steps renumbered.
> - **`/tmp` render payloads were also keyed on `{NNN}`** (not in the original plan). Found during the final
>   sweep: `/tmp/cv-{candidate}-{company}.json` carried the same defect, and it is worse than a filename
>   clash — the payload is written in one step and read in the next, so an overwrite renders *another role's
>   content* under the correct filename.

## Context

When a batch evaluates several roles at the **same company**, every worker writes its tailored CV to the same two paths and the last writer wins. All earlier workers' tailored CVs are destroyed, while their reports keep claiming a `**PDF:**` path that now holds someone else's CV.

**Root cause:** the tailored-CV filename is keyed on `{company-slug}` only — it carries no per-role or per-report component, unlike every other artifact in the pipeline.

- `batch/batch-prompt.md:408` — `Write HTML to output/cv-candidate-{company-slug}.html`
- `batch/batch-prompt.md:413-414` — `generate-pdf.mjs output/cv-candidate-{company-slug}.html output/cv-candidate-{company-slug}-{{DATE}}.pdf`
- `batch/batch-prompt.md:331` — the report header records that same shared path

Reports (`{NNN}-{slug}-{date}.md`) and cover letters (`{company-slug}-{role-slug}-cover.pdf`, `modes/cover.md:315`) both carry a disambiguator. CVs are the one artifact that does not.

### Confirmed live damage

The 2026-09-02 batch (`batch/batch-input.tsv`) held 3 Perplexity, 3 Supabase and 4 Hightouch roles. Reports 135-145 and 148 are all Perplexity; exactly **one** `output/cv-candidate-perplexity*` file exists.

Three reports claim the same PDF, and all three are marked `Applied` with `✅` in `data/applications.md`:

| Report | Role | Status | Claimed PDF |
|---|---|---|---|
| 141 | MTS (SWE, Backend Platform) | Applied | `output/cv-candidate-perplexity-2026-09-02.pdf` |
| 144 | MTS (SWE, Enterprise Adoption) | Applied | *same file* |
| 145 | MTS (SWE, Agent Capabilities) | Applied | *same file* |

`data/pdf-index.tsv` attributes the surviving file to report **144**, so 141's and 145's tailored CVs no longer exist on disk. If the user attached the on-disk file when applying to all three, **all three Perplexity applications carry the Enterprise Adoption CV.** ~~The same shape applies to the Hightouch group (149-152) and the 2026-07-30 Sierra group (083-086, 092).~~ **Corrected during Step 7:** it does not. A CV is only generated above `auto_pdf_score_threshold` (4.0), and in those two groups exactly one row cleared it — Hightouch 151 (4.1) and Sierra 092 (4.0) — so one CV was generated in each and nothing collided. The Perplexity trio is the only affected group. See Step 7.

A batch worker already diagnosed this in its own log — `batch/logs/144-52.log:16`:

> "this batch shares `output/cv-candidate-perplexity.html`/`.pdf` filenames with several other Perplexity reports evaluated today (per the company-slug-only naming convention in this pipeline spec), so the tailored file I generated overwrote the previous Perplexity CV"

The worker reported it and continued, because the naming convention it was told to follow left it no alternative.

### Secondary symptom: the manifest silently drops the linkage too

`generate-pdf.mjs:392`, inside `updatePDFManifest`:

```js
if (fields[1] === relPDF) return false;   // drop any existing row with this PDF path
```

The rule exists so a regenerated CV supersedes its own stale row. With a colliding path it also evicts rows belonging to **other reports**: reports 141 and 145 have no manifest row at all, so `find.mjs`, `outcome.mjs`, `sync-pdf-flags.mjs` and the dashboard all report "no PDF" for them despite `✅` in the tracker.

The dashboard's fallback, `dashboard/internal/data/pdf.go:267 ResolveHTML`, globs `output/cv-*{companySlug}*.html` and takes the newest — so for a multi-role company it hands the *same wrong* CV to every row that lacks a manifest entry.

### Why the existing bundle system doesn't cover it

`application-artifacts.mjs` already builds a collision-proof key — `{NNN}-{company}-{role}` (`application-artifacts.mjs:36`) — but it is opt-in, documented in `modes/pdf.md` only for the reuse/lightly-tailored case, and the batch prompt never invokes it. Flat `output/` paths stay the default for one-off CVs.

### Corroboration (not in scope to fix)

`openai-tailor.mjs` carries a half-fix of the same bug — `:321` puts `roleSlug` in the suggested PDF name while `:314` writes the HTML without it — which confirms the collision is a known-but-unfinished concern upstream, not a local misconfiguration.

**Not fixed here.** This fork is Anthropic-only: nothing in the pipeline invokes that script (its only callers are `npm run openai:tailor` and two doc mentions), no `OPENAI_API_KEY` is configured, so it exits at `:157` before doing anything, and it is upstream system-layer code (`update-system.mjs:222`). Editing it would be churn on a path this fork never runs.

## Decision

**Add the report number to the flat tailored-CV filename.** It is guaranteed collision-free (`reserve-report-num.mjs` allocates it atomically), already substituted into the batch prompt as `{{REPORT_NUM}}`, and it is the key every downstream consumer already uses.

```
HTML: output/cv-{candidate}-{company-slug}-{NNN}.html
PDF:  output/cv-{candidate}-{company-slug}-{NNN}-{YYYY-MM-DD}.pdf
```

pairing 1:1 with `reports/{NNN}-{company-slug}-{YYYY-MM-DD}.md`.

Rejected alternatives:

- **Role slug** — readable, but two sibling reqs with near-identical titles still collide, and names grow unbounded. (Human readability is already served: `find.mjs` and `pdf-index.tsv` map `NNN` back to company + role.)
- **Force everything into bundle dirs** — correct but a much larger change to the batch path, the dashboard's `D` handler and the manifest's flat-path support. The bundle stays available; this fix makes the flat default safe.

Compatibility checks done:

- `dashboard/internal/data/pdf.go:166 rePDFDate` is `(\d{4}-\d{2}-\d{2})\.pdf$` — the date stays last, so newest-first sorting is unaffected.
- `matchesCompanySlug` (`pdf.go:215`) is a substring test — `cv-taher-jamali-perplexity-144.html` still matches slug `perplexity`.
- `viewer.go:496 reRelPDFPath` matches `output/cv-[^\s...]+\.pdf` — unaffected.
- No test asserts the segment structure; all are fixture paths under `output/cv-*`.

Report numbers are unavailable only for a one-off CV with no tracker entry — that case keeps today's name, and cannot collide by definition since there is no batch behind it.

## Steps

### 1. `batch/batch-prompt.md` — the batch path (primary fix)

- `:408` → ``Write HTML to `output/cv-{candidate}-{company-slug}-{{REPORT_NUM}}.html`.``
- `:413-414` → same two paths in the `generate-pdf.mjs` invocation.
- `:331` → report-header `**PDF:**` value picks up `{{REPORT_NUM}}`.
- Add one explicit line under batch-prompt.md's own Step 4: *"The report number in the filename is what keeps two roles at the same company from overwriting each other's CV. Never drop it."* — without the rationale a future worker will "simplify" it back out.

### 2. `modes/pdf.md` — the interactive path **and the `batch-tailor.mjs` fan-out**

- `:40` → one-off HTML becomes `output/cv-{candidate}-{company}-{NNN}.html`.
- `:44` → one-off PDF becomes `output/cv-{candidate}-{company}-{NNN}-{YYYY-MM-DD}.pdf`; note that `{NNN}` is the same value passed to `--report`.
- `:286,291` — Canva export path gets `{NNN}` too.
- State the fallback: when there is no report number (true one-off, no tracker row), keep the current name.

**This step is not just the interactive path — it is the second collision vector, and the one native to this fork.** `batch-tailor.mjs` bulk-generates tailored CVs for every completed batch row scoring ≥ `--min-score` (default 4.0) by spawning `claude -p --append-system-prompt-file modes/pdf.md` once per report (`batch-tailor.mjs:78-85`). Those workers run **sequentially against the same output directory**, so for a multi-role company each one overwrites its predecessor exactly as the batch-prompt path does. On the 2026-09-02 batch its selection set is precisely the affected Perplexity/Hightouch rows.

No code change is needed in `batch-tailor.mjs`: it already resolves `reportNum` from `batch-state.tsv` and passes it into the worker prompt (`:80`), so fixing `modes/pdf.md` fixes this path too. Worth verifying explicitly in Step 7's end-to-end check.

### 3. `modes/latex.md` / `modes/latex-tex.md` — same collision, LaTeX path

- `latex.md:18-19`, `latex-tex.md:57-58` — `.tex` and `.pdf` paths take `{NNN}`. Same bug, same fix; these were missed because they share the flat convention.

### 4. `generate-pdf.mjs` — make the manifest collision loud

In `updatePDFManifest` (`:377-407`), before the `fields[1] === relPDF` eviction: if the row being evicted has a **different, non-empty** report number than the incoming one, print a warning naming both reports and the shared path. The row is still replaced (behavior unchanged), but a same-path/different-report write stops being silent.

This is defense in depth: Steps 1-3 stop the collision at the source, this catches any future path that reintroduces it.

### 5. `docs/RUNNING_ON_A_BUDGET.md:281` — update the example to the new shape.

### 6. Regression tests in `test-all.mjs`

- **Prompt-shape guard:** assert `batch/batch-prompt.md`'s CV HTML and PDF paths both contain `{{REPORT_NUM}}`. This is the test that actually prevents recurrence — the bug lives in a prompt, not in code, so only a text assertion catches its removal.
- **Manifest test:** write a manifest row for report `141` at path `P`, call `updatePDFManifest('144', P, …)`, assert the warning fires. Extends the existing manifest fixtures around `test-all.mjs:7805` / `:8398`.
- Confirm the `output/cv-x.html` CRLF-guard fixture (`:1596-1602`) is unaffected — it is a synthetic path, not the convention.

### 7. Remediate existing damage — DONE (record-only, user-confirmed)

**The blast radius in this plan's Context section was overstated.** It listed Hightouch (149-152) and Sierra
(083-086, 092) as affected because each had several roles at one company and one surviving CV file. That
skipped a gate: `config/profile.yml` sets `auto_pdf_score_threshold: 4.0`, so a CV is only generated for a
report scoring at or above 4.0. Checking each group against it:

| Group | Rows clearing 4.0 | PDFs generated | Collision |
|---|---|---|---|
| Perplexity 2026-09-02 | 141 (4.2), 144 (4.3), 145 (4.3) | 3 | **yes, three-way** |
| Hightouch 2026-09-02 | 151 (4.1) | 1 | no |
| Sierra 2026-07-30 | 092 (4.0) | 1 | no |

Only the Perplexity trio was ever affected. Hightouch and Sierra each generated exactly one CV and needed
nothing.

**What actually happened**, confirmed by the user: they submitted the single surviving file — report 144's
Enterprise Adoption tailoring — for all three Perplexity roles, which is how the bug surfaced. So no CV that
was ever *sent* was lost, and the three reports' `**PDF:**` headers are factually correct: they all name the
document that really went out. What was lost is the 141- and 145-tailored CVs, which were overwritten before
they could be used.

**Resolution — record the truth, regenerate nothing.** A regenerated CV was never submitted; leaving one in
`output/` would invite mistaking it for the real record. If 141 or 145 advances, generate then — the fix is in
place, so it gets its own filename.

1. Tracker notes added via `set-status.mjs --report N Applied --note …` (the canonical write path; status
   unchanged, note appended idempotently):
   - **141** and **145** — record that the submitted CV was 144's Enterprise Adoption tailoring and that no
     role-tailored CV was ever sent. This matters for interview prep: if either advances, the document the
     interviewer holds is tailored for a different role.
   - **144** — record that its CV was also submitted for 141 and 145, so the shared file is legible from any
     of the three rows.
2. `data/pdf-index.tsv` rows added for **141** and **145** pointing at the same submitted PDF, so
   `find.mjs` / `outcome.mjs` / `sync-pdf-flags.mjs` / the dashboard stop reporting "no PDF" for rows the
   tracker marks `✅`. Verified: all three now resolve; `sync-pdf-flags --dry-run` reports 0 changes needed
   and `verify-pipeline.mjs` stays at 0 errors.
3. Existing `output/` files were **not** renamed — `pdf-index.tsv` and the report headers reference them by
   path, so renaming would break correct rows to cosmetically fix broken ones.

Note that these three rows are a deliberate, historical exception to the one-row-per-path rule: they record
one document genuinely submitted for three applications. Regenerating any of the three CVs later will trip the
Step 4 collision warning and drop the other two rows — which is correct, and the warning explains why.

Both files are user-layer and gitignored, so this step leaves no commit.

## Verification

- `node test-all.mjs` clean.
- `go test ./...` in `dashboard/` clean (naming-shape assumptions).
- `node verify-pipeline.mjs` clean.
- End-to-end, **both** fan-out paths, each on a 2-role single-company slice, confirming two distinct HTML files, two distinct PDFs, and two distinct `pdf-index.tsv` rows:
  - `batch/batch-runner.sh` (exercises Step 1, `batch/batch-prompt.md`)
  - `node batch-tailor.mjs --min-score=…` (exercises Step 2, `modes/pdf.md`)
