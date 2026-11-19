package data

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

func writeFixture(t *testing.T, root, rel string, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", rel, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

func TestLoadPDFManifestLaterRowsWin(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "data/pdf-index.tsv",
		"# report\tpdf\thtml\tformat\tdate\n"+
			"008\toutput/cv-old.pdf\toutput/cv-old.html\tletter\t2026-06-01\n"+
			"008\toutput/cv-new.pdf\toutput/cv-new.html\tletter\t2026-06-05\n"+
			"\toutput/cv-orphan.pdf\t\tletter\t2026-06-05\n")

	manifest := LoadPDFManifest(root)
	if len(manifest) != 1 {
		t.Fatalf("expected 1 indexed entry (orphan rows skipped), got %d", len(manifest))
	}
	entry, ok := manifest["8"] // indexed under the normalized (unpadded) key
	if !ok {
		t.Fatalf("expected entry for report 008 under normalized key")
	}
	if entry.PDFPath != "output/cv-new.pdf" {
		t.Fatalf("expected later row to win, got %q", entry.PDFPath)
	}
	if entry.HTMLPath != "output/cv-new.html" {
		t.Fatalf("expected html path parsed, got %q", entry.HTMLPath)
	}
}

func TestLoadPDFManifestMissingFile(t *testing.T) {
	manifest := LoadPDFManifest(t.TempDir())
	if len(manifest) != 0 {
		t.Fatalf("expected empty manifest for missing file, got %d entries", len(manifest))
	}
}

// Issue #6: a cover letter recorded after the CV must not become the
// application's PDF, whether its row carries kind=cover or is a legacy row
// whose kind is inferred from the -cover.pdf suffix.
func TestLoadPDFManifestSkipsCoverLetterRows(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "data/pdf-index.tsv",
		"# report\tpdf\thtml\tformat\tdate\tkind\n"+
			"094\toutput/cv-lightspeed-094.pdf\toutput/cv-lightspeed-094.html\tletter\t2026-08-05\tcv\n"+
			"094\toutput/lightspeed-se-094-cover.pdf\tdata/cover-payload-094.json\tletter\t2026-08-06\tcover\n"+
			"095\toutput/initech-se-095-cover.pdf\t\tletter\t2026-08-06\n"+
			"096\toutput/cv-hooli-096.pdf\t\tletter\t2026-08-07\n"+
			"097\toutput/cv-x-097.pdf\t\tletter\t2026-08-07\tresume\n")

	manifest := LoadPDFManifest(root)
	if entry, ok := manifest.Lookup(model.CareerApplication{ReportNumber: "094"}); !ok || entry.PDFPath != "output/cv-lightspeed-094.pdf" || entry.Kind != PDFKindCV {
		t.Fatalf("expected report 094's CV row, got %+v (found=%v)", entry, ok)
	}
	if entry, ok := manifest["95"]; ok {
		t.Fatalf("legacy -cover.pdf row must not be indexed as a CV, got %+v", entry)
	}
	if entry, ok := manifest["96"]; !ok || entry.Kind != PDFKindCV {
		t.Fatalf("legacy CV row must be indexed with inferred kind cv, got %+v (found=%v)", entry, ok)
	}
	if _, ok := manifest["97"]; ok {
		t.Fatalf("a row with an unknown kind is not a CV")
	}
	if len(manifest) != 2 {
		t.Fatalf("expected 2 CV entries (094, 096), got %d: %+v", len(manifest), manifest)
	}
}

func TestLoadPDFEntriesByPathKeepsEveryKind(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "data/pdf-index.tsv",
		"094\toutput/cv-lightspeed-094.pdf\toutput/cv-lightspeed-094.html\tletter\t2026-08-05\tcv\n"+
			"094\toutput/lightspeed-se-094-cover.pdf\t\tletter\t2026-08-06\tCOVER\n"+
			"\toutput/legacy-cover.pdf\t\tletter\t2026-08-06\n")

	byPath := LoadPDFEntriesByPath(root)
	want := map[string]string{
		"output/cv-lightspeed-094.pdf":       "cv",
		"output/lightspeed-se-094-cover.pdf": "cover",
		"output/legacy-cover.pdf":            "cover",
	}
	if len(byPath) != len(want) {
		t.Fatalf("expected %d entries, got %d: %+v", len(want), len(byPath), byPath)
	}
	for path, kind := range want {
		if got := byPath[path].Kind; got != kind {
			t.Fatalf("%s: expected kind %q, got %q", path, kind, got)
		}
	}
}

