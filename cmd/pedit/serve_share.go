package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"sync"
	"time"

	"github.com/piconic-ai/pedit/internal/access"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/serve"
	"github.com/piconic-ai/pedit/internal/session"
)

// serveDial connects to the relay; nil is the real thing. Tests replace it.
var serveDial protocol.Dialer

// liveSharer shares the served file in a live room (docs/design/embedding.md
// "Share from `pedit serve`"): the room is one more client of serve's
// document. A kept room is left kept by unshare; a share of the file takes it up
// again when it is one history with serve's document.
type liveSharer struct {
	srv    *serve.Server
	st     *serve.Stdio
	stderr io.Writer

	// mu guards cur, and is held while a share starts or ends, so that a room
	// the relay ended during its start is torn down after it.
	mu  sync.Mutex
	cur *liveShare
}

// liveShare is one room: serve's peer, and the session that holds the room's
// doc. done is set under the sharer's mu once it ended.
type liveShare struct {
	peer    *serve.Peer
	session *session.Session
	bridge  *bridge
	last    []session.Person
	pmu     sync.Mutex
}

func newLiveSharer(srv *serve.Server, st *serve.Stdio, stderr io.Writer) *liveSharer {
	return &liveSharer{srv: srv, st: st, stderr: stderr}
}

var (
	errAlreadyShared = errors.New("already shared; send unshare first")
	errNotShared     = errors.New("not shared")
	errCloseNotYet   = errors.New("close is not available yet")
	errKeptWindows   = errors.New(`kept rooms need Unix file permissions and are not available on Windows; send keep "0" for a live room`)
	errChoiceNotYet  = errors.New("choice is not available yet")
	errOrigins       = errors.New("this file has a kept room with other origins; share with the origins it was opened with")
)

func (l *liveSharer) Share(ctx context.Context, req shareRequest) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	switch {
	case l.cur != nil:
		return errAlreadyShared
	case req.Keep > 0 && runtime.GOOS == "windows":
		return errKeptWindows
	case req.Choice != "":
		return errChoiceNotYet
	}
	// Read-only: serve never creates the project's configuration.
	cfg, err := loadProject(filepath.Dir(l.srv.Path()))
	if err != nil {
		return err
	}
	server := cfg.Server
	if req.Relay != "" {
		server = req.Relay
	}
	resume := ""
	if req.Keep > 0 {
		rec, err := keptRecordOf(cfg.root, l.srv.Path())
		if err != nil {
			return err
		}
		if rec != nil {
			if err := l.checkResume(rec, req); err != nil {
				return err
			}
			resume = rec.Room
		}
	}
	ls := &liveShare{bridge: &bridge{onError: func(err error) { fmt.Fprintln(l.stderr, "pedit:", err) }}}
	ls.peer, err = l.srv.AttachPeer(serve.PeerHandler{
		Update: func(u []byte) {
			ls.bridge.run(func(s *session.Session) error { return s.FromSource(u) })
		},
		Awareness: func(e serve.PeerAwareness) {
			ls.bridge.run(func(s *session.Session) error { return s.FromSourceAwareness(e.ID, e.Reader, e.Update) })
		},
	})
	if err != nil {
		return err
	}
	cloudflared := &access.Cloudflared{OnSignIn: func(url string) {
		fmt.Fprintf(l.stderr, "pedit: %s is behind Cloudflare Access; sign in at %s\n", hostOf(server), url)
	}}
	kept := make(chan int64, 1)
	signIn := func(ctx context.Context, app string) (string, error) {
		return withSignInLimit(ctx, signInLimit, app, cloudflared.Token)
	}
	s, err := start(ctx, signIn, session.Options{
		File:    l.srv.Path(),
		Project: cfg.root,
		Server:  server,
		// Not the host's name as `pedit <file>` has it from --name: a fixed
		// one from the account, with no avatar unless Access gives one.
		Name:    nameOf(commandArgs{}),
		Origins: req.Origins,
		// A resumed room goes on with the keep it was opened with.
		Keep:   req.Keep,
		Resume: resume,
		// Names the document the record belongs to.
		Generation:   l.srv.Generation(),
		BeforeRecord: l.flush,
		Source:       peerSource{ls.peer},
		Dial:         serveDial,
		OnError:      func(err error) { fmt.Fprintln(l.stderr, "pedit:", err) },
		OnStatus: func(st protocol.Status) {
			if st.Final() {
				go l.ended(ls, st)
			}
		},
		OnKeep: func(seconds int64) {
			select {
			case kept <- seconds:
			default:
			}
		},
		OnPeers:         func(p []session.Person) { l.peers(ls, p) },
		OnRoomAwareness: func(_ uint64, _ protocol.Access, u []byte) { _ = ls.peer.ApplyAwareness(u) },
	})
	if err != nil {
		ls.peer.Close()
		return err
	}
	ls.session = s
	l.cur = ls
	// What reached the peer while the session started goes in now, in order.
	ls.bridge.ready(s, ls.peer.AwarenessState())

	room, edit, comment, read := s.Fragments()
	links := map[string]string{"edit": room + "." + edit, "read": room + "." + read}
	if comment != "" {
		links["comment"] = room + "." + comment
	}
	l.st.Event("shared", map[string]any{"room": room, "links": links, "keptUntil": keptUntil(ctx, s, req, kept), "resumed": resume != ""})
	return nil
}

// keepWait is how long a share waits for the relay's word on the keep. A relay
// that keeps nothing says so on connecting too.
var keepWait = 5 * time.Second

