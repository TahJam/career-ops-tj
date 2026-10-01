package data

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// The Go twin of lib/report-summary.mjs's job-location rules. The dashboard
// cannot import the JS module, so it re-implements the read and the check here;
// both are run against tests/fixtures/report-location-cases.json, and a rule
// changed on one side only fails that side's tests.
//
// Go has no YAML parser, so it reads every fence the way the JS reader falls
// back when js-yaml rejects one: top-level `key: scalar` lines, with the same
// scalar rules (yamlScalar). A JSON fence is decoded as JSON.

var (
	// A report's Machine Summary fence; group 1 is the body. Mirrors
	// MACHINE_SUMMARY_RE in lib/report-summary.mjs.
	reMachineSummary = regexp.MustCompile("(?is)##\\s*Machine Summary\\s*\\n+```(?:yaml|yml|json)?\\s*\\n(.*?)\\n```")
	reWorkModeKey    = regexp.MustCompile(`(?m)^work_mode:[ \t]*(.*)$`)
	reJobLocationKey = regexp.MustCompile(`(?m)^job_location:[ \t]*(.*)$`)
	reYAMLComment    = regexp.MustCompile(`\s#.*$`)

	// Location-shape rules; see locationProblem in lib/report-summary.mjs.
	rePlaceholder    = regexp.MustCompile(`(?i)\b(remote|hybrid|on-?site|tbd|tba|n/a|none|unknown|various|anywhere|multiple)\b`)
	reCityCommaState = regexp.MustCompile(`^([^,]+), ([A-Z]{2})$`)
	reMissingComma   = regexp.MustCompile(`\s[A-Z]{2}$`)
	reCityName       = regexp.MustCompile(`^\pL[\pL\pM .'’-]*$`)
)

// usStates is the 50 states and DC; US_STATES in lib/report-summary.mjs must
// hold the same codes (both are checked against the shared fixture's usStates).
var usStates = []string{
	"AK", "AL", "AR", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "IA", "ID", "IL", "IN", "KS",
	"KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV",
	"NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY",
}

// workModeLabels maps the report's work_mode enum onto the WorkMode values the
// pipeline screen already renders and sorts on.
var workModeLabels = map[string]string{
	"remote":      "Remote",
	"remote_flex": "RemoteFlex",
	"hybrid":      "Hybrid",
	"onsite":      "Full",
}

// nullScalars are js-yaml's core-schema null spellings.
var nullScalars = map[string]bool{"": true, "~": true, "null": true, "Null": true, "NULL": true}

// yamlScalar reads one top-level YAML scalar from the text after `key:`, with
// the rules of yamlScalar() in lib/report-summary.mjs: a doubled single quote
// and a backslash-escaped double quote inside quotes, a " #" comment dropped
// from a bare value, and the core-schema null spellings. ok is false for a null
// value or an unterminated quote.
func yamlScalar(raw string) (value string, ok bool) {
	v := strings.TrimSpace(raw)
	if v != "" && (v[0] == '"' || v[0] == '\'') {
		q := v[0]
		var out strings.Builder
		for i := 1; i < len(v); i++ {
			ch := v[i]
			if q == '\'' && ch == '\'' {
				if i+1 < len(v) && v[i+1] == '\'' {
					out.WriteByte('\'')
					i++
					continue
				}
				return out.String(), true
			}
			if q == '"' && ch == '\\' && i+1 < len(v) && (v[i+1] == '"' || v[i+1] == '\\') {
				out.WriteByte(v[i+1])
				i++
				continue
			}
			if q == '"' && ch == '"' {
				return out.String(), true
			}
			out.WriteByte(ch)
		}
		return "", false
	}
	bare := strings.TrimSpace(reYAMLComment.ReplaceAllString(v, ""))
	if nullScalars[bare] {
		return "", false
	}
	return bare, true
}

// jobLocationKeys is what a report's fence says, before any validation.
type jobLocationKeys struct {
	workMode, location       string // raw, trimmed; "" when absent or null
	hasWorkMode, hasLocation bool   // whether the key appears at all
}

