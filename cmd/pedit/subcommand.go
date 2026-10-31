package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/piconic-ai/pedit/internal/session"
)

// A subcommand is a verb of pedit. Sharing a file and joining a link need no
// verb; everything else is one, and takes its own flags after its name.
type subcommand struct {
	usage string
	run   func(args []string, stdout, stderr io.Writer) int
}

var subcommands = map[string]subcommand{
	"close": {closeUsage, runClose},
	"rooms": {roomsUsage, runRooms},
}

const closeUsage = `Usage: pedit close [room|link]

Take in the edits, comments and images of a kept room of this project, as
pedit <file> does, then close the room for good: its link stops working and the
relay deletes what it holds. Without a room, pedit closes the project's only
kept room, or lists them and asks which.`

const roomsUsage = `Usage: pedit rooms [--json]

List the kept rooms of this project: the room ID, its files, and until when
the relay keeps it.

Options:
  --json  Print a JSON array of {"room", "files", "until"} instead`

// runSubcommand runs args[0] when it names a subcommand. A file with such a
// name is shared as ./close, or after --.
func runSubcommand(args []string, stdout, stderr io.Writer) (code int, ok bool) {
	if len(args) == 0 {
		return 0, false
	}
	sub, ok := subcommands[args[0]]
	if !ok {
		return 0, false
	}
	if len(args) == 2 && (args[1] == "-h" || args[1] == "--help") {
		fmt.Fprintln(stdout, sub.usage)
		return 0, true
	}
	return sub.run(args[1:], stdout, stderr), true
}

// usageError reports a misused subcommand with its usage.
func usageError(stderr io.Writer, usage string, err error) int {
	fmt.Fprintln(stderr, "pedit:", err)
	fmt.Fprintln(stderr, usage)
	return 2
}

func runClose(args []string, stdout, stderr io.Writer) int {
	opts, err := parseCloseArgs(args)
	if err != nil {
		return usageError(stderr, closeUsage, err)
	}
	return closeRoom(opts, stdout, stderr)
}

// parseCloseArgs takes at most one room ID or share link. A room ID may begin
// with "-", so it is taken as one before anything is read as an option.
func parseCloseArgs(args []string) (commandArgs, error) {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	opts := commandArgs{Close: true}
	switch {
	case len(args) == 0:
		opts.ResumeAny = true
	case len(args) > 1:
		return opts, errors.New("close takes one room ID or share link")
	case roomIDArg.MatchString(args[0]) || isShareLink(args[0]):
		opts.Resume = args[0]
	default:
		return opts, fmt.Errorf("not a room ID or share link: %s", args[0])
	}
	return opts, nil
}

// closeRoom settles which kept room opts names, then takes it in and closes it.
func closeRoom(opts commandArgs, stdout, stderr io.Writer) int {
	if code := chooseResume(&opts, stdout, stderr); code != 0 {
		return code
	}
	return closeKept(opts, stdout, stderr)
}

func runRooms(args []string, stdout, stderr io.Writer) int {
	asJSON := false
	for _, arg := range args {
		if arg != "--json" || asJSON {
			return usageError(stderr, roomsUsage, fmt.Errorf("unexpected argument: %s", arg))
		}
		asJSON = true
	}
	cwd, err := os.Getwd()
	var cfg config
	if err == nil {
		cfg, err = loadConfig(cwd)
	}
	var records []session.KeptTextRecord
	if err == nil {
		// What pruning says is not for a program reading the list.
		notes := stdout
		if asJSON {
			notes = stderr
		}
		pruneKept(cfg.root, notes)
		records, err = session.ListKeptText(cfg.root)
	}
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	if asJSON {
		return printRoomsJSON(stdout, stderr, records)
	}
	if len(records) == 0 {
		fmt.Fprintln(stdout, "No kept rooms in this project.")
		return 0
	}
	for _, r := range records {
		fmt.Fprintln(stdout, describeKept(r))
	}
	return 0
}

// keptRoomJSON is one room in pedit rooms --json. It never holds the room key.
type keptRoomJSON struct {
	Room  string   `json:"room"`
	Files []string `json:"files"`
	// Until is the relay's deadline, or null while the host is connected or
	// it is not known.
	Until *string `json:"until"`
}

func printRoomsJSON(stdout, stderr io.Writer, records []session.KeptTextRecord) int {
	rooms := make([]keptRoomJSON, len(records))
	for i, r := range records {
		rooms[i] = keptRoomJSON{Room: r.Room, Files: r.Files}
		if r.Until > 0 {
			until := time.UnixMilli(r.Until).UTC().Format(time.RFC3339)
			rooms[i].Until = &until
		}
	}
	data, err := json.MarshalIndent(rooms, "", "  ")
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	fmt.Fprintln(stdout, string(data))
	return 0
}

// closeOptionNotice is printed for --close, kept for one release as an alias.
func closeOptionNotice(stderr io.Writer, opts commandArgs) {
	room := ""
	if opts.Resume != "" && !strings.Contains(opts.Resume, "/r/") {
		room = " " + opts.Resume
	}
	fmt.Fprintf(stderr, "pedit: --close is now pedit close%s; the option goes in a later release.\n", room)
}
