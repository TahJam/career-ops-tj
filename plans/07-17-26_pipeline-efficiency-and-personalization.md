# career-ops: batch-pipeline efficiency + personalization cleanup

## Context

Two things prompted this plan. First, the last two large evaluation batches (18 offers each) both hit the account's Claude session/usage limit partway through, killing ~55-70% of workers mid-evaluation and requiring manual cleanup of orphaned report-number reservations and a tracker merge that silently conflated two different job postings into one row. A batch of 3 completed cleanly. Investigation (via 2 parallel Explore agents) found the tool already ships a purpose-built mechanism for exactly this failure mode — `batch/batch-runner.sh` — that we weren't using because `modes/pipeline.md`'s own documented pattern is manual Agent-tool fan-out, not the standalone script.

Second, career-ops was built by a third party ("santifer") for his own AI/automation-focused search and ships with a lot of surface area that doesn't fit Taher: 16 unused non-English language-mode directories, ~44 tracked companies with no US presence, EU/Spain-market search queries, and — most importantly — `modes/_profile.md` (the file the tool's own data contract designates as *the* place for user-specific archetypes/narrative/negotiation/location policy) is still byte-identical to its template. That's the root cause behind 5 of 19 evaluation reports (~26%) explicitly noting "no archetype fits cleanly" for backend/infra-only roles — Taher's actual primary archetypes (Backend/Full-Stack SWE, Security/Platform Engineer) exist in `config/profile.yml` but were never wired into the scoring-guidance file that's supposed to carry them.

Separately, the user wants a durable, cross-project workflow adopted going forward: **Investigate → Plan → Test → Implement**, with plan docs committed to a repo `plans/` folder (`mm-dd-yy_{description}.md`) and disposable test scripts in a gitignored `process/scripts/` folder. This plan is itself the first artifact produced under that convention. (career-ops is confirmed to be its own git repo — `git status` shows `origin/main` — so all changes below are safely reversible via git.)

## Decisions (confirmed with user)

- Non-US `tracked_companies` in `portals.yml`: **disable** (`enabled: false`), don't delete — reversible, matches the existing treatment of the Turkey block.
- 16 unused language-mode directories under `modes/`: **delete**. Zero functional risk (never auto-loaded without explicit opt-in), recoverable via git/re-clone if ever needed.
- `modes/_profile.md`: **full rewrite**, sourced from `config/profile.yml` AND `project_portfolio.md` (not just `article-digest.md`) — add Backend/Full-Stack SWE and Security/Platform Engineer as first-class archetypes, real narrative/proof points, real negotiation scripts with the actual $130K-$200K range, Austin-specific location policy.
- Future large batches: adopt `batch-runner.sh`, default `--parallel 3` (matches the batch size that completed 3/3 this session with zero failures).

## Steps

### 0. Establish the plans/ + process/scripts/ convention in this repo
- Create `career-ops/plans/` and write this plan there.
- Create `career-ops/process/scripts/` and gitignore it.

### 1. Efficiency: bridge `data/pipeline.md` → `batch-runner.sh`
- Write `pipeline-to-batch-input.mjs` (project root) that reads the `## Pending` section of `data/pipeline.md` (format documented in `modes/pipeline.md:39-72`) and writes `batch/batch-input.tsv` in the 4-column format `batch-runner.sh` expects (`id\turl\tsource\tnotes`).
- **Testing phase**: fixture in `process/scripts/`, verify round-trip before running for real.
- Document the converter in `modes/batch.md`.
- Going forward, large batches (>5 offers) run via `batch/batch-runner.sh --parallel 3`; small batches (≤5) can still use manual Agent-tool fan-out.

### 2. Personalization: `portals.yml`
- Set `enabled: false` on the ~44 confirmed pure-non-US `tracked_companies` entries (DACH, Denmark, Iberia, Nordics, France, UK & Ireland, Switzerland/Austria, Canada/Vancouver blocks, plus scattered entries). Leave ~13 mixed EU+US entries enabled. Leave the already-disabled Turkey block untouched.
- Disable the ~14 enabled EU/Spain-market `search_queries` the same way.
- Verify with `node verify-portals.mjs`.

### 3. Personalization: delete unused language-mode directories
- Delete `modes/ar,da,de,es,fr,hi,id,it,ja,ko,pl,pt,ru,tr,ua,zh/`.
- Leave `modes/heuristics/`, `modes/regional/`, `modes/interview/` untouched.
- Clean up the "Language Modes" section in `AGENTS.md`/`CLAUDE.md`.

### 4. Personalization: full rewrite of `modes/_profile.md`
Source material: `config/profile.yml` + `project_portfolio.md` + `article-digest.md`.

Rewrite every section: Target Roles/Archetype table (add Backend/Full-Stack SWE, Security/Platform Engineer as first-class), Adaptive Framing, Exit Narrative, Cross-cutting Advantage, Comp Targets/Negotiation Scripts (real $130K-$200K range), Location Policy (Austin-specific).

## Verification

- `node verify-portals.mjs` after `portals.yml` edits.
- `node doctor.mjs --json` after `_profile.md` rewrite — confirm `onboardingNeeded: false`.
- Diff `modes/_profile.md` vs `modes/_profile.template.md` — confirm no longer identical.
- `ls modes/` — confirm 16 language dirs gone, functional dirs remain.
- Converter: dry-run against real `data/pipeline.md` lines, inspect output before trusting it.
- End-to-end: one small live batch (3-5 offers) through `batch-runner.sh --parallel 3`, confirm auto-merge + sane archetype assignment on a backend-only posting.
