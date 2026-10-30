package session

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

func TestKeptTextPendingWriteRecoveryAndExternalChange(t *testing.T) {
	for _, disk := range []string{"before", "after", "external"} {
		t.Run(disk, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "notes.md")
			path := filepath.Join(dir, "state.keep.json")
			if err := os.WriteFile(file, []byte(disk), 0600); err != nil {
				t.Fatal(err)
			}
			pending := "after"
			s := keptTextState{File: file, Text: "before", Pending: &pending}
			if err := saveKeptState(path, s); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("host state not private")
			}
			var reopened keptTextState
			if err := readKeptState(path, &reopened); err != nil {
				t.Fatal(err)
			}
			bound, err := filewriter.OpenBound(file)
			if err != nil {
				t.Fatal(err)
			}
			defer bound.Close()
			err = finishKeptWrite(path, &reopened, bound)
			data, _ := os.ReadFile(file)
			if disk == "external" {
				if err == nil || string(data) != "external" {
					t.Fatal("overwrote external edit")
				}
				return
			}
			if err != nil || string(data) != "after" {
				t.Fatalf("resume write: %v", err)
			}
			if err := readKeptState(path, &reopened); err != nil || reopened.Pending != nil || reopened.Text != "after" {
				t.Fatal("journal not completed")
			}
			if err := os.Chmod(path, 0644); err != nil {
				t.Fatal(err)
			}
			if err := readKeptState(path, &reopened); err == nil {
				t.Fatal("accepted public host state")
			}
		})
	}
}

func TestKeptTextResumesAfterCommittedCheckpointResponseIsLost(t *testing.T) {
	isolateKeptUserConfig(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(file, []byte("base"), 0600); err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	hash := sha256.Sum256([]byte(token))
	room := base64.RawURLEncoding.EncodeToString(hash[:])[:22]
	var keys *protocol.RoomKeys
	var snapshot []byte
	initCalls, checkpoints := 0, 0
	var fullLink string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/rooms" {
			json.NewEncoder(w).Encode(map[string]string{"id": room, "hostToken": token})
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(403)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/init"):
			initCalls++
			var state keptTextState
			if err := readKeptState(keptTestStatePath(t, dir, room), &state); err != nil {
				t.Error("network initialization preceded private durable state")
			}
			link, err := protocol.ParseFragment(state.Fragment)
			if err != nil {
				t.Fatal(err)
			}
			keys, err = protocol.DeriveRoomKeys(link, room)
			if err != nil {
				t.Fatal(err)
			}
			doc := crdt.New()
			defer doc.Destroy()
			if err := crdt.ApplyUpdateV1(doc, state.State, nil); err != nil {
				t.Fatal(err)
			}
			text := doc.GetText("content")
			offset := len(text.ToString())
			doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, offset, " guest", nil) })
			snapshot, err = protocol.SealKeptText(keys, crdt.EncodeStateAsUpdateV1(doc, nil))
			if err != nil {
				t.Fatal(err)
			}
		case r.Method == http.MethodGet:
			json.NewEncoder(w).Encode(map[string]any{"snapshot": snapshot, "entries": []any{}, "tail": 0})
			return
		case strings.HasSuffix(r.URL.Path, "/checkpoint"):
			checkpoints++
			if checkpoints == 1 {
				w.WriteHeader(503)
				return
			}
		}
		json.NewEncoder(w).Encode(map[string]int64{"keepSeconds": 60, "keepUntil": time.Now().Add(time.Minute).UnixMilli()})
	}))
	defer server.Close()
	opts := KeptTextOptions{File: file, Project: dir, Server: server.URL, Keep: 7 * 24 * time.Hour}
	if err := RunKeptText(context.Background(), opts, nil, nil); err == nil {
		t.Fatal("lost checkpoint response reported success")
	}
	data, _ := os.ReadFile(file)
	if string(data) != "base guest" {
		t.Fatal("did not persist before checkpoint request")
	}
	var state keptTextState
	if err := readKeptState(keptTestStatePath(t, dir, room), &state); err != nil {
		t.Fatal(err)
	}
	fullLink = server.URL + "/r/" + room + "?keep=1#" + state.Fragment
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	left := false
	if err := RunKeptText(ctx, KeptTextOptions{Project: dir, Resume: fullLink}, func(link string, seconds, until int64) {
		if link != fullLink || seconds != 60 {
			t.Error("wrong resumed room")
		}
		cancel()
	}, func(until int64) { left = true }); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(file)
	if initCalls != 1 || !left || string(data) != "base guest" {
		t.Fatal("resume reset room or duplicated update")
	}
}
