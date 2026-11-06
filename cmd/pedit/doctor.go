package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/piconic-ai/pedit/internal/doctor"
)

const doctorUsage = `Usage: pedit doctor <url> [--json]

Check a review page (docs/design/embedding.md): its Content-Security-Policy
against the one @pedit/review gives for the page's relay, the scripts on the
page, the component's version and the Referrer-Policy. It never opens a room,
sends no cookies, credentials or Referer, and contacts only the page's origin.
A #fragment in the URL is dropped before anything is fetched, and never printed.

Exit status: 0 when no check fails, 1 when one does, 2 when the page cannot be
checked (bad arguments, or it cannot be fetched).

Options:
  --json  Print {"url", "checks": [{"id", "status", "message", "fix"?}],
          "component": {"src", "version"}, "relay"} instead`

func runDoctor(args []string, stdout, stderr io.Writer) int {
	var target string
	asJSON := false
	for _, arg := range args {
		switch {
		case arg == "--json" && !asJSON:
			asJSON = true
		case strings.HasPrefix(arg, "-") || target != "":
			return usageError(stderr, doctorUsage, fmt.Errorf("unexpected argument: %s", arg))
		default:
			target = arg
		}
	}
	if target == "" {
		return usageError(stderr, doctorUsage, fmt.Errorf("doctor needs the URL of a review page"))
	}
	u, err := doctor.ParseTarget(target)
	if err != nil {
		return usageError(stderr, doctorUsage, err)
	}
	rep := doctor.Run(u, doctor.Options{Version: getVersion(), Newer: newerVersion})
	if asJSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(rep); err != nil {
			fmt.Fprintln(stderr, "pedit:", err)
			return 2
		}
	} else {
		printDoctor(stdout, rep)
	}
	switch {
	case rep.Unreachable:
		return 2
	case rep.Failed():
		return 1
	}
	return 0
}

func printDoctor(w io.Writer, rep *doctor.Report) {
	marks := map[string]string{doctor.OK: "✓", doctor.Warn: "!", doctor.Fail: "✗"}
	counts := map[string]int{}
	fmt.Fprintln(w, "Checking", rep.URL)
	for _, c := range rep.Checks {
		counts[c.Status]++
		fmt.Fprintf(w, "%s %s: %s\n", marks[c.Status], c.ID, c.Message)
		if c.Fix != "" {
			fmt.Fprintf(w, "    to fix: %s\n", c.Fix)
		}
	}
	fmt.Fprintf(w, "%d ok, %d warnings, %d failed\n", counts[doctor.OK], counts[doctor.Warn], counts[doctor.Fail])
}
