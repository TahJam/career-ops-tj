#!/usr/bin/env node

/**
 * updater-migration-tests.mjs — source-level safety checks for update-system.
 *
 * apply() pulls upstream changes via `git merge` against the canonical repo
 * rather than checking out a fixed path list (see
 * plans/07-31-26_replace-update-mechanism-with-merge.md) — this guards the
 * invariants that design depends on: no leftover self-reexec machinery,
 * conflict-vs-clean-merge handling, .update-exclude auto-resolution, and
 * that SYSTEM_PATHS/USER_PATHS (still used elsewhere as a documentation and
 * coverage manifest) stay internally consistent.
 */

import { readFileSync, existsSync } from 'fs';

let passed = 0;
let failed = 0;

function pass(message) {
  console.log(`PASS ${message}`);
  passed++;
}

function fail(message) {
  console.error(`FAIL ${message}`);
  failed++;
}

let source = '';
try {
  source = readFileSync('update-system.mjs', 'utf-8');
  pass('update-system.mjs is readable');
} catch (error) {
  fail(`update-system.mjs is readable: ${error.message}`);
  process.exit(1);
}

function extractArray(name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) {
    fail(`${name} array exists`);
    return [];
  }
  pass(`${name} array exists`);
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (entry) => entry[1]);
}

const systemPaths = extractArray('SYSTEM_PATHS');
const userPaths = extractArray('USER_PATHS');
const bootstrapPaths = extractArray('BOOTSTRAP_PATHS');

// Every concrete (non-directory) manifest entry (SYSTEM_PATHS or
// BOOTSTRAP_PATHS) must exist in the working tree. A path deleted upstream
// but left in the manifest survives as a permanent `error: pathspec ...` in
// every user's upgrade output (#2002). Directory entries (trailing '/') are
// exempt: git checkout of a directory pathspec tolerates content drift
// inside it. Add an entry to ALLOWED_MISSING_ENTRIES only with a comment
// justifying why it may legitimately be absent.
// Non-English README translations this fork deliberately removes via
// .update-exclude (English-only fork) — legitimately absent, not stale.
const ALLOWED_MISSING_ENTRIES = new Set([
  'README.ar.md', 'README.cn.md', 'README.da.md', 'README.de.md',
  'README.es.md', 'README.fr.md', 'README.hi.md', 'README.ja.md',
  'README.ko-KR.md', 'README.pl.md', 'README.pt-BR.md', 'README.ru.md',
  'README.ta.md', 'README.tr.md', 'README.ua.md', 'README.zh-TW.md',
]);
for (const [listName, entries] of [['SYSTEM_PATHS', systemPaths], ['BOOTSTRAP_PATHS', bootstrapPaths]]) {
  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    if (ALLOWED_MISSING_ENTRIES.has(entry)) continue;
    if (existsSync(entry)) {
      pass(`${listName} entry exists on disk: ${entry}`);
    } else {
      fail(`${listName} entry missing from tree (stale manifest entry, #2002): ${entry}`);
    }
  }
}

const requiredSystemPaths = [
  'modes/email.md',
  'modes/followup.md',
  'modes/interview.md',
  'modes/interview-prep.md',
  'modes/patterns.md',
  'modes/update.md',
  'modes/ar/',
  'modes/hi/',
  'modes/tr/',
  'modes/ua/',
  'batch/README.md',
  'examples/',
  'config/profile.example.yml',
  '.env.example',
  '.claude-plugin/',
  '.qwen/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.cursor/skills/',
  'tracker-columns-tests.mjs',
  'updater-migration-tests.mjs',
  'README.ar.md',
  'README.de.md',
  'README.hi.md',
  'README.ja.md',
  'README.ua.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'TRADEMARK.md',
];

const requiredBootstrapPaths = [
  '.agents/',
  '.cursor/skills/',
  '.opencode/skills/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  'providers/',
  'liveness-browser.mjs',
  'role-matcher.mjs',
  'tracker-utils.mjs',
  'tracker-parse.mjs',
  'updater-migration-tests.mjs',
  'tracker-columns-tests.mjs',
];

for (const path of requiredSystemPaths) {
  if (systemPaths.includes(path)) pass(`SYSTEM_PATHS covers ${path}`);
  else fail(`SYSTEM_PATHS missing ${path}`);
}