// The same cases as inferPDFKind in tests/pdf-manifest.test.mjs: only the
// -cover.pdf suffix marks a cover letter.
func TestInferPDFKindMatchesJSRule(t *testing.T) {
	cases := map[string]string{
		"output/acme-staff-eng-042-cover.pdf": "cover",
		"output/ACME-COVER.PDF":               "cover",
		"output/cv-covera-health-042.pdf":     "cv",
		"output/cv-acme-cover-team-042.pdf":   "cv",
		"output/cover.pdf":                    "cv",
		"":                                    "cv",
	}
	for path, want := range cases {
		if got := inferPDFKind(path); got != want {
			t.Errorf("inferPDFKind(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestResolvePDFsPrefersManifest(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "output/cv-jane-doe-acme-2026-06-01.pdf", "pdf")
	writeFixture(t, root, "output/cv-jane-doe-acme-exact-2026-06-05.pdf", "pdf")
	writeFixture(t, root, "data/pdf-index.tsv",
		"012\toutput/cv-jane-doe-acme-exact-2026-06-05.pdf\toutput/cv.html\tletter\t2026-06-05\n")

	app := model.CareerApplication{Company: "Acme", ReportNumber: "012"}
	got := ResolvePDFs(root, app, LoadPDFManifest(root))
	if len(got) != 1 || got[0] != "output/cv-jane-doe-acme-exact-2026-06-05.pdf" {
		t.Fatalf("expected single exact manifest match, got %v", got)
	}
}

func TestResolvePDFsManifestEntryWithMissingFileFallsBackToGlob(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "output/cv-jane-doe-acme-2026-06-01.pdf", "pdf")
	writeFixture(t, root, "data/pdf-index.tsv",
		"012\toutput/cv-deleted.pdf\toutput/cv.html\tletter\t2026-06-05\n")

	app := model.CareerApplication{Company: "Acme", ReportNumber: "012"}
	got := ResolvePDFs(root, app, LoadPDFManifest(root))
	if len(got) != 1 || got[0] != "output/cv-jane-doe-acme-2026-06-01.pdf" {
		t.Fatalf("expected glob fallback when manifest file is gone, got %v", got)
	}
}

func TestResolvePDFsGlobReturnsAllCompanyVariantsNewestFirst(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "output/cv-jane-doe-anthropic-2026-06-01.pdf", "pdf")
	writeFixture(t, root, "output/cv-jane-doe-anthropic-staff-ui-2026-06-05.pdf", "pdf")
	writeFixture(t, root, "output/cv-jane-doe-netflix-2026-06-05.pdf", "pdf")

	app := model.CareerApplication{Company: "Anthropic", ReportNumber: "099"}
	got := ResolvePDFs(root, app, LoadPDFManifest(root))
	if len(got) != 2 {
		t.Fatalf("expected 2 anthropic matches, got %v", got)
	}
	if got[0] != "output/cv-jane-doe-anthropic-staff-ui-2026-06-05.pdf" {
		t.Fatalf("expected newest first, got %v", got)
	}
}

func TestLookupTracksScrambledTrackerNumbers(t *testing.T) {
	root := t.TempDir()
	// Real trackers scramble the # column vs the report-link number
	// (e.g. row #19 links to report 008) and zero-pad the link form.
	writeFixture(t, root, "data/pdf-index.tsv",
		"008\toutput/cv-by-link.pdf\toutput/cv.html\tletter\t2026-06-05\n"+
			"19\toutput/cv-by-tracker.pdf\toutput/cv.html\tletter\t2026-06-05\n")
	manifest := LoadPDFManifest(root)

	// ReportNumber "008" matches the "008" row despite zero-padding.
	if entry, ok := manifest.Lookup(model.CareerApplication{Number: 99, ReportNumber: "008"}); !ok || entry.PDFPath != "output/cv-by-link.pdf" {
		t.Fatalf("expected report-link lookup to win, got %+v (ok=%v)", entry, ok)
	}
	// Unpadded "8" finds the padded "008" row too.
	if entry, ok := manifest.Lookup(model.CareerApplication{ReportNumber: "8"}); !ok || entry.PDFPath != "output/cv-by-link.pdf" {
		t.Fatalf("expected unpadded report number to match padded row, got %+v (ok=%v)", entry, ok)
	}
	// No report link parsed: fall back to the tracker # column.
	if entry, ok := manifest.Lookup(model.CareerApplication{Number: 19}); !ok || entry.PDFPath != "output/cv-by-tracker.pdf" {
		t.Fatalf("expected tracker-number fallback, got %+v (ok=%v)", entry, ok)
	}
	// Neither matches: miss.
	if _, ok := manifest.Lookup(model.CareerApplication{Number: 42, ReportNumber: "041"}); ok {
		t.Fatal("expected lookup miss for unknown numbers")
	}
}

func TestResolvePDFsManifestMatchWithMismatchedNumberAndPaddedKey(t *testing.T) {
	root := t.TempDir()
	writePDF := "output/cv-jane-doe-anthropic-staff-ui-2026-06-05.pdf"
	writeFixture(t, root, writePDF, "pdf")
	writeFixture(t, root, "output/cv-jane-doe-anthropic-other-2026-06-05.pdf", "pdf")
	writeFixture(t, root, "data/pdf-index.tsv",
		"008\t"+writePDF+"\toutput/cv.html\tletter\t2026-06-05\n")

	// Tracker row #19 → report 008: the manifest must still match exactly
	// instead of falling through to the ambiguous company glob.
	app := model.CareerApplication{Number: 19, Company: "Anthropic", ReportNumber: "008"}
	got := ResolvePDFs(root, app, LoadPDFManifest(root))
	if len(got) != 1 || got[0] != writePDF {
		t.Fatalf("expected exact manifest match for scrambled numbers, got %v", got)
	}
}

func TestResolvePDFsMultiWordCompany(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "output/cv-jane-doe-monarch-money-2026-06-05.pdf", "pdf")

	app := model.CareerApplication{Company: "Monarch Money"}
	got := ResolvePDFs(root, app, LoadPDFManifest(root))
	if len(got) != 1 {
		t.Fatalf("expected multi-word company to match its kebab slug, got %v", got)
	}
}

