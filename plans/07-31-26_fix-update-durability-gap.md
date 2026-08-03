# career-ops: fix update-system.mjs durability gap

> **Superseded same-day by `plans/07-31-26_replace-update-mechanism-with-merge.md`.** Testing this fix's `.update-exclude`/`prune-update-excludes.mjs` design against a real `update-system.mjs apply()` run showed the underlying checkout-based `apply()` was wiping out ALL locally-edited system-layer files (not just deleted directories) — a bigger problem than this plan scoped. The successor plan replaces `apply()`'s mechanism entirely with a `git merge` against upstream, which fixes both problems at once and retires the standalone `prune-update-excludes.mjs` script documented below (its logic is now native to `update-system.mjs`). Left here for the historical record of how the investigation progressed.

## Context

While exploring further token/repo-hygiene optimizations, investigated whether the 16 non-English `modes/{lang}/` directories deleted in `07-17-26_pipeline-efficiency-and-personalization.md` (and the various `.{cli}/` directories considered for the same treatment) actually stay deleted across future `career-ops update` cycles.

They don't. `update-system.mjs`'s `apply()` treats every path in `SYSTEM_PATHS` (and `remoteSystemPaths`, extracted live from upstream's own `update-system.mjs` at `FETCH_HEAD`) as something to unconditionally `git checkout FETCH_HEAD -- <path>`. The 16 deleted language directories are still listed in `SYSTEM_PATHS` (never removed from the array when the directories were deleted from disk), so the next accepted update silently resurrects them.

## The deeper finding: update-system.mjs cannot protect itself

The obvious fix — add an exclude-list check inside `apply()`'s path-checkout loop — does not work, because `apply()` is explicitly self-replacing:

```js
if (!isReexec) {
  const reexecFiles = resolveReexecCheckout('FETCH_HEAD', 'update-system.mjs');
  git('checkout', 'FETCH_HEAD', '--', ...reexecFiles);   // overwrites update-system.mjs ON DISK
  execFileSync(process.execPath, ['update-system.mjs', 'apply'], {...});  // re-execs the JUST-OVERWRITTEN file
  return;
}
```

This runs on *every* `apply()` invocation, regardless of whether a real version bump exists. `update-system.mjs` is itself in `SYSTEM_PATHS` (so Step 3's checkout loop restores it again) and gets committed as upstream's vanilla content by Step 7. Net effect: any code added to `update-system.mjs` — including an exclude-list filter — is discarded the very first time `apply()` runs, before the code that would use it even executes in that run. The same is true, more broadly, of any local edit to any `SYSTEM_PATHS` file (most of the repo: `AGENTS.md`, every `modes/*.md`, every `.mjs` script) — none of it is safe against the next accepted update. That's a bigger blast radius than just the language directories, but out of scope for this specific fix (flagged to the user, not solved here).

The only paths genuinely immune to `apply()`'s checkout loop are ones **never listed** in `SYSTEM_PATHS`/`BOOTSTRAP_PATHS`/upstream's own manifest — i.e. new files this fork adds and never registers there.

## Decision (confirmed with user)

Two-part fix, entirely outside `update-system.mjs`'s own logic:

1. **`.update-exclude`** — new, plain-text, git-tracked data file at repo root listing paths to prune (directory-prefix or exact-file, same convention as `SYSTEM_PATHS` entries). Seeded with the 16 already-regressed `modes/{lang}/` directories. Never added to `SYSTEM_PATHS`, so `apply()`'s checkout loop can't touch it.
2. **`prune-update-excludes.mjs`** — new, standalone script at repo root. Reads `.update-exclude`, removes (via `git rm` + `rmSync`) anything listed that's present on disk or git-tracked, and commits the removal in a clearly-labeled scoped commit. Deliberately **never** added to `SYSTEM_PATHS` — that's the entire point: a file outside the manifest can't be resurrected or altered by an upstream sync, unlike code living inside `update-system.mjs`.

Enforcement mechanism (user chose, over a Claude Code hook): a house rule in `modes/_custom.md` (genuinely user-layer, never overwritten) instructing the agent to run `node prune-update-excludes.mjs` immediately after every `node update-system.mjs apply`. A `.claude/hooks/` PostToolUse hook was considered as a fully-automatic alternative (or an addition) but rejected for now as extra infrastructure beyond what was asked; can be added later if the procedural rule proves unreliable in practice.

Secondary consequence accepted: three other places that *mention* this fix (`AGENTS.md`'s Update Check section, `DATA_CONTRACT.md`, `test-all.mjs`'s script registry) are themselves `SYSTEM_PATHS`-managed, so a real future upstream sync can silently drop those mentions. This doesn't break the actual protection (the exclude file + prune script are unaffected either way) — it only means the documentation/tests could go stale. The `_custom.md` rule includes a follow-up line telling the agent to spot-check and re-add those mentions after every apply, closing the loop through the one truly durable file.

## What changed

1. `.update-exclude` (new) — seeded with the 16 `modes/{lang}/` directories.
2. `prune-update-excludes.mjs` (new) — parses the exclude file, prunes matches, commits. `--dry-run` and `--self-test` (pure-logic unit tests for the parsing/matching functions, no git/fs writes) modes.
3. `modes/_custom.md` — House Rules: run the prune script after every `apply`; spot-check the three non-durable doc/test mentions afterward.
4. `AGENTS.md` — Update Check section now says to run `prune-update-excludes.mjs` right after `apply`.
5. `DATA_CONTRACT.md` — documents both new files under User Layer.
6. `test-all.mjs` — registers `prune-update-excludes.mjs --self-test` and `--dry-run` in the script-execution list, plus a guard assertion that `prune-update-excludes.mjs` is never added to `SYSTEM_PATHS` and stays documented in `DATA_CONTRACT.md`/`AGENTS.md`.

## What does NOT change

- `update-system.mjs` itself is untouched — no exclude-awareness was added to its own logic, since it would be discarded on the first `apply()` run anyway. This keeps the design honest: one source of truth (`prune-update-excludes.mjs`) instead of duplicated logic in a place that can't keep it.
- No change to `SYSTEM_PATHS`, `USER_PATHS`, or `BOOTSTRAP_PATHS` arrays.
- The broader "any local edit to a `SYSTEM_PATHS` file can be silently overwritten by an accepted update" limitation (e.g. this session's earlier Block F edit to `modes/oferta.md`) is not solved here — flagged as a known, larger, separate risk.

## Verification

- `node prune-update-excludes.mjs --self-test` — 7/7 pure-logic assertions pass (parsing, directory-prefix matching, exact-file matching, no false-positive on a sibling directory sharing a prefix, e.g. `modes/de/` vs `modes/deep.md`).
- `node prune-update-excludes.mjs --dry-run` against the real repo — reports nothing to prune (the 16 directories are already absent, as expected; confirms the existence/tracked-check logic doesn't false-positive).
- `node test-all.mjs` — full suite green, including the new invariant guard.
