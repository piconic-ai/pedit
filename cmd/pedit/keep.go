package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/piconic-ai/pedit/internal/session"
)

func parseKeepDuration(value string) (time.Duration, error) {
	if strings.HasSuffix(value, "d") {
		days, err := strconv.ParseUint(strings.TrimSuffix(value, "d"), 10, 32)
		if err != nil || days == 0 {
			return 0, errors.New("invalid keep duration")
		}
		value = strconv.FormatUint(days*24, 10) + "h"
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 || duration%time.Second != 0 {
		return 0, errors.New("keep duration must be positive whole seconds, for example 7d")
	}
	return duration, nil
}

// applyConfigKeep makes `pedit <file>` keep its room when .pedit/config.yaml
// sets keep: and the command line does not say otherwise.
func applyConfigKeep(opts *commandArgs) error {
	if opts.File == "" || opts.Keep > 0 || opts.KeepOff || opts.Room != "" || opts.Template != "" || opts.Directory != "" {
		return nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	cfg, err := loadConfig(cwd)
	if err != nil || cfg.Keep == "" {
		return err
	}
	opts.Keep, err = parseKeepDuration(cfg.Keep)
	return err
}

// formatKeep prints a keep time in its largest whole unit: 7d, 12h, 90m, 45s.
func formatKeep(seconds int64) string {
	for _, u := range []struct {
		n    int64
		unit string
	}{{86400, "d"}, {3600, "h"}, {60, "m"}} {
		if seconds%u.n == 0 {
			return fmt.Sprintf("%d%s", seconds/u.n, u.unit)
		}
	}
	return fmt.Sprintf("%ds", seconds)
}

// printKeepHint tells how to come back; others is whether this project has
// another kept room, which makes a bare --resume ambiguous.
func printKeepHint(w io.Writer, room string, others bool) {
	resume := "pedit --resume"
	if others {
		resume += " " + room
	}
	fmt.Fprintf(w, "Leave with Ctrl+C. To take in the edits later, run in this directory:\n  %s\n", resume)
}

func describeKept(r session.KeptTextRecord) string {
	until := "unknown"
	if r.Until > 0 {
		until = time.UnixMilli(r.Until).Format(time.RFC3339)
	}
	return fmt.Sprintf("%s  %s  until %s", r.Room, strings.Join(r.Paths, ", "), until)
}

// pickKept chooses the room for a bare --resume. It returns the room ID, or an
// exit code when there is nothing to resume or no way to ask.
func pickKept(records []session.KeptTextRecord, in io.Reader, interactive bool, stdout, stderr io.Writer) (string, int) {
	switch len(records) {
	case 0:
		fmt.Fprintln(stderr, "pedit: no kept room in this project")
		return "", 1
	case 1:
		return records[0].Room, 0
	}
	sort.SliceStable(records, func(i, j int) bool { return records[i].Until < records[j].Until })
	for i, r := range records {
		fmt.Fprintf(stdout, "%d) %s\n", i+1, describeKept(r))
	}
	if !interactive {
		fmt.Fprintln(stderr, "pedit: several kept rooms in this project; pass a room ID too")
		return "", 1
	}
	fmt.Fprintf(stdout, "Which one? [1-%d] ", len(records))
	line, _ := bufio.NewReader(in).ReadString('\n')
	n, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || n < 1 || n > len(records) {
		fmt.Fprintln(stderr, "pedit: not a choice; pass a room ID too")
		return "", 1
	}
	return records[n-1].Room, 0
}

// chooseResume settles which room --resume or --close is about, asking when
// the project has several, and tells whether it is a live one, which the
// relay keeps. For a live room it sets the files from its record.
func chooseResume(opts *commandArgs, stdout, stderr io.Writer) (live bool, code int) {
	cwd, err := os.Getwd()
	var cfg config
	if err == nil {
		cfg, err = loadConfig(cwd)
	}
	var records []session.KeptTextRecord
	if err == nil {
		records, err = session.ListKeptText(cfg.root)
	}
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return false, 1
	}
	if opts.ResumeAny {
		room, code := pickKept(records, os.Stdin, isTerminal(os.Stdin), stdout, stderr)
		if code != 0 {
			return false, code
		}
		opts.Resume, opts.ResumeAny = room, false
	}
	for _, r := range records {
		if r.Live && (r.Room == opts.Resume || strings.Contains(opts.Resume, "/r/"+r.Room)) {
			opts.Resume, opts.File, opts.More = r.Room, r.Files[0], r.Files[1:]
			return true, 0
		}
	}
	return false, 0
}

func runKeep(opts commandArgs, stdout, stderr io.Writer) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	cfg, err := loadConfig(cwd)
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	server := cfg.Server
	if opts.Resume != "" {
		server = ""
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = session.RunKeptText(ctx, session.KeptTextOptions{
		File: opts.File, More: opts.More, Project: cfg.root, Server: server, Resume: opts.Resume, Keep: opts.Keep, Close: opts.Close,
		OnSkipped: func(count int) { fmt.Fprintf(stdout, "Skipped %d invalid updates.\n", count) },
		OnPruned:  func(n int) { fmt.Fprintf(stdout, "Removed %d resume record(s) of finished rooms.\n", n) },
		OnImageError: func(path string, err error) {
			fmt.Fprintf(stdout, "Could not save an image of %s: %v\n", path, err)
		},
		OnEnded: func() { fmt.Fprintln(stdout, "The room is over; removed its resume record.") },
	}, func(link string, seconds, until int64) {
		fmt.Fprintln(stdout, link)
		if opts.Keep > time.Duration(seconds)*time.Second {
			fmt.Fprintf(stdout, "Relay capped keep time to %s.\n", formatKeep(seconds))
		} else {
			fmt.Fprintf(stdout, "Room keep time: %s.", formatKeep(seconds))
		}
		fmt.Fprintf(stdout, " Room stays open until %s.\n", time.UnixMilli(until).Format(time.RFC3339))
		printKeepHint(stdout, keptRoomOf(link), otherKeptRooms(cfg.root, keptRoomOf(link)))
	}, func(until int64) {
		fmt.Fprintf(stdout, "Room stays open until %s.\n", time.UnixMilli(until).Format(time.RFC3339))
	})
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	if opts.Close {
		fmt.Fprintln(stdout, "Closed the room; its link no longer works.")
	}
	return 0
}

func keptRoomOf(link string) string {
	room, _, _ := strings.Cut(link[strings.Index(link, "/r/")+3:], "#")
	room, _, _ = strings.Cut(room, "?")
	return room
}

func otherKeptRooms(project, room string) bool {
	records, _ := session.ListKeptText(project)
	for _, r := range records {
		if r.Room != room {
			return true
		}
	}
	return false
}
