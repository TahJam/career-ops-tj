#!/usr/bin/env node

/**
 * update-system.mjs — Safe auto-updater for career-ops
 *
 * Pulls upstream changes via a real `git merge` against the canonical repo,
 * rather than wholesale-checking-out a fixed path list. See
 * plans/07-31-26_replace-update-mechanism-with-merge.md for why: the old
 * checkout-based design silently discarded any local edit to a system-layer
 * file (it isn't just about deleted directories — ANY hand-edited
 * modes/*.md, AGENTS.md, or *.mjs script was wiped on the next apply(), with
 * no warning). A merge auto-combines non-overlapping local edits with
 * upstream's changes to the same file, and only stops for genuine conflicts
 * (both sides touched the same lines) or a deliberately-removed path
 * (.update-exclude) that upstream still ships.
 *
 * Usage:
 *   node update-system.mjs check      # Check if update available
 *   node update-system.mjs apply      # Apply update (after user confirms)
 *   node update-system.mjs rollback   # Rollback last update
 *   node update-system.mjs dismiss    # Dismiss update check
 *
 * See DATA_CONTRACT.md for the full system/user layer definitions.
 * SYSTEM_PATHS/USER_PATHS/BOOTSTRAP_PATHS below are no longer used to drive
 * checkout — apply() now merges the whole tree — but stay as the
 * documentation/coverage manifest read by validate-system-paths-coverage.mjs
 * and other doc-consistency checks.
 */

import { execFile, execFileSync, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const CANONICAL_REPO = 'https://github.com/santifer/career-ops.git';
const RAW_VERSION_URL = 'https://raw.githubusercontent.com/santifer/career-ops/main/VERSION';
const RELEASES_API = 'https://api.github.com/repos/santifer/career-ops/releases/latest';

// Matches a semver, with or without a leading `v` and an optional
// Release Please component prefix (e.g. `career-ops-v1.9.0` → `1.9.0`).
// Anchoring on `(?:^|-)` lets the releases-API fallback parse our tags,
// which Release Please always prefixes with the component name.
export const SEMVER_RE = /(?:^|-)v?(\d+\.\d+\.\d+)$/i;
// 120s: local git commands are normally instant, but a cloud-evicted working
// tree (iCloud "optimize storage", OneDrive dehydration) can stall a plain
// `git status` for a minute of pure I/O wait re-materializing files (#1393).
export const DEFAULT_GIT_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_GIT_TIMEOUT_MS, 120000);
export const DEFAULT_GIT_FETCH_TIMEOUT_MS = parsePositiveInt(
  process.env.CAREER_OPS_GIT_FETCH_TIMEOUT_MS,
  Math.max(DEFAULT_GIT_TIMEOUT_MS, 300000),
);
export const NPM_INSTALL_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_NPM_INSTALL_TIMEOUT_MS, 60000);
export const PLAYWRIGHT_INSTALL_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_PLAYWRIGHT_INSTALL_TIMEOUT_MS, 120000);
export const DASHBOARD_REBUILD_TIMEOUT_MS = parsePositiveInt(process.env.CAREER_OPS_DASHBOARD_REBUILD_TIMEOUT_MS, 60000);

