# career-ops: defer interview-prep generation out of the evaluation pass

## Context

Continuing the token-reduction work started in `07-17-26_pipeline-efficiency-and-personalization.md` (Claude Code only, English-only), the next target is `modes/oferta.md`'s **Block F — Interview Plan**. Every evaluation (`oferta`, `auto-pipeline`, `pipeline`, `batch`) currently generates, unconditionally:

- 6-10 STAR+R stories mapped to JD requirements (full table with S/T/A/R/Reflection columns)
- A recommended case study to present
- Red-flag interview questions and how to answer them
- A write to `interview-prep/story-bank.md` for any story not already there

This runs on 100% of evaluated jobs, but only a fraction ever reach an actual interview. The system already has a purpose-built, much deeper mode for this exact content — `modes/interview-prep.md` (research-backed, per-audience question packs, panel intel, story-bank cross-referencing) — whose own header already says it should run "when the user asks to prep for an interview at a specific company+role, **or when an evaluation scores 4.0+ and the user updates status to `Interview`**." That second trigger is documented but never actually wired into the router, `reply-watch.md`, or `AGENTS.md` — it's aspirational text, not a real workflow step. So today the user pays for a shallow STAR-story pass at eval time AND, separately, has to remember to manually invoke `/career-ops interview-prep` later.

Goal: cut Block F down to a near-free stub at evaluation time, and make the "I heard back" path actually trigger the real interview-prep mode automatically.

## Decision (confirmed with user)

**Keep the `## Block F — Interview Plan` heading and A-G structure intact.** Only trim the body. This was a deliberate choice over renumbering/removing the block, because the heading is a load-bearing contract in several places that would otherwise need coordinated changes:

- `test-all.mjs` (~line 8371-8379): asserts `modes/oferta.md` contains `## Block F ` — treats its absence as **breaking for the web report view**.
- `web/src/components/report-view.tsx`: parses reports by `## F) ...` headers.
- `gemini-eval.mjs` (line 168): regex-matches `Block F\b` / `#{1,3}\s*F[).:-]?` to extract the section.
- `batch/batch-prompt.md`: mirrors the same Block F schema for headless/batch workers.
- Every already-saved report in `reports/` (90+ files) is an A-G document; renumbering would only affect the *template* going forward but reads oddly next to historical files.

Renumbering was considered and rejected — it's a bigger migration for a change whose actual goal (stop spending tokens on unused STAR content) doesn't require touching the letter at all.

## What "trim" means concretely

Replace Block F's body in `modes/oferta.md` (and the mirrored copy in `batch/batch-prompt.md`) with a stub that:

- Drops the 6-10 STAR+R story table, the recommended case study, and the red-flag Q&A entirely from eval-time output.
- Drops the "Story Bank: append new stories" step — `interview-prep/story-bank.md` will no longer be written during evaluation. (Real behavior change, flagged below.)
- Keeps exactly one cheap, no-research line: which JD requirement looks like the strongest story opportunity, so the block isn't pure boilerplate.
- Points the user at the real workflow: tell them this generates on demand once they hear back, either by running `/career-ops interview-prep` or by just telling the agent they got an interview.

Draft replacement body:

```markdown
## Block F — Interview Plan

**(full prep deferred — ask when it's actually needed)**

**Quick take:** {1 sentence — the single JD requirement with the strongest existing story opportunity from cv.md, so this isn't zero signal even pre-interview}
```

## Downstream changes required

1. **`modes/oferta.md`** — replace Block F body as above. Leave Block A-E, G, Risk Summary, Cover Letter Draft, Post-evaluation untouched.
2. **`batch/batch-prompt.md`** — mirror the same trim in its `#### Block F — Interview Plan` section (batch workers currently generate the full table too).
3. **`modes/apply.md`** (~line 128) — currently says "STAR stories from block F." Since Block F no longer carries stories, repoint to `interview-prep/story-bank.md` and per-company `interview-prep/{company}-{role}.md` first, falling back to "none yet — run interview-prep" if neither exists.
4. **`modes/interview-prep.md`** — add an explicit **Auto-trigger** note near the top (currently just descriptive prose in line 3): when the user reports hearing back / getting an interview for a company+role that has an evaluation report, this mode should actually run — not just theoretically apply. Tie it to the status-update step below rather than leaving it as a standalone aspiration.
5. **`modes/reply-watch.md`** — after Step 2 (confirm + apply tracker status update), add a Step 3: if the confirmed update was `→ Interview`, ask the user "Want me to generate the interview-prep kit for {company} now?" before ending the mode. Same HITL pattern already used for the status-update confirmation itself.
6. **`AGENTS.md`** Skill Modes table — add a row (or amend the existing `interview-prep` row) documenting the natural-language trigger explicitly: "User says they heard back / got an interview for a specific company" → confirm + apply `Interview` status via `set-status.mjs`, then offer `interview-prep`.
7. **`examples/sample-report.md`** — update the sample Block F content to match the new stub (cosmetic, low priority, but keeps the example truthful).

## What does NOT change

- Block F is not a scored dimension anywhere (Global Score / Machine Summary draw from CV match, North Star, Compensation, Culture, Red flags — never from Block F), so trimming it cannot move any score.
- `## Block F — Interview Plan` heading text, position in the A-G sequence, and Machine Summary schema are untouched — zero changes needed in `test-all.mjs`, `report-view.tsx`, or `gemini-eval.mjs`/`openai-eval.mjs`'s block-detection regexes.
- `modes/interview-prep.md`'s actual research/output logic (Steps 1-7) is untouched — it already does everything Block F did, plus far more (per-audience research, panel intel, coffee-chat cross-reference).
- No change to `set-status.mjs`, `reply-watch.mjs`, `invite-match.mjs`, or the tracker schema.

## Trade-off to accept

`interview-prep/story-bank.md` currently gets quietly seeded with new STAR stories on *every* evaluation via Block F. After this change, it only grows when `interview-prep` mode actually runs (Step 5 offers to draft missing stories on request) — i.e., only for roles that reach an interview. This means less passive story-bank accumulation, but arguably that's fine: a story bank entry for a job that never called back has no real value anyway, and the ones that matter (roles that do interview) still get captured.

## Verification

- `node test-all.mjs` — confirm the existing 55.4 report-block-structure check still passes untouched (heading preserved).
- Manually run `/career-ops oferta` (or paste a JD) against a throwaway/test JD and confirm Block F renders as the short stub, not the full STAR table.
- Manually run `/career-ops batch` (or inspect `batch-prompt.md` rendering) to confirm the batch path also emits the trimmed version.
- Simulate the "heard back" path: tell the agent "I heard back from {a company already in data/applications.md}, they want to interview me" and confirm it (a) proposes the `Interview` status update via `set-status.mjs` with confirmation, and (b) then offers to run `interview-prep` — rather than silently doing nothing extra.
- Spot-check `modes/apply.md`'s form-filling flow still finds STAR material via story-bank.md fallback when Block F is empty.