// keptUntil is when the relay ends the room once the host leaves, in Unix ms
// as far as the session knows, or 0 when the relay keeps nothing.
func keptUntil(ctx context.Context, s *session.Session, req shareRequest, kept <-chan int64) int64 {
	if req.Keep <= 0 {
		return 0
	}
	select {
	case seconds := <-kept:
		if seconds > 0 {
			return s.KeptUntil().UnixMilli()
		}
	case <-ctx.Done():
	case <-time.After(keepWait):
	}
	return 0
}

// keptRecordOf is the record of the live kept room that holds file, if any.
func keptRecordOf(project, file string) (*session.KeptTextRecord, error) {
	file, err := filepath.Abs(file)
	if err != nil {
		return nil, err
	}
	records, err := session.ListKeptText(project)
	if err != nil {
		return nil, err
	}
	for _, r := range records {
		// An unknown deadline (0) may still be a live room.
		if r.Until != 0 && r.Until <= time.Now().UnixMilli() {
			continue
		}
		if slices.ContainsFunc(r.Files, func(f string) bool { return sameFile(f, file) }) {
			return &r, nil
		}
	}
	return nil, nil
}

// sameFile tells whether two paths are one file: serve's path has its links
// resolved, and a record of pedit <file> may not.
func sameFile(a, b string) bool {
	if a == b {
		return true
	}
	ia, err1 := os.Stat(a)
	ib, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(ia, ib)
}

// checkResume refuses to take up a kept room unless it is one history with
// serve's document, which only the generation proves, and the share asks for
// the origins the room was opened with. Choosing is not available yet.
func (l *liveSharer) checkResume(rec *session.KeptTextRecord, req shareRequest) error {
	if rec.Generation == "" || rec.Generation != l.srv.Generation() {
		return fmt.Errorf("this file has a kept room %s with another history; choosing is not available yet", rec.Room)
	}
	if !sameSet(req.Origins, rec.Origins) {
		return errOrigins
	}
	return nil
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, s := range a {
		if !slices.Contains(b, s) {
			return false
		}
	}
	return true
}

// serveRecordFor is serve's view of the kept room of a file: its generation,
// document and the text it matched. The project is looked up as share does.
func serveRecordFor(file string) (generation string, doc []byte, text string, ok bool) {
	cfg, err := loadProject(filepath.Dir(file))
	if err != nil {
		return "", nil, "", false
	}
	rec, err := keptRecordOf(cfg.root, file)
	if err != nil || rec == nil || rec.Generation == "" || len(rec.State) == 0 {
		return "", nil, "", false
	}
	return rec.Generation, rec.State, rec.Text, true
}

// peers tells the app who is in the room, when that changed.
func (l *liveSharer) peers(ls *liveShare, people []session.Person) {
	ls.pmu.Lock()
	defer ls.pmu.Unlock()
	if reflect.DeepEqual(people, ls.last) {
		return
	}
	ls.last = people
	out := make([]map[string]string, 0, len(people))
	for _, p := range people {
		out = append(out, map[string]string{"name": p.Name, "access": p.Access.String()})
	}
	l.st.Event("peers", map[string]any{"peers": out})
}

// ended is the relay ending the room: it is told, then torn down without
// writing the file, which serve owns.
func (l *liveSharer) ended(ls *liveShare, st protocol.Status) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cur != ls {
		return
	}
	reason := "closed"
	switch st {
	case protocol.StatusExpired:
		reason = "expired"
	case protocol.StatusMaintenance:
		reason = "maintenance"
	}
	l.st.Event("room_ended", map[string]any{"reason": reason})
	l.leave()
}

func (l *liveSharer) Unshare() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cur == nil {
		return errNotShared
	}
	l.leave()
	return nil
}

// Close ends a kept room, which comes with resuming one.
func (l *liveSharer) Close(context.Context) error { return errCloseNotYet }

// leave stops the session, so a live room ends and nothing more is sent, and a
// kept room stays kept with its record, then detaches the peer. The bridge
// stops feeding the session first, so the last snapshot holds every update
// that was handed over. The caller holds mu.
func (l *liveSharer) leave() {
	ls := l.cur
	l.cur = nil
	ls.bridge.close()
	// Serve saves the file before the last record is written.
	l.flush()
	if err := ls.session.Stop(); err != nil {
		fmt.Fprintln(l.stderr, "pedit:", err)
	}
	ls.peer.Close()
}

// flush has serve save the file now, so a kept room's record starts from a
// state the file matches.
func (l *liveSharer) flush() {
	if err := l.srv.Flush(); err != nil {
		fmt.Fprintln(l.stderr, "pedit:", err)
	}
}

// peerSource is serve's peer as the room's source.
type peerSource struct{ p *serve.Peer }

func (s peerSource) State() []byte        { return s.p.State() }
func (s peerSource) Apply(u []byte) error { return s.p.Apply(u) }

// bridge holds what serve's peer hands over until the session exists, then
// passes it on in order. It never calls the peer, so a session callback that
// calls the peer cannot wait on it.
type bridge struct {
	mu      sync.Mutex
	s       *session.Session
	pending []func(*session.Session) error
	closed  bool
	onError func(error)
}

func (b *bridge) run(f func(*session.Session) error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch {
	case b.closed:
	case b.s == nil:
		b.pending = append(b.pending, f)
	default:
		b.report(f(b.s))
	}
}

// ready starts the passing on: the awareness states that were there when the
// peer attached, then what came after.
func (b *bridge) ready(s *session.Session, initial []serve.PeerAwareness) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.s = s
	for _, e := range initial {
		b.report(s.FromSourceAwareness(e.ID, e.Reader, e.Update))
	}
	for _, f := range b.pending {
		b.report(f(s))
	}
	b.pending = nil
}

func (b *bridge) close() {
	b.mu.Lock()
	b.closed, b.pending = true, nil
	b.mu.Unlock()
}

func (b *bridge) report(err error) {
	if err != nil && b.onError != nil {
		b.onError(err)
	}
}