// System layer paths — ONLY these files get updated
const SYSTEM_PATHS = [
  'modes/README.md',
  'modes/_shared.md',
  'modes/_writing.md',
  'modes/_profile.template.md',
  'modes/_custom.template.md',
  'modes/_brief.template.md',
  'modes/oferta.md',
  'modes/pdf.md',
  'modes/cover.md',
  'modes/email.md',
  'modes/add.md',
  'modes/expand.md',
  'modes/scan.md',
  'modes/discover.md',
  'modes/batch.md',
  'modes/apply.md',
  'modes/auto-pipeline.md',
  'modes/contacto.md',
  'modes/deep.md',
  'modes/ofertas.md',
  'modes/pipeline.md',
  'modes/triage.md',
  'modes/project.md',
  'modes/tracker.md',
  'modes/training.md',
  'modes/interview.md',
  'modes/interview-redflag.md',
  'modes/latex.md',
  'modes/latex-tex.md',
  'modes/followup.md',
  'modes/offer-prep.md',
  'modes/interview-prep.md',
  'modes/interview/',
  'interview-prep/sessions/.gitkeep',
  'interview-prep/sessions/README.md',
  'modes/patterns.md',
  'modes/titles.md',
  'modes/upskill.md',
  'modes/update.md',
  'modes/agent-inbox.md',
  'modes/reply-watch.md',
  'modes/outcome.md',
  'modes/ar/',
  'modes/da/',
  'modes/de/',
  'modes/de/interview/',
  'modes/fr/',
  'modes/fr/interview/',
  'modes/hi/',
  'modes/es/',
  'modes/es/interview/',
  'modes/id/',
  'modes/it/',
  'modes/it/interview/',
  'modes/ja/',
  'modes/ko/',
  'modes/nl/',
  'modes/pl/',
  'modes/pt/',
  'modes/pt/interview/',
  'modes/ru/',
  'modes/tr/',
  'modes/ua/',
  'modes/heuristics/',
  'modes/regional/',
  'modes/zh/',
  'modes/zh/interview/',
  'modes/zh-TW/',
  'CLAUDE.md',
  'CODEX.md',
  'OPENCODE.md',
  'AGENTS.md',
  'GEMINI.md',
  'KIMI.md',
  'build-dashboard.mjs',
  'generate-pdf.mjs',
  'theme-style.mjs',
  'generate-latex.mjs',
  'extract-latex-content.mjs',
  'patch-latex-content.mjs',
  'lib/latex-escape.mjs',
  'lib/latex-content.mjs',
  'lib/context-budget.mjs',
  'lib/context-budget.test.mjs',
  'lib/golden-budget-analysis.mjs',
  'img-to-pdf.mjs',
  'archive-posting.mjs',
  'application-answers.mjs',
  'generate-cover-letter.mjs',
  'merge-tracker.mjs',
  'sync-pdf-flags.mjs',
  'tracker-links.mjs',
  'tracker.mjs',
  'find.mjs',
  'verify-pipeline.mjs',
  'reconcile-pipeline.mjs',
  'dedup-tracker.mjs',
  'add-entry.mjs',
  'role-matcher.mjs',
  'tracker-utils.mjs',
  'tracker-parse.mjs',
  'tracker-aliases.json',
  'set-status.mjs',
  'set-status-tests.mjs',
  'mark-pdf-ready.mjs',
  'normalize-statuses.mjs',
  'cv-sync-check.mjs',
  'verify-cv-facts.mjs',
  'update-system.mjs',
  'reserve-report-num.mjs',
  'scan.mjs',
  'pipeline-lock.mjs',
  'portal-health-lock.mjs',
  'classify-tier.mjs',
  'scan-ats-full.mjs',
  'scan-interamt.mjs',
  'company-funded.mjs',
  'match-star.mjs',
  'jd-skill-gap.mjs',
  'prepare-application.mjs',
  'application-artifacts.mjs',
  'providers/',
  'seeds/',
  'tests/',
  'doctor.mjs',
  'check-liveness.mjs',
  'liveness-core.mjs',
  'liveness-api.mjs',
  'liveness-browser.mjs',
  'browser-extract.mjs',
  'analyze-patterns.mjs',
  'upskill.mjs',
  'skill-extract.mjs',
  'stats.mjs',
  'detect-reposts.mjs',
  'discover-ats.mjs',
  'discover-ats.test.mjs',
  'check-table-freshness.mjs',
  'fingerprint-core.mjs',
  'process-quality.mjs',
  'process-quality.test.mjs',
  'company-history.mjs',
  'company-history.test.mjs',
  'salary-gap.mjs',
  'funnel-velocity.mjs',
  'assessment-log.mjs',
  'contacts.mjs',
  'contacts.test.mjs',
  'weekly-digest.mjs',
  'followup-cadence.mjs',
  'followup-cadence.test.mjs',
  'invite-match.mjs',
  'invite-match.test.mjs',
  'agent-inbox.mjs',
  'followup-seed.mjs',
  'followup-seed-tests.mjs',
  'profile-language.mjs',
  'pipeline-to-batch-input.mjs',
  'gemini-eval.mjs',
  'ollama-eval.mjs',
  'openai-eval.mjs',
  'openai-tailor.mjs',
  'eval-golden.mjs',
  'evals/',
  'openrouter-runner.mjs',
  'jd-similarity.mjs',
  'jd-similarity.test.mjs',
  'test-all.mjs',
  'detect-reposts.test.mjs',
  'test-salary-filter.mjs',
  'test-trust-validator.mjs',
  'tracker-columns-tests.mjs',
  'tracker-writer-lock-tests.mjs',
  'agent-inbox-tests.mjs',
  'validate-portals.mjs',
  'verify-portals.mjs',
  'fix-slugs.mjs',
  'updater-migration-tests.mjs',
  'validate-system-paths-coverage.mjs',
  'validate-untrusted-content-coverage.mjs',
  'reply-matcher.mjs',
  'reply-matcher.test.mjs',
  'reply-watch.mjs',
  'paste-reply.mjs',
  'paste-reply-tests.mjs',
  'outcome.mjs',
  'tests/outcome.test.mjs',
  'batch/batch-prompt.md',
  'batch/batch-runner.sh',
  'batch/aggregate-tokens.mjs',
  'batch/README.md',
  'utils/token-tracker.mjs',
  'batch-tailor.mjs',
  'dashboard/',
  'templates/',
  'config/cv-facts.example.json',
  'fonts/',
  'examples/',
  'config/profile.example.yml',
  '.env.example',
  '.editorconfig',
  '.agents/',
  '.claude/skills/',
  '.cursor/skills/',
  '.opencode/skills/',
  '.opencode/commands/',
  '.claude-plugin/',
  '.qwen/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.kimi/skills/',
  'docs/',
  'writing-samples/README.md',
  'VERSION',
  'DATA_CONTRACT.md',
  'MANIFESTO.md',
  'manifesto.mjs',
  'SIGNATURES.md',
  'CONTRIBUTING.md',
  'MAINTAINERS.md',
  'ARCHITECTURE.md',
  'README.md',
  'README.ar.md',
  'README.cn.md',
  'README.da.md',
  'README.de.md',
  'README.es.md',
  'README.fr.md',
  'README.hi.md',
  'README.ja.md',
  'README.ko-KR.md',
  'README.pl.md',
  'README.pt-BR.md',
  'README.ru.md',
  'README.ta.md',
  'README.ua.md',
  'README.zh-TW.md',
  'README.tr.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTORS.md',
  '.all-contributorsrc',
  'GOVERNANCE.md',
  'LEGAL_DISCLAIMER.md',
  'SECURITY.md',
  'SUPPORT.md',
  'TRADEMARK.md',
  'LICENSE',
  'CITATION.cff',
  '.editorconfig',
  '.github/',
  'package.json',
  'build-cv-latex.mjs',
  'build-cv-html.mjs',
  'cv-sections-core.mjs',
  'cv-templates.mjs',
  'test/cv-templates.test.mjs',
  'test/cover-resolver.test.mjs',
  'test/pipeline-lock.test.mjs',
  'test/profile-photo.test.mjs',
  'templates/cv-template.zh-minimal.html',
  'test/zh-minimal-template.test.mjs',
  'scaffolder/',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'cops',
  'DOCKER.md',
  'plugins/',
  'plugins.mjs',
  'plugins-registry/',
  'plugin-install.mjs',
  'plugin-audit.mjs',
  'validate-plugin-registry.mjs',
  'config/plugins.example.yml',
  'opencode.example.json',
  'seed-fixture.mjs',
  'test-fixtures/',
  'upgrade-tests.mjs',
];