for (const path of requiredBootstrapPaths) {
  if (bootstrapPaths.includes(path)) pass(`BOOTSTRAP_PATHS covers ${path}`);
  else fail(`BOOTSTRAP_PATHS missing ${path}`);
}

const mergeBasedApplyChecks = [
  {
    name: 'no leftover self-reexec guard (retired — merge needs no path manifest to bootstrap)',
    pattern: /CAREER_OPS_UPDATE_REEXEC/,
    expectAbsent: true,
  },
  {
    name: 'no leftover resolveReexecCheckout (retired)',
    pattern: /resolveReexecCheckout/,
    expectAbsent: true,
  },
  {
    name: 'no leftover relativeImportSpecifiers (retired)',
    pattern: /relativeImportSpecifiers/,
    expectAbsent: true,
  },
  {
    name: 'no leftover mergePathLists / path-manifest checkout (retired)',
    pattern: /mergePathLists/,
    expectAbsent: true,
  },
  {
    name: 'apply fetches from the canonical repo',
    pattern: /git\('fetch',\s*CANONICAL_REPO,\s*'main'\)/,
  },
  {
    name: 'apply checks whether FETCH_HEAD is already an ancestor of HEAD before merging',
    pattern: /git\('merge-base',\s*'--is-ancestor',\s*'FETCH_HEAD',\s*'HEAD'\)/,
  },
  {
    name: 'apply merges FETCH_HEAD instead of checking out a path list',
    pattern: /git\('merge',\s*'FETCH_HEAD',\s*'--no-edit'\)/,
  },
  {
    name: 'apply auto-resolves only DU (deleted-by-us) conflicts matching .update-exclude',
    pattern: /entry\.code === 'DU' && pathMatchesExclude\(entry\.path, excludeEntries\)/,
  },
  {
    name: 'apply refuses to guess on any conflict not in .update-exclude — throws instead of committing',
    pattern: /throw new Error\(`Update stopped: \$\{remaining\.length\} unresolved merge conflict/,
  },
  {
    name: 'apply sweeps .update-exclude paths unconditionally after merging (catches upstream adding new files under an excluded dir)',
    pattern: /function pruneExcludedPaths\(/,
  },
  {
    name: 'apply stashes uncommitted work before merging (git merge refuses on a dirty tree, unlike the old checkout)',
    pattern: /git\('stash',\s*'push',\s*'-m'/,
  },
  {
    name: 'apply restores stashed work after the merge finalizes, without failing the whole update if the pop conflicts',
    pattern: /git\('stash',\s*'pop'\)/,
  },
  {
    name: 'rollback resets to the backup branch in one step instead of per-path restore/remove',
    pattern: /git\('reset',\s*'--hard',\s*latest\)/,
  },
  {
    name: 'rollback refuses on a dirty working tree rather than silently discarding uncommitted work',
    pattern: /Working tree has uncommitted changes — refusing to rollback/,
  },
];

for (const check of mergeBasedApplyChecks) {
  const matched = check.pattern.test(source);
  const ok = check.expectAbsent ? !matched : matched;
  if (ok) pass(check.name);
  else fail(check.name);
}

for (const userPath of ['cv.md', 'config/profile.yml', 'modes/_profile.md', 'portals.yml', 'data/', 'reports/']) {
  if (userPaths.includes(userPath)) pass(`USER_PATHS protects ${userPath}`);
  else fail(`USER_PATHS missing ${userPath}`);
}

const allowedSystemUserOverlap = new Set([
  'writing-samples/README.md',
  // System-owned scaffold inside the user-layer interview-prep/ dir (#1242):
  // the updater ships these two, but never the real session files alongside them.
  'interview-prep/sessions/.gitkeep',
  'interview-prep/sessions/README.md',
]);
let hasSystemUserCollision = false;
for (const systemPath of systemPaths) {
  const overlapsUserPath = userPaths.some((userPath) => {
    if (allowedSystemUserOverlap.has(systemPath)) return false;
    return systemPath === userPath || systemPath.startsWith(userPath);
  });
  if (overlapsUserPath) {
    hasSystemUserCollision = true;
    fail(`SYSTEM_PATHS must not update user path ${systemPath}`);
  }
}
if (!hasSystemUserCollision) {
  pass('SYSTEM_PATHS does not collide with USER_PATHS');
}

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\n${passed} passed, ${failed} failed`);