func TestResolvePDFsNoMatch(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "output/cv-jane-doe-acme-2026-06-05.pdf", "pdf")

	app := model.CareerApplication{Company: "Globex"}
	if got := ResolvePDFs(root, app, LoadPDFManifest(root)); len(got) != 0 {
		t.Fatalf("expected no matches for unrelated company, got %v", got)
	}
}

func TestKebabCase(t *testing.T) {
	cases := map[string]string{
		"Monarch Money":   "monarch-money",
		"Anthropic":       "anthropic",
		"  O'Brien & Co ": "o-brien-co",
		"X":               "x",
	}
	for in, want := range cases {
		if got := kebabCase(in); got != want {
			t.Errorf("kebabCase(%q) = %q, want %q", in, got, want)
		}
	}
}

// A company with several applications: the company-slug fallback must hand
// each application its own CV, never a sibling's
// (plans/10-07-26_report-number-as-id.md).
func TestResolveFallbackNarrowsByReportNumber(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(root, "output")
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"cv-vercel-183.pdf", "cv-vercel-183.html", // current form
		"cv-taher-jamali-vercel-184-2026-09-11.pdf", "cv-taher-jamali-vercel-184.html", // dated pre-2026-10 form
		"cv-vercel-183-latex.pdf",                                        // LaTeX variant of 183
		"cv-candidate-vercel-2026-07-22.pdf", "cv-candidate-vercel.html", // legacy, no number
	} {
		if err := os.WriteFile(filepath.Join(out, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	app := func(report string) model.CareerApplication {
		return model.CareerApplication{Company: "Vercel", ReportNumber: report}
	}

	got := ResolvePDFs(root, app("183"), PDFManifest{})
	if len(got) != 2 || !contains(got, "output/cv-vercel-183.pdf") || !contains(got, "output/cv-vercel-183-latex.pdf") {
		t.Errorf("report 183: want only its own two PDFs, got %v", got)
	}
	got = ResolvePDFs(root, app("184"), PDFManifest{})
	if len(got) != 1 || got[0] != "output/cv-taher-jamali-vercel-184-2026-09-11.pdf" {
		t.Errorf("report 184: want only its dated PDF, got %v", got)
	}
	// No file carries 999: numbered files belong to other reports, so only the
	// legacy unnumbered CV remains a candidate.
	got = ResolvePDFs(root, app("999"), PDFManifest{})
	if len(got) != 1 || got[0] != "output/cv-candidate-vercel-2026-07-22.pdf" {
		t.Errorf("report 999: want only the legacy CV, got %v", got)
	}

	if html, pdf := ResolveHTML(root, app("184")); html != "output/cv-taher-jamali-vercel-184.html" || pdf != "output/cv-taher-jamali-vercel-184.pdf" {
		t.Errorf("ResolveHTML 184: got %q, %q", html, pdf)
	}
	if html, _ := ResolveHTML(root, app("999")); html != "output/cv-candidate-vercel.html" {
		t.Errorf("ResolveHTML 999: want the legacy HTML, got %q", html)
	}
}

func TestCVReportNumberIgnoresDateFragments(t *testing.T) {
	cases := map[string]int{
		"cv-acme-006.pdf":                         6,
		"cv-acme-278-latex.pdf":                   278,
		"cv-acme-278-canva.pdf":                   278,
		"cv-taher-jamali-acme-278-2026-10-06.pdf": 278,
	}
	for name, want := range cases {
		if n, ok := cvReportNumber(name); !ok || n != want {
			t.Errorf("%s: want %d, got %d (ok=%v)", name, want, n, ok)
		}
	}
	for _, name := range []string{"cv-acme-2026-10-06.pdf", "cv-candidate-acme.html", "cv-acme-06.pdf"} {
		if n, ok := cvReportNumber(name); ok {
			t.Errorf("%s: want no report number, got %d", name, n)
		}
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