const BOOTSTRAP_PATHS = [
  '.agents/',
  '.cursor/skills/',
  '.opencode/skills/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.kimi/skills/',
  'providers/',
  'liveness-browser.mjs',
  'tracker-links.mjs',
  'role-matcher.mjs',
  'tracker-utils.mjs',
  'tracker-parse.mjs',
  'tracker-aliases.json',
  'scaffolder/',
  'reserve-report-num.mjs',
  'updater-migration-tests.mjs',
  'validate-portals.mjs',
  'tracker-columns-tests.mjs',
  'plugins/',
  'plugins.mjs',
  'plugins-registry/',
  'plugin-install.mjs',
  'plugin-audit.mjs',
  'validate-plugin-registry.mjs',
  'config/plugins.example.yml',
  'agent-inbox.mjs',
  'agent-inbox-tests.mjs',
];

// User layer paths — NEVER touch these (safety check)
const USER_PATHS = [
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
  'modes/_custom.md',
  'modes/_brief.md',
  'voice-dna.md',
  'portals.yml',
  'article-digest.md',
  '.update-exclude',
  'interview-prep/',
  'data/',
  'reports/',
  'output/',
  'jds/',
  'writing-samples/',
  'config/plugins.yml',
  'plugins.local/',
  'plugins.lock',
  'opencode.json',
  '.claude/settings.json',
  '.claude/hooks/',
  'plans/',
];

