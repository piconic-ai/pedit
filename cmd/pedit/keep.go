package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
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
		File: opts.File, More: opts.More, Project: cfg.root, Server: server, Resume: opts.Resume, Keep: opts.Keep,
		OnSkipped: func(count int) { fmt.Fprintf(stdout, "Skipped %d invalid updates.\n", count) },
		OnPruned:  func(n int) { fmt.Fprintf(stdout, "Removed %d resume record(s) of finished rooms.\n", n) },
		OnEnded:   func() { fmt.Fprintln(stdout, "The room is over; removed its resume record.") },
	}, func(link string, seconds, until int64) {
		fmt.Fprintln(stdout, link)
		if opts.Keep > time.Duration(seconds)*time.Second {
			fmt.Fprintf(stdout, "Relay capped keep time to %ds.\n", seconds)
		} else {
			fmt.Fprintf(stdout, "Room keep time: %ds.\n", seconds)
		}
	}, func(until int64) {
		fmt.Fprintf(stdout, "Room stays open until %s.\n", time.UnixMilli(until).Format(time.RFC3339))
	})
	if err != nil {
		fmt.Fprintln(stderr, "pedit:", err)
		return 1
	}
	return 0
}