// readJobLocationKeys reads work_mode / job_location from a report's Machine
// Summary. ok is false when the report has no fence.
func readJobLocationKeys(report string) (keys jobLocationKeys, ok bool) {
	fence := reMachineSummary.FindStringSubmatch(report)
	if fence == nil {
		return keys, false
	}
	body := fence[1]
	if strings.HasPrefix(strings.TrimSpace(body), "{") {
		var doc map[string]any
		if json.Unmarshal([]byte(body), &doc) == nil {
			str := func(v any) string { s, _ := v.(string); return strings.TrimSpace(s) }
			_, keys.hasWorkMode = doc["work_mode"]
			_, keys.hasLocation = doc["job_location"]
			keys.workMode, keys.location = str(doc["work_mode"]), str(doc["job_location"])
			return keys, true
		}
	}
	// A repeated key overrides, as in js-yaml's json mode: take the last line.
	last := func(re *regexp.Regexp) (string, bool) {
		all := re.FindAllStringSubmatch(body, -1)
		if len(all) == 0 {
			return "", false
		}
		v, _ := yamlScalar(all[len(all)-1][1])
		return strings.TrimSpace(v), true
	}
	keys.workMode, keys.hasWorkMode = last(reWorkModeKey)
	keys.location, keys.hasLocation = last(reJobLocationKey)
	return keys, true
}

// parseJobLocation is the twin of jobLocation(): the normalized work_mode
// ("" when unknown) and the raw job_location.
func parseJobLocation(report string) (workMode, location string) {
	keys, _ := readJobLocationKeys(report)
	workMode = strings.ToLower(keys.workMode)
	if _, known := workModeLabels[workMode]; !known {
		workMode = ""
	}
	return workMode, keys.location
}

// checkJobLocation is the twin of checkJobLocation(): "ok", "missing" (no fence,
// or neither key) or "invalid", with a reason for the last.
func checkJobLocation(report string) (state, reason string) {
	keys, ok := readJobLocationKeys(report)
	if !ok || (!keys.hasWorkMode && !keys.hasLocation) {
		return "missing", "no work_mode / job_location keys"
	}
	workMode, location := parseJobLocation(report)
	if workMode == "" {
		return "invalid", fmt.Sprintf("work_mode %q is not remote | remote_flex | hybrid | onsite", keys.workMode)
	}
	if location == "" {
		if workMode == "remote" || workMode == "remote_flex" {
			return "ok", ""
		}
		return "invalid", workMode + " role has no job_location"
	}
	if problem := locationProblem(location); problem != "" {
		return "invalid", problem
	}
	return "ok", ""
}

// locationProblem is the twin of locationProblem(): why a job_location is not
// "City, ST" (US) or a bare city, or "" when it is one.
func locationProblem(location string) string {
	if rePlaceholder.MatchString(location) {
		return fmt.Sprintf("job_location %q is a placeholder, not a place", location)
	}
	city := location
	if strings.Contains(location, ",") {
		m := reCityCommaState.FindStringSubmatch(location)
		if m == nil {
			return fmt.Sprintf("job_location %q is not \"City, ST\" or a bare city", location)
		}
		if !isUSState(m[2]) {
			return fmt.Sprintf("job_location %q: %s is not a US state code", location, m[2])
		}
		city = m[1]
	} else if reMissingComma.MatchString(location) {
		return fmt.Sprintf("job_location %q is missing the comma in \"City, ST\"", location)
	}
	if !reCityName.MatchString(city) {
		return fmt.Sprintf("job_location %q is not a city name", location)
	}
	return ""
}

func isUSState(code string) bool {
	for _, s := range usStates {
		if s == code {
			return true
		}
	}
	return false
}

// applyReportLocation overrides the Notes-derived Location and WorkMode with
// the report's work_mode / job_location, the single source of truth for a
// job's location. It applies the rule sheetLocation() applies to column F: only
// a report that passes checkJobLocation is used, so the dashboard and the sheet
// never disagree on a bad value. Otherwise the Notes heuristic stays in place.
func applyReportLocation(app *model.CareerApplication, report string) {
	if state, _ := checkJobLocation(report); state != "ok" {
		return
	}
	workMode, location := parseJobLocation(report)
	app.WorkMode = workModeLabels[workMode]
	app.Location = location
}