function parseVersionFile(raw) {
  // VERSION may carry a release-please marker, e.g. "1.6.0 # x-release-please-version".
  // Take the first whitespace-delimited token so the marker doesn't break semver parsing.
  return raw.trim().split(/\s+/)[0] || '';
}

function localVersion() {
  const vPath = join(ROOT, 'VERSION');
  return existsSync(vPath) ? parseVersionFile(readFileSync(vPath, 'utf-8')) : '0.0.0';
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

function updateBackupBranchName(version, date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `backup-pre-update-${version}-${stamp}`;
}

function backupTimestamp(branchName) {
  const match = branchName.match(/-(\d{8}T\d{6}Z)$/);
  if (!match) return 0;
  const [date, time] = match[1].split('T');
  return Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`,
  ) || 0;
}

function newestBackupBranch(branches) {
  const branchList = branches.split('\n').map(b => b.trim()).filter(Boolean);
  if (branchList.length === 0) return null;

  // Prefer timestamped backup branches created by current versions. Older
  // backups are still accepted below for rollback compatibility.
  const timestamped = branchList
    .map(branch => ({ branch, timestamp: backupTimestamp(branch) }))
    .filter(entry => entry.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp);

  return timestamped[0]?.branch || branchList[0];
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function gitTimeoutMs(args) {
  return args[0] === 'fetch' ? DEFAULT_GIT_FETCH_TIMEOUT_MS : DEFAULT_GIT_TIMEOUT_MS;
}

function describeGitCommand(args) {
  return `git ${args.join(' ')}`;
}

function isTimeoutLikeError(err) {
  return err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM';
}

function timeoutSeconds(timeout) {
  return Math.round(timeout / 1000);
}

function gitTimeoutEnvVar(args) {
  return args[0] === 'fetch' ? 'CAREER_OPS_GIT_FETCH_TIMEOUT_MS' : 'CAREER_OPS_GIT_TIMEOUT_MS';
}

export function gitIn(root, ...args) {
  const timeout = gitTimeoutMs(args);
  try {
    // execFileSync inherits stderr to the parent by default (unlike the async
    // child_process variants) — pipe it instead so expected failures (e.g.
    // `merge-base --is-ancestor` probes below) don't spam the terminal.
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (isTimeoutLikeError(err)) {
      throw new Error(`${describeGitCommand(args)} timed out after ${timeoutSeconds(timeout)}s. If your network is slow, retry or set ${gitTimeoutEnvVar(args)} to a larger value.`);
    }
    throw err;
  }
}

function git(...args) {
  return gitIn(ROOT, ...args);
}

function gitStatusEntries() {
  const status = git('status', '--porcelain');
  if (!status) return [];

  return status.split('\n')
    .filter(Boolean)
    .map(line => ({
      code: line.slice(0, 2),
      path: line.slice(3),
    }));
}

export function extractArrayFromSource(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) return [];
  return Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (entry) => entry[1]);
}

// ── UPDATE-EXCLUDE ─────────────────────────────────────────────
//
// .update-exclude lists paths this fork has deliberately removed from the
// upstream system layer and never wants a merge to restore (e.g. the
// non-English modes/{lang}/ directories). It is NOT in SYSTEM_PATHS, so it
// (and this parsing/matching logic) can't be touched by the merge itself.
// Format: one path per line, trailing slash = directory prefix, no trailing
// slash = exact file. Blank lines and lines starting with # are ignored.

const UPDATE_EXCLUDE_FILE = '.update-exclude';

export function parseUpdateExclude(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function pathMatchesExclude(path, entries) {
  return entries.some((entry) => {
    if (entry.endsWith('/')) return path === entry.slice(0, -1) || path.startsWith(entry);
    return path === entry;
  });
}

function loadUpdateExcludeEntries(root = ROOT) {
  const excludePath = join(root, UPDATE_EXCLUDE_FILE);
  if (!existsSync(excludePath)) return [];
  return parseUpdateExclude(readFileSync(excludePath, 'utf-8'));
}

// Codes `git status --porcelain` uses for unmerged (conflicted) paths.
const CONFLICT_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function repoPath(root, path) {
  return join(root, ...path.split('/'));
}

export function prepareMaterializedSkillEntrypointsForStage(paths, root = ROOT) {
  const prepared = [];
  for (const path of paths) {
    const entry = gitIn(root, 'ls-files', '-s', '--', path);
    if (!entry) continue;

    const mode = entry.split(/\s+/, 1)[0];
    if (mode === '120000') {
      gitIn(root, 'rm', '--cached', '-f', '--', path);
    }
    prepared.push(path);
  }
  return prepared;
}

// ── CHECK ───────────────────────────────────────────────────────

// curl helper used by check() — curl works inside the Claude Code sandbox
// where Node's built-in fetch() fails (ENOTFOUND) because the sandbox
// routes network traffic through an HTTP/HTTPS proxy that fetch() does
// not respect but curl handles transparently.  The --silent / --fail flags
// match the failure-handling already used throughout apply().
function curlGet(url, extraArgs = []) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['--silent', '--fail', '--max-time', '10', ...extraArgs, url],
      { encoding: 'utf-8', timeout: 12000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}

async function check() {
  // Respect dismiss flag
  if (existsSync(join(ROOT, '.update-dismissed'))) {
    console.log(JSON.stringify({ status: 'dismissed' }));
    return;
  }

  const local = localVersion();
  let remote = '';
  let releaseVersion = '';
  let changelog = '';

  // Use curl instead of fetch() so the check works inside the Claude Code
  // sandbox (see curlGet() above for rationale).  Two sources are tried;
  // both failing is the only true-offline signal.
  const [rawVersion, releaseRaw] = await Promise.all([
    curlGet(RAW_VERSION_URL),
    curlGet(RELEASES_API, [
      '--header', 'Accept: application/vnd.github.v3+json',
      '--header', 'User-Agent: career-ops-update-checker',
    ]),
  ]);

  if (rawVersion !== null) {
    try {
      const raw = parseVersionFile(rawVersion);
      const match = raw.match(SEMVER_RE);
      remote = match ? match[1] : '';
    } catch {
      // Unparseable body; treat as no VERSION source
    }
  }

  if (releaseRaw !== null) {
    try {
      const release = JSON.parse(releaseRaw);
      changelog = release.body || '';
      const rawTag = String(release.tag_name || '').trim();
      const match = rawTag.match(SEMVER_RE);
      releaseVersion = match ? match[1] : '';
    } catch {
      // Unparseable body; treat as no release source
    }
  }

  if (!remote && !releaseVersion) {
    // Both curl calls returned null → genuine network failure.
    // If one returned non-null but unparseable, remote/releaseVersion are
    // empty strings, which still reaches the offline branch — that's the
    // right conservative behaviour (no version = can't determine status).
    const bothNetworkFailed = rawVersion === null && releaseRaw === null;
    const status = bothNetworkFailed ? 'offline' : 'no-remote-version';
    console.log(JSON.stringify({ status, local }));
    return;
  }

  // Use the higher version between VERSION file and GitHub Release
  // (handles cases where VERSION file is not bumped after a release,
  // or the raw host is unreachable but the API is).
  if (!remote) {
    remote = releaseVersion;
  } else if (releaseVersion && compareVersions(releaseVersion, remote) > 0) {
    remote = releaseVersion;
  }

  if (compareVersions(local, remote) >= 0) {
    console.log(JSON.stringify({ status: 'up-to-date', local, remote }));
    return;
  }

  console.log(JSON.stringify({
    status: 'update-available',
    local,
    remote,
    changelog: changelog.slice(0, 500),
  }));
}

// ── APPLY ───────────────────────────────────────────────────────

// After a merge, diffing against `HEAD` is useless (merge already committed
// HEAD to include the new state) — diff against the pre-merge backup branch
// instead so "what did this update actually change" means something.
function dashboardGoSourcesChanged(baseRef) {
  try {
    const changed = git('diff', '--name-only', baseRef, 'HEAD', '--', 'dashboard');
    return changed
      .split('\n')
      .some(path => path.startsWith('dashboard/') && path.endsWith('.go'));
  } catch {
    return false;
  }
}

function rebuildDashboardBinaryIfNeeded(baseRef) {
  if (!dashboardGoSourcesChanged(baseRef)) return;

  try {
    execFileSync('go', ['build', '-o', 'career-dashboard', '.'], {
      cwd: join(ROOT, 'dashboard'),
      timeout: DASHBOARD_REBUILD_TIMEOUT_MS,
      stdio: 'pipe',
    });
    console.log('dashboard binary rebuilt');
  } catch {
    console.log('dashboard binary rebuild skipped -- run: cd dashboard && go build -o career-dashboard . manually');
  }
}

// Auto-resolves ONLY "deleted by us, modified by them" conflicts whose path
// matches .update-exclude (i.e. paths this fork intentionally removed and
// upstream keeps shipping — the 16 non-English modes/{lang}/ directories
// today). Any other conflict — including a DU conflict on a path NOT in
// .update-exclude — is left for manual resolution; this function never
// guesses on the user's behalf.
function autoResolveExcludedConflicts(excludeEntries) {
  const resolved = [];
  const remaining = [];
  for (const entry of gitStatusEntries()) {
    if (!CONFLICT_STATUS_CODES.has(entry.code)) continue;
    if (entry.code === 'DU' && pathMatchesExclude(entry.path, excludeEntries)) {
      git('rm', '-f', '--ignore-unmatch', '--', entry.path);
      resolved.push(entry.path);
    } else {
      remaining.push(entry.path);
    }
  }
  return { resolved, remaining };
}

// Unconditional sweep, run after every successful merge (conflicted or not):
// catches upstream ADDING a brand-new file inside an excluded directory,
// which git would auto-merge cleanly with no conflict at all (there's
// nothing local to conflict with), silently reintroducing content under a
// path this fork removed.
function pruneExcludedPaths(excludeEntries) {
  if (excludeEntries.length === 0) return [];
  const pruned = [];
  for (const entry of excludeEntries) {
    const pathspec = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const onDisk = existsSync(join(ROOT, pathspec));
    let tracked = true;
    try {
      git('ls-files', '--error-unmatch', '--', pathspec);
    } catch {
      tracked = false;
    }
    if (!onDisk && !tracked) continue;
    try {
      git('rm', '-r', '-f', '--ignore-unmatch', '--', pathspec);
    } catch (err) {
      console.error(`Failed to prune excluded path ${pathspec}: ${err.message}`);
      continue;
    }
    // `git rm --ignore-unmatch` silently no-ops on an untracked path — fall
    // back to a direct removal so an untracked leftover doesn't get reported
    // as pruned while still sitting on disk.
    try {
      rmSync(join(ROOT, pathspec), { recursive: true, force: true });
    } catch {
      // Already gone — fine.
    }
    pruned.push(pathspec);
  }
  return pruned;
}

async function apply() {
  const local = localVersion();

  const lockFile = join(ROOT, '.update-lock');
  if (existsSync(lockFile)) {
    console.error('Update already in progress (.update-lock exists). If stuck, delete it manually.');
    process.exit(1);
  }
  writeFileSync(lockFile, new Date().toISOString());

  try {
    // 1. Backup: branch (committed state).
    const backupBranch = updateBackupBranchName(local);
    git('branch', backupBranch);
    console.log(`Backup branch created: ${backupBranch}`);

    // 1b. Shelve uncommitted work, if any. Unlike the old checkout-based
    // design, `git merge` refuses outright to even start when uncommitted
    // changes overlap with files it would touch ("Your local changes...
    // would be overwritten by merge") — a real `git stash push` (not the
    // non-destructive `stash create`) is required to get a clean tree.
    // Nothing is lost: the stash entry stays in the stash list until
    // popped, so a failed pop later is recoverable, never silently gone.
    let stashedWip = false;
    if (gitStatusEntries().length > 0) {
      git('stash', 'push', '-m', `pre-update-wip-${local}`);
      stashedWip = true;
      console.log('Uncommitted changes stashed before merging (restored after, or left in the stash list if that fails).');
    }

    // 2. Fetch from canonical repo
    console.log('Fetching latest from upstream...');
    git('fetch', CANONICAL_REPO, 'main');

    let alreadyUpToDate = false;
    try {
      git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD');
      alreadyUpToDate = true;
    } catch {
      alreadyUpToDate = false;
    }
    if (alreadyUpToDate) {
      console.log('Already up to date with upstream.');
      if (stashedWip) {
        git('stash', 'pop');
        console.log('Restored your uncommitted changes.');
      }
      git('branch', '-D', backupBranch);
      return;
    }

    // 3. Merge. On a clean merge, git auto-commits; on conflicts it stops
    // and leaves the working tree in the conflicted state for step 3a/3b.
    console.log('Merging upstream/main...');
    let conflicted = false;
    try {
      git('merge', 'FETCH_HEAD', '--no-edit');
    } catch {
      conflicted = true;
    }
    const excludeEntries = loadUpdateExcludeEntries();

    if (conflicted) {
      const { resolved, remaining } = autoResolveExcludedConflicts(excludeEntries);
      if (resolved.length > 0) {
        console.log(`Auto-resolved ${resolved.length} conflict(s) for excluded path(s):`);
        for (const p of resolved) console.log(`  ${p}`);
      }
      if (remaining.length > 0) {
        console.error(`\n${remaining.length} merge conflict(s) need manual resolution:`);
        for (const p of remaining) console.error(`  ${p}`);
        console.error(`\nThe merge is left in progress — resolve the file(s) above, then run:`);
        console.error(`  git add <resolved files> && git commit --no-edit`);
        console.error(`\nPre-merge state is saved on branch: ${backupBranch}`);
        console.error(`To abandon the merge entirely: git merge --abort`);
        if (stashedWip) console.error(`Your uncommitted changes are safely stashed — after resolving, run: git stash pop`);
        throw new Error(`Update stopped: ${remaining.length} unresolved merge conflict(s).`);
      }
      // Every remaining conflict was auto-resolved — finish the merge commit.
      git('commit', '--no-edit');
    }

    // 3b. Restore stashed uncommitted work now that the merge is finalized.
    // Non-fatal: an update that itself succeeded shouldn't be reported as
    // failed just because reapplying unrelated WIP hit a conflict — the
    // stash entry stays in the stash list either way, never silently lost.
    if (stashedWip) {
      try {
        git('stash', 'pop');
        console.log('Restored your uncommitted changes on top of the update.');
      } catch {
        console.error('\nCould not automatically restore your uncommitted changes (they conflict with the update).');
        console.error('Nothing was lost — run `git stash list` then `git stash pop` to resolve manually.');
      }
    }

    // 4. Unconditional exclude sweep (see pruneExcludedPaths doc comment).
    const pruned = pruneExcludedPaths(excludeEntries);
    if (pruned.length > 0) {
      git('commit', '-m', 'chore: prune update-excluded paths', '--', ...pruned);
      console.log(`Pruned ${pruned.length} update-excluded path(s):`);
      for (const p of pruned) console.log(`  ${p}`);
    }

    // 5. Safety spot-check: did the merge touch a real user-layer path? Most
    // USER_PATHS entries are gitignored and so literally can't appear in a
    // merge diff — this only fires for the few tracked exceptions, and is a
    // warning (not an abort — the merge is already committed) since
    // selectively un-merging one path is exactly the fragile per-path
    // surgery this design replaced.
    const allowedSystemUserOverlap = new Set([
      'writing-samples/README.md',
      'interview-prep/sessions/.gitkeep',
      'interview-prep/sessions/README.md',
    ]);
    try {
      const touched = git('diff', '--name-only', backupBranch, 'HEAD').split('\n').filter(Boolean);
      const suspicious = touched.filter((f) =>
        !allowedSystemUserOverlap.has(f) && USER_PATHS.some((userPath) => f.startsWith(userPath)));
      if (suspicious.length > 0) {
        console.error(`\nWARNING: merge touched path(s) documented as user-layer:`);
        for (const f of suspicious) console.error(`  ${f}`);
        console.error(`Review these before trusting them; roll back with: node update-system.mjs rollback`);
      }
    } catch {
      // Non-fatal — this is a spot-check, not the primary safety mechanism
      // (most user paths are gitignored and untouchable by merge regardless).
    }

    // 6. Materialize skill-entrypoint pointers for filesystems without
    // symlink support (unrelated to the merge/checkout distinction — same
    // as before).
    const { ensureSkillEntrypoints } = await import('./scaffolder/bin/skill-entrypoints.mjs');
    const materializedSkillEntrypoints = ensureSkillEntrypoints(ROOT);
    if (materializedSkillEntrypoints.length > 0) {
      prepareMaterializedSkillEntrypointsForStage(materializedSkillEntrypoints);
      git('add', '--', ...materializedSkillEntrypoints);
      git('commit', '-m', 'chore: materialize skill entrypoints for symlink-incapable filesystem', '--', ...materializedSkillEntrypoints);
      console.log(`Materialized ${materializedSkillEntrypoints.length} skill entrypoint(s) for filesystems without symlink support`);
    }

    // 7. Install any new dependencies
    try {
      execSync('npm install --silent', { cwd: ROOT, timeout: NPM_INSTALL_TIMEOUT_MS });
    } catch {
      console.log('npm install skipped (may need manual run)');
    }

    // 7b. Ensure Playwright browser binary is up to date after npm install
    try {
      execSync('npx playwright install chromium', { cwd: ROOT, timeout: PLAYWRIGHT_INSTALL_TIMEOUT_MS, stdio: 'ignore' });
    } catch {
      console.log('playwright install skipped (run manually: npx playwright install chromium)');
    }

    // 8. Rebuild compiled dashboard if Go sources changed
    rebuildDashboardBinaryIfNeeded(backupBranch);

    // 9. Clear the dismiss flag, if set, now that the update actually landed.
    const dismissFile = join(ROOT, '.update-dismissed');
    if (existsSync(dismissFile)) unlinkSync(dismissFile);

    const remote = localVersion(); // Re-read after merge updated VERSION
    const changedCount = git('diff', '--name-only', backupBranch, 'HEAD').split('\n').filter(Boolean).length;

    console.log(`\nUpdate complete: v${local} → v${remote}`);
    console.log(`${changedCount} path(s) changed.`);
    console.log(`Rollback available: node update-system.mjs rollback`);

    console.log('\n-- The CareerOps Manifesto ------------------------------');
    console.log('A new way of job searching is taking shape. You are');
    console.log('already practicing it. Read it, sign it if you want to help:');
    console.log('    npm run manifesto  ·  https://career-ops.org/manifesto?utm_source=updater');

  } finally {
    if (existsSync(lockFile)) unlinkSync(lockFile);
  }
}

// ── ROLLBACK ────────────────────────────────────────────────────

function rollback() {
  try {
    // A merge-based apply() only ever changes tracked files as a single
    // commit (or a couple of scoped follow-up commits for the exclude-prune
    // and skill-entrypoint steps) on top of the backup branch. Resetting to
    // that branch undoes all of it in one step — no per-path restore/remove
    // dance needed, unlike the old checkout-based design.
    const branches = git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/backup-pre-update-*');
    const latest = newestBackupBranch(branches);

    if (!latest) {
      console.error('No backup branches found. Nothing to rollback.');
      process.exit(1);
    }

    // Refuse on a dirty working tree — `git reset --hard` would silently
    // discard uncommitted work unrelated to the update. Ask the user to
    // stash or commit first rather than guessing.
    const dirty = gitStatusEntries();
    if (dirty.length > 0) {
      console.error('Working tree has uncommitted changes — refusing to rollback.');
      console.error('Commit or stash your changes first, then re-run rollback.');
      for (const entry of dirty) console.error(`  ${entry.code} ${entry.path}`);
      process.exit(1);
    }

    console.log(`Rolling back to: ${latest}`);
    git('reset', '--hard', latest);
    console.log('Rollback complete.');
    console.log('Your data (CV, profile, tracker, reports) was not affected — those files are gitignored and untouched by merge.');
  } catch (err) {
    console.error('Rollback failed:', err.message);
    process.exit(1);
  }
}

// ── DISMISS ─────────────────────────────────────────────────────

function dismiss() {
  writeFileSync(join(ROOT, '.update-dismissed'), new Date().toISOString());
  console.log('Update check dismissed. Run "node update-system.mjs check" or say "check for updates" to re-enable.');
}

// ── MAIN ────────────────────────────────────────────────────────

// Only run the CLI when executed directly, so importing this module
// (e.g. from test-all.mjs to exercise SEMVER_RE) does not trigger a
// live update check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2] || 'check';

  try {
    switch (cmd) {
      case 'check': await check(); break;
      case 'apply': await apply(); break;
      case 'rollback': rollback(); break;
      case 'dismiss': dismiss(); break;
      default:
        console.log('Usage: node update-system.mjs [check|apply|rollback|dismiss]');
        process.exit(1);
    }
  } catch (err) {
    // Subcommands now `throw` on aborts so their outer `finally` blocks
    // run (e.g. apply() must release `.update-lock`). Print a clean
    // message here instead of letting Node spit out a stack trace.
    console.error(err.message || err);
    process.exit(1);
  }
}
