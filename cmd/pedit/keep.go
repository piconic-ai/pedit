package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
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

// defaultKeep is how long a room is kept when nothing says otherwise.
const defaultKeep = 24 * time.Hour

// applyConfigKeep makes `pedit <file>` keep its room: for the time keep: in
// .pedit/config.yaml gives, or for a day, unless the command line says
// otherwise. A config of keep: 0 turns it off, like --keep 0.
func applyConfigKeep(opts *commandArgs) error {
	if opts.File == "" || opts.Keep > 0 || opts.KeepOff || opts.Room != "" || opts.Resume != "" || opts.Template != "" || opts.Directory != "" {
		return nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	cfg, err := loadConfig(cwd)
	if err != nil {
		return err
	}
	switch cfg.Keep {
	case "0":
		opts.KeepOff = true
	case "":
		// A canvas cannot be kept, and a file that does not exist yet is
		// created from a template, not shared as it is.
		for _, file := range append([]string{opts.File}, opts.More...) {
			if _, err := os.Stat(file); err != nil || strings.EqualFold(filepath.Ext(file), ".canvas") {
				return nil
			}
		}
		opts.Keep = defaultKeep
	default:
		opts.Keep, err = parseKeepDuration(cfg.Keep)
	}
	return err
}

// resumeHeld makes `pedit <file>` resume the live kept room of this project
// that holds the file, as --resume does. The room's set of files is fixed, so
// a file it does not hold is an error. --keep 0 asks for a separate room.
func resumeHeld(opts *commandArgs, stdout, stderr io.Writer) (code int) {
	if opts.File == "" || opts.KeepOff || opts.Room != "" || opts.Resume != "" || opts.ResumeAny || opts.Template != "" || opts.Directory != "" {
		return 0
	}
	cwd, err := os.Getwd()
	if err != nil {
		return 0
	}
	cfg, err := loadConfig(cwd)
	if err != nil {
		return 0
	}
	records, err := session.ListKeptText(cfg.root)
	if err != nil {
		return 0
	}
	names := append([]string{opts.File}, opts.More...)
	files := make([]string, len(names))
	for i, name := range names {
		if files[i], err = filepath.Abs(name); err != nil {
			return 0
		}
	}
	now := time.Now().UnixMilli()
	for _, r := range records {
		if !r.Live || r.Until > 0 && r.Until <= now || !slices.Contains(r.Files, files[0]) {
			continue
		}
		for i, file := range files {
			if !slices.Contains(r.Files, file) {
				fmt.Fprintf(stderr, "pedit: %s is not in the kept room %s, which holds %s.\nRun pedit --close %s first, or pedit --keep 0 for a separate room.\n",
					names[i], r.Room, strings.Join(displayPaths(r.Files), ", "), r.Room)
				return 1
			}
		}
		fmt.Fprintf(stdout, "Resuming the kept room %s.\n", r.Room)
		opts.Resume = r.Room
		return 0
	}
	return 0
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
// another kept room. A live room is taken up again with pedit <file>; the
// polling one, which has no file here, with pedit --resume.
func printKeepHint(w io.Writer, room string, others bool, file string) {
	resume := "pedit --resume"
	if others {
		resume += " " + room
	}
	if file != "" {
		resume = "pedit " + file
		if others {
			resume += "  (or: pedit --resume " + room + ")"
		}
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
			shown := displayPaths(r.Files)
			opts.Resume, opts.File, opts.More = r.Room, shown[0], shown[1:]
			return true, 0
		}
	}
	return false, 0
}

// displayPaths shows a record's paths as displayPath does, so --resume names
// the files as the first run did.
func displayPaths(paths []string) []string {
	shown := make([]string, len(paths))
	for i, p := range paths {
		shown[i] = displayPath(p)
	}
	return shown
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
		printKeepHint(stdout, keptRoomOf(link), otherKeptRooms(cfg.root, keptRoomOf(link)), "")
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
