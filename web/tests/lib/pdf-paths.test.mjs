// Tests for resolvePdfPaths()/slugify() using Node's built-in test runner.
// Imports directly from pdf-paths.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/pdf-paths.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { slugify, resolvePdfPaths } from "../../src/lib/pdf-paths.mjs";

test("slugify: lowercases and hyphenates", () => {
  assert.equal(slugify("Jane Q. Smith"), "jane-q-smith");
});

test("slugify: trims leading/trailing hyphens", () => {
  assert.equal(slugify("  -Weird Name!- "), "weird-name");
});

// Given a career-ops root with a report on disk and a profile.yml naming the candidate
function makeRoot({ profileYaml } = {}) {
  const root = mkdtempSync(join(tmpdir(), "co-pdfpaths-"));
  mkdirSync(join(root, "config"), { recursive: true });
  if (profileYaml !== null) {
    writeFileSync(join(root, "config", "profile.yml"), profileYaml ?? 'candidate:\n  full_name: "Jane Smith"\n');
  }
  return root;
}

test("resolvePdfPaths: happy path builds html/meta/finalPdf from the report", () => {
  // Given a root with a resolvable report (its profile.yml names a candidate, which the name ignores)
  const root = makeRoot();
  const findReportFile = (input) => (input === "018" ? join(root, "reports", "018-acme-2026-07-01.md") : null);
  try {
    // When resolving paths for report #018
    const result = resolvePdfPaths("018", root, findReportFile);

    // Then it returns deterministic scratch + final paths named cv-{company-slug}-{NNN}
    assert.equal(result.ok, true);
    assert.equal(result.paths.html, join(root, ".career-ops-web", "pdf-tmp", "cv-web-018.html"));
    assert.equal(result.paths.meta, join(root, ".career-ops-web", "pdf-tmp", "cv-web-018.meta.json"));
    assert.equal(result.paths.finalPdf, join(root, "output", "cv-acme-018.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: path-traversal selector is rejected before any path is built", () => {
  // Given a findReportFile that would (via parseInt-based matching) resolve a
  // traversal-shaped selector to a real report, and a directory sentinel to
  // prove no scratch dir gets created for this input
  const root = makeRoot();
  const scratchDir = join(root, ".career-ops-web", "pdf-tmp");
  const findReportFile = () => join(root, "reports", "123-acme-2026-07-01.md");
  try {
    // When resolving paths for a crafted, non-canonical selector
    const result = resolvePdfPaths("123/../../etc/passwd", root, findReportFile);

    // Then it fails closed with a clear error, never calling findReportFile or touching disk
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid report selector/);
    assert.equal(existsSync(scratchDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: no matching report -> ok:false, no directories created", () => {
  // Given a root where findReportFile never resolves
  const root = makeRoot();
  const findReportFile = () => null;
  try {
    // When resolving paths for a report that doesn't exist
    const result = resolvePdfPaths("999", root, findReportFile);

    // Then it fails with a user-facing error and never touches the filesystem
    assert.equal(result.ok, false);
    assert.match(result.error, /No report #999 found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: two roles at one company get different names, and profile.yml is not read", () => {
  // Given two reports for the same company and a profile.yml that would have
  // named the candidate under the old convention
  const root = makeRoot();
  const findReportFile = (input) => ({
    "141": join(root, "reports", "141-perplexity-2026-09-02.md"),
    "144": join(root, "reports", "144-perplexity-2026-09-02.md"),
  })[input] ?? null;
  try {
    // When resolving paths for each report
    const a = resolvePdfPaths("141", root, findReportFile);
    const b = resolvePdfPaths("144", root, findReportFile);

    // Then each final PDF carries its own report number and no candidate slug
    assert.equal(a.paths.finalPdf, join(root, "output", "cv-perplexity-141.pdf"));
    assert.equal(b.paths.finalPdf, join(root, "output", "cv-perplexity-144.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: report filename that doesn't match the expected pattern falls back to the default company slug", () => {
  // Given findReportFile resolves to a filename that doesn't match ^\d+-(.+)-YYYY-MM-DD.md$
  const root = makeRoot();
  const findReportFile = (input) => (input === "7" ? join(root, "reports", "not-the-expected-shape.md") : null);
  try {
    // When resolving paths for report #7
    const result = resolvePdfPaths("7", root, findReportFile);

    // Then it still succeeds, using the "company" fallback slug and the selector as the number
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "cv-company-7.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
